/**
 * Review-data confidence.
 *
 * ## Three different confidences, kept apart
 *
 * | question | where it lives |
 * | --- | --- |
 * | "is this the same course?" | `MatchResult.confidence` (matching confidence) |
 * | "is there enough evidence, and does it agree?" | {@link calculateReviewConfidence} |
 * | "should this rank highly anyway?" | the decision score in `core/recommendation` |
 *
 * Collapsing them is a real bug, not a simplification: a confident name match
 * would otherwise imply a well-evidenced course, and a thinly-evidenced course
 * would look like a *bad* course instead of an uncertain one.
 *
 * ## What is measured
 *
 * `matching`, `evidence`, `teacherAgreement`, `aspectCoverage`, and `dataHygiene`.
 * There is deliberately **no recency component**: whucourses.cn exposes no review
 * date at all, so a recency term would be a constant masquerading as information.
 * Any component that cannot be computed is dropped and the remaining weights are
 * renormalized, never scored as zero.
 *
 * The teacher-fallback and alias penalties are multiplicative rather than additive
 * because they are not "less evidence" — they are "this answer is about a
 * different population than the one asked about".
 *
 * @module @course-copilot/core/confidence
 */

import {
  CONFIDENCE_ALIAS_PENALTY,
  CONFIDENCE_FALLBACK_PENALTY,
  CONFIDENCE_HIGH,
  CONFIDENCE_MEDIUM,
  CONFIDENCE_WEIGHTS,
  EVIDENCE_GATE_SATURATION,
  REVIEW_COUNT_SATURATION,
} from './config.js';
import { teacherSetRelation } from './normalize.js';
import { isAliasMethod } from './types/course.js';
import type { ConfidenceTier, MatchResult, ReviewConfidence } from './types/course.js';

/**
 * Map a review count onto `0..1` with a saturating curve.
 *
 * `1 - exp(-count / REVIEW_COUNT_SATURATION)`: 2 reviews -> 0.10,
 * 20 -> 0.63, 60 -> 0.95.
 *
 * @param reviewCount - number of aggregated review rows.
 * @returns a value in `[0, 1)`.
 */
export function reviewCountScore(reviewCount: number): number {
  if (!Number.isFinite(reviewCount) || reviewCount <= 0) return 0;
  return 1 - Math.exp(-reviewCount / REVIEW_COUNT_SATURATION);
}

/** Clamp into `0..1`, treating non-finite input as `0`. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Round with a fixed precision. */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * How much of the teacher column was unusable prose.
 *
 * A corpus where 34 of 254 teacher cells are sentences is still usable, but the
 * teacher-level attribution is weaker, and that is a real, measurable caveat.
 *
 * @param matched - rows with a valid teacher.
 * @param malformed - rows whose teacher cell was not a name.
 * @param missing - rows with no teacher cell at all.
 * @returns a ratio in `0..1`, or `undefined` when there is no denominator.
 */
export function malformedTeacherRatio(
  matched: number,
  malformed: number,
  missing: number,
): number | undefined {
  const total = matched + malformed + missing;
  if (total <= 0) return undefined;
  return (malformed + missing) / total;
}

/**
 * How much of a COURSE's teacher column was unusable, over the course's own rows.
 *
 * ## Why this is separate from {@link malformedTeacherRatio}
 *
 * That helper takes a `matched` term, and the count a caller can supply for it is not always in the same unit as the other
 * two. A course's `validTeacherReviewCount` is a **teacher-assignment** total — a co-taught cell like `张三、李四` counts once
 * per named teacher — while its malformed/missing counts and its row total are per **review row**. Feeding the assignment
 * figure in as `matched` mixes the units and inflates the denominator, which makes a course's teacher column look cleaner
 * the more co-taught rows it has. The real corpus showed the symptom directly: 6 + 4 + 0 against 9 rows.
 *
 * This helper therefore takes no `matched` argument at all. The row total is the denominator, and `validTeacherReviewCount`
 * is never consulted, so a co-taught row contributes exactly one clean row whatever it names.
 *
 * @param totalRows - every review row the provider returned for the course.
 * @param malformedRows - rows whose teacher cell was not a name.
 * @param missingRows - rows with no teacher cell at all.
 * @returns a ratio in `0..1`, or `undefined` when there is no denominator.
 */
function dirtyTeacherRowRatio(
  totalRows: number,
  malformedRows: number,
  missingRows: number,
): number | undefined {
  if (!Number.isFinite(totalRows) || totalRows <= 0) return undefined;
  return clamp01((malformedRows + missingRows) / totalRows);
}

/**
 * Compute trust in the review data behind one match.
 *
 * @param match - matched course plus its chosen review record.
 * @returns the combined confidence, its tier, its components, and its inputs.
 */
export function calculateReviewConfidence(match: MatchResult): ReviewConfidence {
  const review = match.review;
  const level = match.courseLevel;
  // Defensive: a `MatchResult` assembled by a caller that omitted `course` must not
  // crash the engine. Treating it as "no teacher requested" is the honest reading —
  // we cannot know what was asked for, so teacher agreement is not applicable.
  const requestedTeacher = (match.course?.teacher ?? '').trim();
  const teacherSpecified = requestedTeacher.length > 0;
  const aliasUsed = match.aliasUsed === true || isAliasMethod(match.method);

  // Which aggregate scope is actually backing the score, and how much evidence it
  // has. A teacher-scoped binding with 3 rows and a course-level fallback over 254
  // rows are different claims and must not share a component value.
  const teacherScoped = review?.aggregateScope === 'teacher';
  const teacherFallbackUsed = teacherSpecified && !teacherScoped && review !== undefined;

  const courseReviewCount = review?.courseReviewCount ?? level?.courseReviewCount ?? review?.reviewCount ?? 0;
  const matchedTeacherReviewCount = review?.matchedTeacherReviewCount ?? review?.reviewCount ?? 0;
  /*
   * Evidence volume for the scope that actually answers the question.
   *
   * When the provider partitioned the corpus for this teaching class, the class's own unique row count is the honest
   * measure: the winning bucket holds one teacher's rows (so a co-taught row is counted in several buckets), and the
   * whole-course count includes teachers of other classes. Neither states how much evidence backs THIS class.
   *
   * Deliberately NOT read from `teachingClassLevel` for `dataHygiene`: that aggregate contains only teachers related to the
   * class, so its malformed/missing counts are structurally zero. Switching hygiene to it would look like a fix while
   * changing nothing. Hygiene stays on its existing source, on purpose, until it gets its own change.
   */
  const scoped = match.teachingClassLevel;
  const evidenceReviewCount = scoped !== undefined
    ? scoped.courseReviewCount
    : teacherScoped
      ? matchedTeacherReviewCount
      : (review?.aspects?.coveredReviewCount ?? review?.reviewCount ?? 0);

  const aspectCoverage = aspectCoverageScore(scoped === undefined ? review : scoped);
  /*
   * Data hygiene: how much of the COURSE's teacher column was unparseable.
   *
   * Read from the course roll-up when it is available, because it is the only source whose malformed, missing and total
   * counts are all per review row. The previous expression could not express this: a teacher bucket's own malformed/missing
   * counts are structurally zero (malformed rows go to the teacher-less bucket), so the component was inert and always
   * scored 1; and the level fallback would have used `validTeacherReviewCount`, a teacher-assignment total, against
   * row-level counts.
   *
   * This measures the CORPUS, not the current class: a co-taught cell is one clean row, and a well-formed teacher who does
   * not teach this class is a clean row too. Relevance to the class is `evidence`'s question, not hygiene's.
   */
  const hygiene = level !== undefined && Number.isFinite(level.courseReviewCount) && level.courseReviewCount > 0
    ? dirtyTeacherRowRatio(
      level.courseReviewCount,
      level.malformedTeacherReviewCount,
      level.missingTeacherReviewCount,
    )
    : malformedTeacherRatio(
      review?.matchedTeacherReviewCount ?? 0,
      review?.malformedTeacherReviewCount ?? 0,
      review?.missingTeacherReviewCount ?? 0,
    );
  const teacherAgreementScore = teacherAgreement(match);

  const components = {
    matching: clamp01(match.confidence),
    evidence: reviewCountScore(evidenceReviewCount),
    // Teacher agreement only carries information when a teacher was asked for.
    teacherAgreement: teacherAgreementScore ?? 0,
    aspectCoverage: aspectCoverage ?? 0,
    // No malformed-teacher denominator means the column was clean or absent;
    // treat as fully hygienic rather than penalising unknown.
    dataHygiene: hygiene === undefined ? 1 : 1 - clamp01(hygiene),
  };

  const missing: string[] = [];
  if (review === undefined) missing.push('review', 'evidence', 'aspectCoverage', 'dataHygiene');
  else {
    if (evidenceReviewCount <= 0) missing.push('evidence');
    if (aspectCoverage === undefined) missing.push('aspectCoverage');
    if (hygiene === undefined) missing.push('dataHygiene');
  }
  if (teacherAgreementScore === undefined) missing.push('teacherAgreement');

  const weights: Array<{ key: keyof typeof components; weight: number; usable: boolean }> = [
    { key: 'matching', weight: CONFIDENCE_WEIGHTS.matching, usable: true },
    { key: 'evidence', weight: CONFIDENCE_WEIGHTS.evidence, usable: !missing.includes('evidence') },
    { key: 'teacherAgreement', weight: CONFIDENCE_WEIGHTS.teacherAgreement, usable: !missing.includes('teacherAgreement') },
    { key: 'aspectCoverage', weight: CONFIDENCE_WEIGHTS.aspectCoverage, usable: !missing.includes('aspectCoverage') },
    { key: 'dataHygiene', weight: CONFIDENCE_WEIGHTS.dataHygiene, usable: !missing.includes('dataHygiene') },
  ];

  const usable = weights.filter((entry) => entry.usable);
  const weightSum = usable.reduce((sum, entry) => sum + entry.weight, 0);
  const base = weightSum === 0
    ? 0
    : usable.reduce((sum, entry) => sum + entry.weight * components[entry.key], 0) / weightSum;

  // Multiplicative penalties: these change what the answer is *about*, not merely
  // how much of it we have.
  const penalty = (teacherFallbackUsed ? CONFIDENCE_FALLBACK_PENALTY : 1)
    * (aliasUsed ? CONFIDENCE_ALIAS_PENALTY : 1);

  // Evidence volume is also a *gate*. Without one, one review can reach "medium"
  // because matching and aspect coverage look fine — but those describe the
  // quality of the binding, not how much anybody actually said. `sqrt` rather than
  // a raw ratio, so the gate bites hardest at 1–3 reviews instead of flattening
  // every comparison between well-evidenced courses.
  const gate = Math.min(1, Math.sqrt(evidenceReviewCount / EVIDENCE_GATE_SATURATION));
  const value = clamp01(Math.min(base * penalty * gate, 1));

  const componentsOut = {
    matching: round(components.matching, 4),
    evidence: round(components.evidence, 4),
    teacherAgreement: round(components.teacherAgreement, 4),
    aspectCoverage: round(components.aspectCoverage, 4),
    dataHygiene: round(components.dataHygiene, 4),
  };

  const confidence: ReviewConfidence = {
    value: round(value, 4),
    tier: tierOf(value),
    components: componentsOut,
    missing,
    summary: '',
    inputs: {
      courseMatchConfidence: round(clamp01(match.confidence), 4),
      teacherSpecified,
      teacherMatched: teacherAgreementScore === 1,
      teacherFallbackUsed,
      aliasUsed,
      courseReviewCount,
      matchedTeacherReviewCount,
      evidenceReviewCount,
      percentageGradeSampleCount: review?.gradedSampleCount ?? level?.grades.validSampleCount ?? 0,
      malformedTeacherRatio: round(hygiene ?? 0, 4),
    },
  };

  if (match.method === 'unmatched') {
    return {
      ...confidence,
      value: 0,
      tier: 'low',
      summary: '未匹配到任何评价记录，数据可信度视为 0',
    };
  }
  confidence.summary = summarize(confidence);
  return confidence;
}

/**
 * How much of the six aspects actually had evidence.
 *
 * @param review - the review aggregate under evaluation.
 * @returns `0..1`, or `undefined` when no aspect analysis exists.
 */
/**
 * How many of the analysed aspects carried any evidence, over the ones analysed.
 *
 * Accepts either a review record or a course-level roll-up: both expose `aspects`, and the scoped roll-up is the correct
 * source when deciding how thoroughly THIS teaching class was covered rather than one teacher's bucket.
 *
 * @param review - the record whose aspect analysis to measure.
 * @returns the covered fraction, or `undefined` when there is no analysis to measure.
 */
function aspectCoverageScore(review: MatchResult['review'] | MatchResult['teachingClassLevel']): number | undefined {
  const scores = review?.aspects?.scores;
  if (scores === undefined || scores.length === 0) return undefined;
  const scored = scores.filter((entry) => entry.score !== undefined && entry.evidenceReviewCount > 0);
  return clamp01(scored.length / scores.length);
}

/**
 * Whether the review corpus agrees with the requested teacher.
 *
 * Formatting-only differences (`张三老师`, `张 三`) count as agreement; a genuine
 * different teacher is a hard disagreement, because it means the wrong person's
 * data is in play.
 *
 * @param match - the match under evaluation.
 * @returns `1` on agreement, `0` on disagreement, `undefined` when not applicable.
 */
export function teacherAgreement(match: MatchResult): number | undefined {
  const requested = (match.course?.teacher ?? '').trim();
  if (requested.length === 0) return undefined;
  const review = match.review;
  if (review === undefined) return undefined;
  /*
   * A co-taught row names several teachers; a joint-teaching match is agreement
   * with the course, not a mismatch to punish.
   *
   * The comparison is the SAME set-overlap rule the matcher uses. It used to apply a private `sameTeacher` normalizer, which
   * folded the whole requested cell into one string (`张三、李四` -> `张三李四`) and therefore disagreed with the matcher
   * about who a co-taught class is taught by. Two rules for one question is how the confidence summary ends up contradicting
   * the match that produced it.
   */
  const relation = teacherSetRelation(requested, review.teacherNames ?? review.teacher);
  if (relation === 'unknown') return undefined;
  return relation === 'agree' ? 1 : 0;
}

/** Map a `0..1` value onto its tier. */
export function tierOf(value: number): ConfidenceTier {
  if (value >= CONFIDENCE_HIGH) return 'high';
  if (value >= CONFIDENCE_MEDIUM) return 'medium';
  return 'low';
}

/** Build the human-readable confidence summary. */
function summarize(confidence: ReviewConfidence): string {
  const { components, inputs } = confidence;
  const parts = [
    `总体 ${confidence.value.toFixed(2)}（${confidence.tier}）`,
    `课程共 ${inputs.courseReviewCount} 条样本`,
    `匹配度 ${components.matching.toFixed(2)}`,
    `证据量 ${components.evidence.toFixed(2)}（本次计分用 ${inputs.evidenceReviewCount} 条）`,
  ];
  if (!confidence.missing.includes('aspectCoverage')) {
    parts.push(`维度覆盖 ${components.aspectCoverage.toFixed(2)}`);
  }
  if (!confidence.missing.includes('dataHygiene')) {
    parts.push(`教师字段可用率 ${components.dataHygiene.toFixed(2)}`);
  }
  if (inputs.teacherFallbackUsed) parts.push('已回退到课程级数据（降权 0.6）');
  if (inputs.aliasUsed) parts.push('课程名通过 alias 匹配（降权 0.85）');
  if (confidence.missing.length > 0) parts.push(`缺失分量：${confidence.missing.join('、')}`);
  return parts.join('；');
}
