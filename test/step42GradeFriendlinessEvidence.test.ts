/**
 * PART 16J-PREUI-C3 — grade-friendliness evidence reliability.
 *
 * ## The bug these lock
 *
 * The grade *outcome* signal already reached the combined raw score, but the aspect's `evidenceReviewCount` stayed at the TEXT count. A
 * course whose evidence came from published grades while the prose never mentioned marking therefore reported zero evidence, and
 * `aspectReliability` returns 0 for no evidence — so `decisionScore` shrank the combined score all the way back to neutral 5.5. The
 * outcome was computed and then thrown away: 96 and 40 ranked identically.
 *
 * ## The three counts, which must stay distinct
 *
 * - text  — reviews carrying text evidence for the aspect
 * - grade — reviews carrying a usable percentage grade (read by the outcome signal from `validSampleCount`)
 * - union — reviews carrying either; this is the honest evidence count and what the aspect must report
 *
 * `text + grade` is NOT the union: a review can do both. These tests pin the union against a sum, a max and a min.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { combineGradeSignals, gradeTextSignal } from '@course-copilot/core/aspects/gradeSignal';
import { analyzeReviewRowsDetailed, extractMentions } from '@course-copilot/core/aspects/extractor';
import { buildAspectBreakdown, aspectReliability } from '@course-copilot/core/recommendation';
import { REVIEW_COUNT_SATURATION } from '@course-copilot/core/config';
import { recommendCourses } from '@course-copilot/recommendation';
import {
  aggregateCleanRows, aggregateCourse, cleanRow, normalizeRow, WHUCOURSES_FIELDS, gradeStatistics,
} from '@course-copilot/provider/whucourses';
import { WHU_GRADE_CALIBRATION } from '@course-copilot/provider/whu';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = '\u9ad8\u7b49\u6570\u5b66';
const A = '\u5f20\u8001\u5e08';

/** Text that carries grade-friendliness evidence, and text that says nothing about marking. */
const GRADE_WORDS = '\u7ed9\u5206\u5f88\u9ad8\uff0c\u4e0d\u538b\u5206';
const PLAIN = '\u8001\u5e08\u8bb2\u5f97\u5f88\u597d\uff0c\u5185\u5bb9\u6709\u8da3';

function rawRow(grade: string, content: string, courseName = NAME): unknown {
  return normalizeRow({
    [WHUCOURSES_FIELDS.courseName]: courseName,
    [WHUCOURSES_FIELDS.teacher]: A,
    [WHUCOURSES_FIELDS.grade]: grade,
    [WHUCOURSES_FIELDS.content]: content,
    [WHUCOURSES_FIELDS.attendance]: '',
    [WHUCOURSES_FIELDS.assessment]: '',
  });
}

/**
 * The grade-friendliness aspect as the provider publishes it.
 *
 * Built through the provider's own canonical aggregate (`aggregateCleanRows`) rather than through `searchCourse`: the transport path needs a
 * faithful HTTP stub, and a stub bug shows up as "no reviews for this course", which is easy to misread as a product finding. This uses the
 * same `cleanRow` → `buildTeacherReview` code the transport path uses, so the union rule under test is the shipped one.
 */
function publishedAspect(entries: Array<{ grade: string; content: string; courseName?: string }>): Record<string, unknown> {
  return aspectOf(publishedReview(entries));
}

/** The whole published aggregate record, for tests that need the reliability/decision breakdown. */
function publishedReview(entries: Array<{ grade: string; content: string; courseName?: string }>): Record<string, unknown> {
  const clean = entries.map((entry) => cleanRow(rawRow(entry.grade, entry.content, entry.courseName ?? NAME) as never));
  const review = aggregateCleanRows(clean)[0] as never as Record<string, unknown> | undefined;
  if (review === undefined) throw new Error('aggregate produced no review record');
  return review;
}

/** A corpus as already-cleaned rows, for tests that drive the provider's own aggregate directly. */
function cleanedCorpus(entries: Array<{ grade: string; content: string; courseName: string }>): ReturnType<typeof cleanRow>[] {
  return entries.map((entry) => cleanRow(rawRow(entry.grade, entry.content, entry.courseName) as never));
}

/**
 * A review provider backed by a fixed corpus, with a REAL `searchCourse`-shaped response.
 *
 * `defaultLookup` and the engine are then exercised unchanged; only the transport is faked. This keeps the ranking test honest about the
 * path it proves, instead of asserting on an aggregate it built by hand.
 */
function corpusProvider(corpus: ReturnType<typeof cleanRow>[]): { searchCourse: (query: { courseName: string; teacher?: string }) => Promise<Record<string, unknown>> } {
  const byName = new Map<string, ReturnType<typeof cleanRow>[]>();
  for (const row of corpus) {
    const list = byName.get(row.courseName) ?? [];
    list.push(row);
    byName.set(row.courseName, list);
  }
  return {
    searchCourse: async (query) => {
      const rows = byName.get(query.courseName) ?? [];
      const reviews = aggregateCleanRows(rows, { teacherScoped: query.teacher !== undefined });
      return { reviews, provider: 'stub', fromCache: false, warnings: [] };
    },
  };
}

/** The grade-friendliness aspect as the provider published it. */
function aspectOf(review: Record<string, unknown>): Record<string, unknown> {
  const scores = (review.aspects as { scores: Array<Record<string, unknown>> }).scores;
  const entry = scores.find((candidate) => candidate.aspect === 'gradeFriendliness');
  if (entry === undefined) throw new Error('no gradeFriendliness aspect');
  return entry;
}

/** The text/union counts as the provider's own helper sees them, recomputed here from the same row facts. */
function countsFor(entries: Array<{ grade: string; content: string }>): { text: number; grade: number; union: number } {
  const clean = entries.map((entry) => cleanRow(rawRow(entry.grade, entry.content) as never));
  const { analysis, reviews } = analyzeReviewRowsDetailed(clean);
  const text = analysis.scores.find((score) => score.aspect === 'gradeFriendliness')?.evidenceReviewCount ?? 0;
  const grade = gradeStatistics(clean).validSampleCount;
  let union = 0;
  for (let index = 0; index < clean.length; index += 1) {
    const row = clean[index];
    const hasGrade = row?.gradeValidity === 'usable' && row.reportedGrade !== undefined;
    const hasText = (reviews[index]?.mentions ?? []).some((mention) => mention.aspect === 'gradeFriendliness' && mention.formatOnly !== true);
    if (hasText || hasGrade) union += 1;
  }
  return { text, grade, union };
}

describe('16J-PREUI-C3 the union is neither a sum nor a max nor a min', () => {
  it('A. partial overlap: text 2, grade 2, union 3', async () => {
    const entries = [
      { grade: '95', content: GRADE_WORDS },      // both
      { grade: '90', content: PLAIN },            // grade only
      { grade: '\u672a\u77e5', content: GRADE_WORDS }, // text only
    ];
    const counts = countsFor(entries);
    expect(counts.text).toBe(2);
    expect(counts.grade).toBe(2);
    expect(counts.union).toBe(3);

    expect(publishedAspect(entries).evidenceReviewCount).toBe(3);
  });

  it('B. full overlap: union is 2, never the sum 4', async () => {
    const entries = [
      { grade: '95', content: GRADE_WORDS },
      { grade: '90', content: GRADE_WORDS },
    ];
    const counts = countsFor(entries);
    expect(counts.text).toBe(2);
    expect(counts.grade).toBe(2);
    expect(counts.union).toBe(2);

    const aspect = publishedAspect(entries);
    expect(aspect.evidenceReviewCount).toBe(2);
    expect(aspect.evidenceReviewCount).not.toBe(4);
  });

  it('C. disjoint: union is 4, never the max 2', async () => {
    const entries = [
      { grade: '\u672a\u77e5', content: GRADE_WORDS },
      { grade: '\u672a\u77e5', content: GRADE_WORDS },
      { grade: '95', content: PLAIN },
      { grade: '90', content: PLAIN },
    ];
    const counts = countsFor(entries);
    expect(counts.text).toBe(2);
    expect(counts.grade).toBe(2);
    expect(counts.union).toBe(4);

    expect(publishedAspect(entries).evidenceReviewCount).toBe(4);
  });
});

describe('16J-PREUI-C3 outcome-only evidence now reaches reliability and decision', () => {
  it('D. high outcome-only: raw > 5.5, evidence 3, reliability > 0, decision > 5.5', async () => {
    const entries = ['95', '96', '97'].map((grade) => ({ grade, content: PLAIN }));
    expect(publishedAspect(entries).evidenceReviewCount).toBe(3);
    const breakdown = buildAspectBreakdown(publishedReview(entries) as never, { gradeFriendliness: 1 } as never);
    const decided = breakdown.aspects.find((entry) => entry.aspect === 'gradeFriendliness');
    expect(decided?.raw).toBeGreaterThan(5.5);
    expect(decided?.reliability).toBeGreaterThan(0);
    expect(decided?.decision).toBeGreaterThan(5.5);
  });

  it('E. low outcome-only: raw < 5.5, evidence 3, reliability > 0, decision < 5.5', async () => {
    const entries = ['30', '40', '50'].map((grade) => ({ grade, content: PLAIN }));
    expect(publishedAspect(entries).evidenceReviewCount).toBe(3);
    const breakdown = buildAspectBreakdown(publishedReview(entries) as never, { gradeFriendliness: 1 } as never);
    const decided = breakdown.aspects.find((entry) => entry.aspect === 'gradeFriendliness');
    expect(decided?.raw).toBeLessThan(5.5);
    expect(decided?.reliability).toBeGreaterThan(0);
    expect(decided?.decision).toBeLessThan(5.5);
  });

  it('F. the high-outcome course now OUTRANKS the low-outcome one', async () => {
    /*
     * Only the grades differ, and gradeFriendliness is the sole weighted aspect, so the order cannot come from a tie-break on the name:
     * 高等数学 (high) must beat 大学物理 (low).
     */
    const corpus = cleanedCorpus([
      ...['95', '96', '97'].map((grade) => ({ grade, content: PLAIN, courseName: NAME })),
      ...['30', '40', '50'].map((grade) => ({ grade, content: PLAIN, courseName: '\u5927\u5b66\u7269\u7406' })),
    ]);
    const provider = corpusProvider(corpus);
    const result = await recommendCourses(
      [
        { source: 'whu', courseName: NAME, normalizedName: NAME, availability: 'unknown', teacher: A } as never,
        { source: 'whu', courseName: '\u5927\u5b66\u7269\u7406', normalizedName: '\u5927\u5b66\u7269\u7406', availability: 'unknown', teacher: A } as never,
      ],
      {},
      {
        providers: [provider as never],
        policy: {
          defaultPreferences: { gradeFriendliness: 1, workloadFriendliness: 0, attendanceFriendliness: 0, overallScore: 0 },
          defaultTopN: 5, maxTopN: 50, candidateLimit: 25,
        } as never,
      },
    );
    expect(result.recommendations.length).toBe(2);
    expect(result.recommendations[0]?.course.courseName).toBe(NAME);
    // And the decision really did move off neutral, which is what the bug prevented.
    const decision = result.recommendations[0]?.aspects.aspects.find((entry) => entry.aspect === 'gradeFriendliness')?.decision;
    expect(decision).toBeGreaterThan(5.5);
    const lowDecision = result.recommendations[1]?.aspects.aspects.find((entry) => entry.aspect === 'gradeFriendliness')?.decision;
    expect(lowDecision).toBeLessThan(5.5);
  });
});

describe('16J-PREUI-C3 the fallbacks are preserved', () => {
  it('G. missing grades keep the text-only fallback: no zero, no NaN, no null', async () => {
    for (const cell of ['\u672a\u77e5', '', '-']) {
      const entries = ['95', '96'].map(() => ({ grade: cell, content: GRADE_WORDS }));
      const aspect = publishedAspect(entries);
      const breakdown = buildAspectBreakdown(publishedReview(entries) as never, { gradeFriendliness: 1 } as never);
      const decided = breakdown.aspects.find((entry) => entry.aspect === 'gradeFriendliness');
      // Text evidence exists, so the aspect is scored and the union equals the text count.
      expect(aspect.evidenceReviewCount, cell).toBe(2);
      expect(decided?.raw, cell).toBeDefined();
      expect(Number.isFinite(decided?.decision as number), cell).toBe(true);
      expect(decided?.decision, cell).not.toBeNull();
      expect(signalOutcomeIsAbsent(cell)).toBe(true);
    }
  });

  it('H. ambiguous/GPA cells are not percentage outcome evidence', async () => {
    for (const cell of ['4.0', '4', '9']) {
      const entries = ['95', '96'].map(() => ({ grade: cell, content: PLAIN }));
      const aspect = publishedAspect(entries);
      // No text mentions and no usable grade: the dimension has no evidence at all, so it must not claim 2.
      expect(aspect.evidenceReviewCount, cell).toBe(0);
      const breakdown = buildAspectBreakdown(publishedReview(entries) as never, { gradeFriendliness: 1 } as never);
      const decided = breakdown.aspects.find((entry) => entry.aspect === 'gradeFriendliness');
      expect(decided?.raw, cell).toBeUndefined();
    }
  });

  it('I. the text signal still describes only the TEXT reviews, never the union', () => {
    // One text review and two grade-only reviews: the union is 3 but the text part must still say 1.
    const mentions = extractMentions(GRADE_WORDS);
    const textPart = gradeTextSignal(mentions, 1);
    expect(textPart.note).toContain('1 \u6761');
    expect(textPart.note).not.toContain('3 \u6761');

    const signal = combineGradeSignals(
      { validSampleCount: 2, ambiguousSampleCount: 0, invalidSampleCount: 0, percentageDistribution: {}, belowPassSampleCount: 0, distribution: {} } as never,
      mentions,
      { text: 1, union: 3 },
      WHU_GRADE_CALIBRATION,
    );
    expect(signal.evidenceCounts).toEqual({ text: 1, union: 3 });
    expect(signal.text.note).toContain('1 \u6761');
  });
});

/** Whether a grade cell yields no usable percentage outcome, checked through the canonical parser. */
function signalOutcomeIsAbsent(cell: string): boolean {
  const clean = [cleanRow(rawRow(cell, GRADE_WORDS) as never)];
  return gradeStatistics(clean).validSampleCount === 0;
}

describe('16J-PREUI-C3 both provider paths share one union helper', () => {
  it('J. teacher path and course roll-up agree on the union rule for the same rows', async () => {
    /*
     * The two provider paths, driven by their own canonical entry points: `aggregateCleanRows` builds the teacher bucket the engine ranks,
     * and `aggregateCourse` builds the course-level roll-up through `summarizeCleanRows`. Only the UNION RULE is compared — the two
     * legitimately differ in scope, so their other statistics are deliberately not asserted.
     */
    const entries = [
      { grade: '95', content: GRADE_WORDS },           // both
      { grade: '90', content: PLAIN },                 // grade only
      { grade: '\u672a\u77e5', content: GRADE_WORDS }, // text only
    ];
    const clean = entries.map((entry) => cleanRow(rawRow(entry.grade, entry.content) as never));
    const bucketAspect = aspectOf(aggregateCleanRows(clean)[0] as never as Record<string, unknown>);
    const rollUp = aggregateCourse(entries.map((entry) => rawRow(entry.grade, entry.content)) as never, NAME) as never as Record<string, unknown> | undefined;
    expect(bucketAspect.evidenceReviewCount).toBe(3);
    expect(rollUp).toBeDefined();
    expect(aspectOf(rollUp as Record<string, unknown>).evidenceReviewCount).toBe(3);
  });

  it('K. the source calls the shared helper from both paths, and never adds the two counts', () => {
    const source = readFileSync(join(repoRoot, 'packages', 'provider', 'src', 'whucourses.ts'), 'utf8');
    // One helper, defined once and called from both aggregates.
    const calls = [...source.matchAll(/countGradeFriendlinessEvidence\(/gu)].length;
    expect(calls).toBe(3); // 1 definition + 2 call sites
    expect(/function countGradeFriendlinessEvidence\(/u.test(source)).toBe(true);
    // The two counts are never combined arithmetically into an evidence count.
    expect(source.includes('evidenceReviewCount +')).toBe(false);
    expect(source.includes('validSampleCount + text')).toBe(false);
    expect(source.includes('Math.max(text')).toBe(false);
    // And the union is read from per-row extractions, not from a flattened mention list.
    expect(source.includes('const { analysis, mentions, reviews } = analyzeReviewRowsDetailed(rows);')).toBe(true);
  });
});

describe('16J-PREUI-C3 what must NOT have changed', () => {
  it('L. the combined raw score is still the 0.5/0.5 blend it always was', () => {
    const grades = {
      validSampleCount: 3, ambiguousSampleCount: 0, invalidSampleCount: 0,
      percentageDistribution: {}, belowPassSampleCount: 0, distribution: {},
      percentageAverage: 96, percentageMedian: 96,
    } as never;
    const mentions = extractMentions(GRADE_WORDS);
    /*
     * Deliberately NOT asserting that the score ignores the text count: today it does, but that is an implementation detail and a future
     * text-signal shrinkage would legitimately change it. What is frozen is that the two counts are separate and that the union never
     * reaches the text signal as if it were text evidence.
     */
    const withTextCount = combineGradeSignals(grades, mentions, { text: 1, union: 1 }, WHU_GRADE_CALIBRATION);
    const withBiggerUnion = combineGradeSignals(grades, mentions, { text: 1, union: 9 }, WHU_GRADE_CALIBRATION);
    expect(withTextCount.text.score).toBe(withBiggerUnion.text.score);
    expect(withTextCount.score).toBe(withBiggerUnion.score);
    expect(withBiggerUnion.evidenceCounts.union).toBe(9);
  });

  it('N. the combined RAW is unchanged; only reliability moved the decision', async () => {
    /*
     * The fix must not have touched the blend. The raw values here are the ones the pre-fix code produced for these same inputs, so the
     * movement in `decision` can only have come from the evidence count reaching `aspectReliability`.
     */
    for (const [cells, expectedRaw, comparison] of [
      [['95', '96', '97'], 7.1875, 'gt'],
      [['30', '40', '50'], 3.625, 'lt'],
    ] as const) {
      const entries = cells.map((grade) => ({ grade, content: PLAIN }));
      const aspect = publishedAspect(entries);
      const breakdown = buildAspectBreakdown(publishedReview(entries) as never, { gradeFriendliness: 1 } as never);
      const decided = breakdown.aspects.find((entry) => entry.aspect === 'gradeFriendliness');
      expect(decided?.raw).toBe(expectedRaw);
      // Reliability is no longer 0, and the decision is the shrinkage formula applied to that same raw.
      const reliability = aspectReliability(aspect as never);
      expect(reliability).toBeGreaterThan(0);
      expect(decided?.decision).toBeCloseTo(5.5 + reliability * (expectedRaw - 5.5), 4);
      if (comparison === 'gt') expect(decided?.decision as number).toBeGreaterThan(5.5);
      else expect(decided?.decision as number).toBeLessThan(5.5);
    }
  });

  it('M. polarity counts stay text-only: an outcome-only course gets no positive reviews', async () => {
    const aspect = publishedAspect(['95', '96', '97'].map((grade) => ({ grade, content: PLAIN })));
    // Evidence is 3 (through grades), but no review expressed a text opinion, so every polarity count stays 0.
    expect(aspect.evidenceReviewCount).toBe(3);
    expect(aspect.positiveReviewCount).toBe(0);
    expect(aspect.negativeReviewCount).toBe(0);
    expect(aspect.mixedReviewCount).toBe(0);
    // Which means reliability uses the neutral agreement value, not an invented one.
    const reliability = aspectReliability(aspect as never);
    const volume = 1 - Math.exp(-3 / REVIEW_COUNT_SATURATION);
    expect(reliability).toBeCloseTo(0.6 * volume + 0.4 * 0.5, 4);
  });
});
