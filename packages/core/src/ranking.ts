/**
 * Deterministic course scoring.
 *
 * Invariants this module guarantees:
 * - Same reviews + same preferences => same score. No clock, no randomness, no
 *   `Math.random`, no locale-dependent comparison.
 * - A missing metric is never treated as `0`. Its weight is redistributed across
 *   the metrics that ARE present, so a course is not punished for absent data.
 * - Availability never enters the score. Seat counts are an eligibility concern.
 * - **No host policy.** Default weights arrive as an argument and the result cap
 *   is the caller's; this module decides neither. See
 *   `docs/ranking-boundary-audit.md`.
 *
 * @module @course-copilot/core/ranking
 */

// Only `METRIC_KEYS` is imported: it enumerates the metrics this algorithm scores, so it is part of
// the algorithm. The two host *policy* values that used to be imported here are now caller inputs —
// `DEFAULT_PREFERENCES` is passed to `normalizePreferences` as its base, and the result cap is the
// caller's business (see `docs/ranking-boundary-audit.md`).
import { METRIC_KEYS } from './config.js';
import type {
  CourseReview,
  CourseScore,
  MatchResult,
  RankingPreferences,
  ReviewMetricKey,
  ScoreComponent,
} from './types/course.js';
import { calculateReviewConfidence } from './confidence.js';
import {
  aspectWeightsFromPreferences,
  buildAspectBreakdown,
  LEGACY_METRIC_TO_ASPECT,
  type AspectBreakdown,
} from './recommendation.js';

/** Round to a fixed number of decimals without floating-point drift leaking out. */
function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Validate and normalize user-supplied weights against a caller-supplied base.
 *
 * Negative weights are clamped to `0`. A payload whose weights are all zero (or
 * that omits every weight) falls back to `basePreferences` rather than
 * producing a uniform zero score.
 *
 * `basePreferences` is **required** and carries no default: what "default
 * weights" means is host policy, so the caller decides it. The plugin passes
 * `DEFAULT_PREFERENCES` from its own config; a different host is free to pass
 * something else without this algorithm changing.
 *
 * @param preferences - partial or absent user preferences.
 * @param basePreferences - the weights to merge over and fall back to.
 * @returns complete preferences whose four weights sum to `1`.
 */
export function normalizePreferences(
  preferences: Partial<RankingPreferences> | undefined,
  basePreferences: RankingPreferences,
): RankingPreferences {
  const merged: RankingPreferences = {
    ...basePreferences,
    ...(preferences ?? {}),
  };

  const raw: Record<ReviewMetricKey, number> = {
    gradeFriendliness: Math.max(0, finite(merged.gradeFriendliness, basePreferences.gradeFriendliness)),
    workloadFriendliness: Math.max(0, finite(merged.workloadFriendliness, basePreferences.workloadFriendliness)),
    attendanceFriendliness: Math.max(0, finite(merged.attendanceFriendliness, basePreferences.attendanceFriendliness)),
    overallScore: Math.max(0, finite(merged.overallScore, basePreferences.overallScore)),
  };

  const total = METRIC_KEYS.reduce((sum, key) => sum + raw[key], 0);
  const source = total > 0
    ? raw
    : {
        gradeFriendliness: basePreferences.gradeFriendliness,
        workloadFriendliness: basePreferences.workloadFriendliness,
        attendanceFriendliness: basePreferences.attendanceFriendliness,
        overallScore: basePreferences.overallScore,
      };
  const divisor = total > 0 ? total : 1;

  const normalized: RankingPreferences = {
    gradeFriendliness: round(source.gradeFriendliness / divisor, 6),
    workloadFriendliness: round(source.workloadFriendliness / divisor, 6),
    attendanceFriendliness: round(source.attendanceFriendliness / divisor, 6),
    overallScore: round(source.overallScore / divisor, 6),
  };
  if (merged.minReviewCount !== undefined) normalized.minReviewCount = merged.minReviewCount;
  if (merged.requireAvailableSeats !== undefined) {
    normalized.requireAvailableSeats = merged.requireAvailableSeats;
  }
  return normalized;
}

/** Coerce a possibly-garbage number to a finite one. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Clamp a metric to the documented `0..10` range.
 *
 * @param value - candidate metric value.
 * @returns `undefined` when the value is not a usable finite number, otherwise
 *   the value clamped into `0..10`.
 */
export function clampMetric(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(10, Math.max(0, value));
}

/**
 * The pure scoring function.
 *
 * `score = sum(weight_i * metric_i) / sum(weight_i)` over the metrics that are
 * actually present. When nothing is present the score is `null` — the engine
 * reports "insufficient data" rather than inventing a neutral score.
 *
 * The metric values are the **decision** scores (`5.5 + reliability × (raw - 5.5)`),
 * not the raw text estimates. Ranking must not let one enthusiastic review outrank
 * fifty moderate ones, and the `components` breakdown has to agree with the total
 * it explains. The raw estimates remain visible through `Recommendation.aspects`.
 *
 * @param review - aggregated review data; `undefined` means no match at all.
 * @param preferences - already-normalized weights (see {@link normalizePreferences}).
 * @returns the score plus its full component breakdown.
 */
export function calculateCourseScore(
  review: CourseReview | undefined,
  preferences: RankingPreferences,
): { score: number | null; components: ScoreComponent[]; appliedWeights: Partial<Record<ReviewMetricKey, number>>; redistributed: ReviewMetricKey[]; decision: AspectBreakdown } {
  const decision = buildAspectBreakdown(review, aspectWeightsFromPreferences(preferences));
  const components: ScoreComponent[] = [];
  const appliedWeights: Partial<Record<ReviewMetricKey, number>> = {};
  const redistributed: ReviewMetricKey[] = [];

  let weightSum = 0;
  for (const metric of METRIC_KEYS) {
    const aspect = LEGACY_METRIC_TO_ASPECT[metric];
    const entry = aspect === undefined
      ? undefined
      : decision.aspects.find((candidate) => candidate.aspect === aspect);
    // Prefer the decision score (aspect evidence, shrunk toward neutral). Fall back
    // to the record's own scalar metric when a caller assembled a review by hand
    // without an aspect analysis — that is the only source available, and silently
    // reporting "no data" would be worse than using the number it did provide.
    const value = clampMetric(entry?.decision)
      ?? (review === undefined ? undefined : clampMetric(review[metric]));
    if (value === undefined) {
      components.push({ metric, weight: 0, available: false });
      redistributed.push(metric);
      continue;
    }
    const weight = preferences[metric];
    weightSum += weight;
    components.push({ metric, weight, value, contribution: round(weight * value, 6), available: true });
  }

  if (review === undefined || weightSum === 0) {
    return { score: null, components, appliedWeights, redistributed, decision };
  }

  const total = components.reduce((sum, component) => {
    if (!component.available || component.value === undefined) return sum;
    return sum + component.weight * component.value;
  }, 0);

  for (const component of components) {
    if (!component.available) continue;
    appliedWeights[component.metric] = round(component.weight / weightSum, 6);
  }

  return { score: round(total / weightSum, 4), components, appliedWeights, redistributed, decision };
}

/**
 * Score and rank a set of matched courses.
 *
 * Ordering is a total order: score desc, then confidence desc, then review count
 * desc, then course code/name ascending. Ties can therefore not depend on input
 * order, which keeps repeated runs reproducible.
 *
 * `topN` is honoured as given: this function no longer imposes a maximum of its
 * own, because "how many results may be returned" is a response-policy decision
 * that belongs to the caller. It still truncates toward zero and treats
 * non-finite input as `0`, so the returned length is always a usable integer.
 *
 * @param matches - matched courses.
 * @param preferences - normalized preferences.
 * @param topN - how many results to return.
 * @returns ranked, fully broken-down scores.
 */
export function rankCourses(
  matches: readonly MatchResult[],
  preferences: RankingPreferences,
  topN: number,
): CourseScore[] {
  const limit = Math.max(0, Math.trunc(finite(topN, 0)));

  const scored: CourseScore[] = matches.map((match) => {
    const { score, components, appliedWeights, redistributed, decision } = calculateCourseScore(match.review, preferences);
    const confidence = calculateReviewConfidence(match);
    return { course: match.course, score, components, appliedWeights, redistributed, match, confidence, decision };
  });

  scored.sort(compareScores);
  return scored.slice(0, limit);
}

/**
 * Total order over scored courses.
 *
 * Exported so tests can assert the ordering contract directly.
 *
 * @param left - first score.
 * @param right - second score.
 * @returns negative when `left` should rank before `right`.
 */
export function compareScores(left: CourseScore, right: CourseScore): number {
  // Courses with no usable score sort last, but they are not silently dropped:
  // the caller lists them under insufficientData.
  if (left.score === null && right.score !== null) return 1;
  if (left.score !== null && right.score === null) return -1;
  if (left.score !== null && right.score !== null && left.score !== right.score) {
    return right.score - left.score;
  }
  if (left.confidence.value !== right.confidence.value) {
    return right.confidence.value - left.confidence.value;
  }
  const leftReviews = left.match.review?.reviewCount ?? 0;
  const rightReviews = right.match.review?.reviewCount ?? 0;
  if (leftReviews !== rightReviews) return rightReviews - leftReviews;

  const leftKey = left.course.courseCode ?? left.course.normalizedName;
  const rightKey = right.course.courseCode ?? right.course.normalizedName;
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  // Final deterministic fallback: the original page name.
  if (left.course.courseName !== right.course.courseName) {
    return left.course.courseName < right.course.courseName ? -1 : 1;
  }
  return 0;
}

/**
 * Build the deterministic reason strings for one scored course.
 *
 * These are facts, not prose: the agent turns them into an explanation.
 *
 * @param scored - a scored course.
 * @returns short reason lines, strongest first.
 */
export function buildReasons(scored: CourseScore): string[] {
  const reasons: string[] = [];
  const review = scored.match.review;
  if (review === undefined) return ['未匹配到可信评价数据，仅根据选课页信息列出'];

  const top = scored.components
    .filter((component) => component.available && component.value !== undefined && component.weight > 0)
    .sort((a, b) => (b.contribution ?? 0) - (a.contribution ?? 0));
  const best = top[0];
  if (best !== undefined && best.value !== undefined) {
    reasons.push(
      `主要贡献项 ${metricLabel(best.metric)} = ${best.value.toFixed(1)}/10（权重 ${(best.weight * 100).toFixed(0)}%）`,
    );
  }
  if (review.meanGrade !== undefined) {
    reasons.push(`评价样本平均成绩 ${review.meanGrade.toFixed(1)} 分（${review.gradedSampleCount} 条含成绩样本）`);
  }
  reasons.push(`共 ${review.reviewCount} 条评价样本，可信度 ${scored.confidence.tier}（${scored.confidence.value.toFixed(2)}）`);
  if (review.teacher !== undefined) reasons.push(`评价对应教师：${review.teacher}`);
  return reasons;
}

/**
 * Chinese label for a metric key.
 *
 * ## Why these are the product words (Step 41 polish)
 *
 * This table and `aspectLabel` in `recommendation.ts` cover **the same four rankable dimensions** under two key
 * spellings — this one says `overallScore`, that one says `studentSentiment`. They carried different words
 * (`给分友好度` / `课业轻松度` / `考勤宽松度` here, `给分友好` / `学习负担轻` / `考勤宽松` there), so a single
 * `course_explain` output named one dimension two ways:
 *
 * ```text
 * - 给分友好度: 6.79 × 权重 50%      ← this table
 *   - 给分友好：8.3，证据偏少（…）    ← aspectLabel
 * ```
 *
 * A reader has no way to tell those are the same dimension. Both tables now carry the product words, and
 * `step41PolishContract.test.ts` asserts they agree key by key, so the next divergence fails a test instead of reaching
 * a reader. Only the strings changed: no weight, score or threshold is touched.
 */
export function metricLabel(metric: ReviewMetricKey): string {
  switch (metric) {
    case 'gradeFriendliness':
      return '给分友好';
    case 'workloadFriendliness':
      return '学习负担轻';
    case 'attendanceFriendliness':
      return '考勤宽松';
    case 'overallScore':
      return '综合口碑';
  }
}
