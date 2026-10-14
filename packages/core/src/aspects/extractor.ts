/**
 * Deterministic aspect extraction from free-text reviews.
 *
 * ## Matching rules, in order of authority
 *
 * 1. **Longest phrase first.** Rules are tried by descending phrase length, so
 *    `作业很多` is claimed before the generic `作业` fallback ever gets a chance.
 *    This is the fix for the old matcher's defining bug, where `作业很多` scored
 *    *better* than `作业多` because `作业` had already consumed the span.
 * 2. **No overlapping double-counting.** Once a span is claimed, it is closed to
 *    every other rule — unless a rule deliberately shares the phrase, which the
 *    lexicon expresses as a *separate row* for the same phrase under a different
 *    aspect (for example `水`: positive for workload, negative for teaching).
 * 3. **Deterministic tie-break.** Equal-length phrases are tried in lexicon
 *    order, so the same text always yields the same mentions.
 *
 * No LLM, no randomness, no locale-dependent collation: same input, same output.
 *
 * @module @course-copilot/core/aspects/extractor
 */

import { ASPECT_LEXICON, EXAM_FORMAT_PATTERNS } from './lexicon.js';
import { applyNegation, detectNegation } from './negation.js';
import { SIGNAL_UNIT, analyzeAspects } from './scoring.js';
import { STRENGTH_WEIGHT, type AspectAnalysis, type AspectKey, type AspectMention, type ExamFormat, type LexiconEntry, type ReviewAspects, type Strength } from './types.js';

/** Rules indexed by their first character, so scanning is not O(rules × text). */
interface IndexedLexicon {
  /** Rules sorted by descending phrase length, then lexicon order. */
  ordered: readonly LexiconEntry[];
  /** First character → the rules starting with it, in `ordered` order. */
  byFirstChar: ReadonlyMap<string, readonly LexiconEntry[]>;
}

/** Build the index once; the lexicon is static. */
function buildIndex(entries: readonly LexiconEntry[]): IndexedLexicon {
  // Length uses code points, so multi-byte characters compare correctly.
  const ordered = [...entries].sort((left, right) => {
    const leftLength = [...left.phrase].length;
    const rightLength = [...right.phrase].length;
    if (leftLength !== rightLength) return rightLength - leftLength;
    // A stable tie-break: aspect then phrase, so equal-length rules never swap.
    if (left.aspect !== right.aspect) return left.aspect < right.aspect ? -1 : 1;
    return left.phrase < right.phrase ? -1 : left.phrase > right.phrase ? 1 : 0;
  });
  const byFirstChar = new Map<string, LexiconEntry[]>();
  for (const entry of ordered) {
    const first = [...entry.phrase][0];
    if (first === undefined) continue;
    const bucket = byFirstChar.get(first) ?? [];
    bucket.push(entry);
    byFirstChar.set(first, bucket);
  }
  return { ordered, byFirstChar };
}

const INDEX = buildIndex(ASPECT_LEXICON);

/** Whether a text offset falls inside an already-claimed span. */
function claimed(spans: readonly { start: number; end: number }[], start: number, end: number): boolean {
  return spans.some((span) => start < span.end && end > span.start);
}

/** Normalize text for matching: width, invisible characters, whitespace. */
export function normalizeReviewText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/gu, '')
    // Lowercase so `PPT`/`ppt` and `Presentation` behave identically.
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, ' ');
}

/**
 * Extract every aspect mention from one piece of text.
 *
 * @param text - the review text (comment, assessment, or attendance field).
 * @returns mentions in text order, with overlaps already resolved.
 */
export function extractMentions(text: string): AspectMention[] {
  const normalized = normalizeReviewText(text);
  if (normalized.length === 0) return [];

  const spans: Array<{ start: number; end: number }> = [];
  const mentions: AspectMention[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const first = normalized[index];
    if (first === undefined) continue;
    const candidates = INDEX.byFirstChar.get(first);
    if (candidates === undefined) continue;

    for (const entry of candidates) {
      const phrase = normalizeReviewText(entry.phrase);
      if (!normalized.startsWith(phrase, index)) continue;
      const end = index + phrase.length;
      // Longest-first ordering means the first accepted match at this position is
      // the most specific one; anything overlapping it is by definition less so.
      if (claimed(spans, index, end)) continue;

      const negation = detectNegation(normalized, entry, index);
      const polarity = applyNegation(entry.polarity, negation.negated);
      const strength: Strength = entry.strength ?? 'normal';
      spans.push({ start: index, end });
      const mention: AspectMention = {
        aspect: entry.aspect,
        polarity,
        strength,
        phrase: entry.phrase,
        surface: normalized.slice(Math.max(0, index - (negation.negator?.length ?? 0)), end),
        index,
        negated: negation.negated,
      };
      if (entry.formatOnly === true) mention.formatOnly = true;
      mentions.push(mention);
      break;
    }
  }

  return mentions.sort((left, right) => left.index - right.index);
}

/** The assessment-format index, built once like the lexicon index. */
const FORMAT_INDEX = (() => {
  const ordered = [...EXAM_FORMAT_PATTERNS].sort((left, right) => {
    const leftLength = [...left.phrase].length;
    const rightLength = [...right.phrase].length;
    if (leftLength !== rightLength) return rightLength - leftLength;
    return left.phrase < right.phrase ? -1 : 1;
  });
  const byFirstChar = new Map<string, typeof ordered>();
  for (const pattern of ordered) {
    const first = [...pattern.phrase][0];
    if (first === undefined) continue;
    const bucket = byFirstChar.get(first) ?? [];
    bucket.push(pattern);
    byFirstChar.set(first, bucket);
  }
  return { ordered, byFirstChar };
})();

/**
 * Detect the stated assessment format, if any.
 *
 * Format is provenance, not a score: `闭卷` says how the exam is run. The
 * longest pattern wins, so `学校统一闭卷考试` is not reported as a bare `闭卷`.
 *
 * @param text - the text to scan.
 * @returns the format, or `undefined` when the text states none.
 */
export function detectExamFormat(text: string): ExamFormat | undefined {
  const normalized = normalizeReviewText(text);
  if (normalized.length === 0) return undefined;
  for (let index = 0; index < normalized.length; index += 1) {
    const first = normalized[index];
    if (first === undefined) continue;
    const candidates = FORMAT_INDEX.byFirstChar.get(first);
    if (candidates === undefined) continue;
    for (const pattern of candidates) {
      if (normalized.startsWith(normalizeReviewText(pattern.phrase), index)) return pattern.format;
    }
  }
  return undefined;
}

/**
 * Extract aspects from one review, keeping the multi-label structure.
 *
 * A sentence may legitimately produce a positive teaching mention and a negative
 * workload mention at once; that is reported as `mixed: true` rather than being
 * averaged into a single verdict. The per-aspect `signals` are this review's
 * bounded contribution — one review, one vote per aspect.
 *
 * @param parts - the review's text fields.
 * @returns per-aspect counts, the mixed flag, the signals, and every mention.
 */
export function extractReviewAspects(parts: readonly (string | undefined)[]): ReviewAspects {
  const mentions: AspectMention[] = [];
  let examFormat: ExamFormat | undefined;
  for (const part of parts) {
    if (part === undefined || part.length === 0) continue;
    mentions.push(...extractMentions(part));
    if (examFormat === undefined) examFormat = detectExamFormat(part);
  }

  const aspects: Partial<Record<AspectKey, { positive: number; negative: number }>> = {};
  const signals: Partial<Record<AspectKey, number>> = {};
  for (const mention of mentions) {
    if (mention.formatOnly === true) continue;
    const bucket = aspects[mention.aspect] ?? { positive: 0, negative: 0 };
    if (mention.polarity === 'positive') bucket.positive += 1;
    else bucket.negative += 1;
    aspects[mention.aspect] = bucket;
    const weight = STRENGTH_WEIGHT[mention.strength] / SIGNAL_UNIT;
    const signed = mention.polarity === 'positive' ? weight : -weight;
    // Keep the strongest mention per aspect: one review, one vote. Repetition
    // raises the mention count for provenance but never the vote's weight.
    const current = signals[mention.aspect];
    if (current === undefined || Math.abs(signed) > Math.abs(current)) signals[mention.aspect] = signed;
  }
  for (const key of Object.keys(signals) as AspectKey[]) {
    // The signal is already one mention's weight; guarantee it stays in `-1..1`
    // so the mapping's documented input range holds.
    const value = signals[key] ?? 0;
    signals[key] = Math.max(-1, Math.min(1, value));
  }

  // "Mixed" is about the review as a whole: praise for teaching alongside a
  // complaint about workload is exactly the kind of review that must not be
  // reported as simply positive or simply negative.
  const scored = mentions.filter((mention) => mention.formatOnly !== true);
  const positive = scored.filter((mention) => mention.polarity === 'positive').length;
  const negative = scored.length - positive;
  const review: ReviewAspects = { aspects, mixed: positive > 0 && negative > 0, mentions, signals };
  if (examFormat !== undefined) review.examFormat = examFormat;
  return review;
}

/**
 * Analyse every aspect of a set of cleaned reviews.
 *
 * The text fields are read together per review (assessment, attendance/homework,
 * then the comment), so a review that mentions attendance in one column and
 * marking in another still counts as one review with several aspects.
 *
 * @param rows - cleaned reviews for one aggregate scope.
 * @returns the aspect analysis over those reviews.
 */
export function analyzeReviewRows(rows: readonly { examMethodText?: string; attendanceWorkloadText?: string; commentText?: string }[]): AspectAnalysis {
  return analyzeReviewRowsDetailed(rows).analysis;
}

/**
 * Analyse aspects **and** hand back every mention.
 *
 * The grade dimension needs both halves at once: the analysis for the other five
 * aspects, and the raw `gradeFriendliness` mentions to combine with the published
 * grade distribution. Re-extracting them separately would be wasteful and, worse,
 * two sources of truth.
 *
 * @param rows - cleaned reviews for one aggregate scope.
 * @returns the analysis plus the flattened mentions.
 */
export function analyzeReviewRowsDetailed(
  rows: readonly { examMethodText?: string; attendanceWorkloadText?: string; commentText?: string }[],
): { analysis: AspectAnalysis; mentions: AspectMention[]; reviews: ReviewAspects[] } {
  const reviews = rows.map((row) => extractReviewAspects([
    row.examMethodText,
    row.attendanceWorkloadText,
    row.commentText,
  ]));
  return { analysis: analyzeAspects(reviews), mentions: reviews.flatMap((review) => review.mentions), reviews };
}

/** The indexed lexicon, exposed for tests that assert the ordering contract. */
export const LEXICON_INDEX: IndexedLexicon = INDEX;
