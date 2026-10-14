/**
 * The decision layer: turning raw aspect scores into a ranked recommendation.
 *
 * ## The problem this solves
 *
 * A raw aspect score is a **centre estimate**: `attendance = 9.2` from two reviews
 * and `attendance = 9.1` from eighty reviews are both honest readings of what was
 * written. They are not equally actionable. If ranking used the raw score, one
 * enthusiastic review would beat fifty moderately positive ones.
 *
 * ## The fix: shrink toward neutral, do not multiply
 *
 * ```
 * decisionScore = 5.5 + reliability × (rawScore - 5.5)
 * ```
 *
 * Shrinking toward the neutral value is the only formulation that gets all three
 * cases right:
 *
 * | situation | result | why |
 * | --- | --- | --- |
 * | high raw, low reliability | near neutral | "possibly good, but I can't tell" |
 * | low raw, low reliability | near neutral | "possibly bad, but I won't condemn it" |
 * | high raw, high reliability | near raw | the data actually says so |
 *
 * Multiplying instead (`8.5 × 0.3 = 2.55`) would turn *unknown* into *bad*, which
 * is the single worst error a recommender can make: it silently buries courses
 * nobody has reviewed yet.
 *
 * The raw score is **never modified** — it is reported beside the decision score
 * so a user can see both what students said and how much weight we gave it.
 *
 * @module @course-copilot/core/recommendation
 */

import {
  ASPECT_KEYS,
  type AspectAnalysis,
  type AspectBreakdown,
  type AspectDecision,
  type AspectKey,
  type AspectScore,
} from './aspects/types.js';
import { REVIEW_COUNT_SATURATION } from './config.js';
import type {
  CourseReview,
  CourseLevelReview,
  EvidenceStrengthEntry,
  EvidenceStrengthLevel,
  RankingPreferences,
} from './types/course.js';

/** The neutral value both the scores and the shrinkage use. */
export const NEUTRAL_SCORE = 5.5;

/**
 * Aspects the *default* ranking may use.
 *
 * `examFriendliness` is deliberately absent. In the real 高等数学 corpus only 6 of
 * 254 reviews say anything about exam difficulty, so giving it equal footing with
 * workload would let a rounding error decide the ranking. It stays visible in
 * lookup and explain output, and enters ranking only when a user explicitly asks
 * for it (see {@link ASPECT_PRESETS} and `examFriendliness` preferences).
 */
export const RANKABLE_ASPECTS: readonly AspectKey[] = [
  'gradeFriendliness',
  'workloadFriendliness',
  'attendanceFriendliness',
  'studentSentiment',
] as const;

/** Every aspect that may carry a weight, including the opt-in one. */
export const WEIGHTABLE_ASPECTS: readonly AspectKey[] = [
  ...RANKABLE_ASPECTS,
  'examFriendliness',
  'teachingQuality',
] as const;

/** Aspect weights. Relative; {@link normalizeAspectPreferences} normalizes them. */
export type AspectWeights = Partial<Record<AspectKey, number>>;

/** Named preference presets, so a caller can express intent instead of numbers. */
export const ASPECT_PRESETS: Readonly<Record<string, AspectWeights>> = {
  /** The default: light workload and generous marking. */
  easy_grade: {
    gradeFriendliness: 0.5,
    workloadFriendliness: 0.3,
    attendanceFriendliness: 0.15,
    studentSentiment: 0.05,
  },
  /** Care about the teaching itself, not only the outcome. */
  balanced: {
    gradeFriendliness: 0.3,
    workloadFriendliness: 0.2,
    attendanceFriendliness: 0.1,
    teachingQuality: 0.25,
    studentSentiment: 0.15,
  },
  /** Optimise for actually learning something. */
  learn_something: {
    teachingQuality: 0.45,
    studentSentiment: 0.2,
    gradeFriendliness: 0.15,
    workloadFriendliness: 0.1,
    attendanceFriendliness: 0.1,
  },
  /** Explicitly opt exam difficulty into the ranking. */
  exam_light: {
    gradeFriendliness: 0.35,
    workloadFriendliness: 0.25,
    examFriendliness: 0.25,
    attendanceFriendliness: 0.1,
    studentSentiment: 0.05,
  },
};

/** The product's default preference, documented as "活少好拿分". */
export const DEFAULT_ASPECT_WEIGHTS: AspectWeights = ASPECT_PRESETS.easy_grade as AspectWeights;

/**
 * The breakdown types moved to `@course-copilot/core/aspects` during productization
 * (Step 5b-2), because they are part of the aspect model rather than of the decision
 * logic: `src/types/course.ts` consumes `AspectBreakdown`, and leaving it declared here
 * made the course domain depend on this module while this module depends on the course
 * domain — a cycle. They are re-exported so existing importers keep working; this module
 * declares neither, and the authoritative definitions are in the package.
 */
export type { AspectBreakdown, AspectDecision } from './aspects/types.js';

/**
 * Normalize aspect weights into a summing-to-one distribution.
 *
 * Negative weights are clamped to `0`. Two cases fall back to
 * {@link DEFAULT_ASPECT_WEIGHTS} rather than producing a uniform zero score:
 * an all-zero payload, and a payload that named no aspect at all.
 *
 * **No defaults are merged in.** A caller that asks for three dimensions gets
 * exactly those three; silently adding a fourth would score a dimension the caller
 * never mentioned.
 *
 * @param weights - partial weights, relative.
 * @returns normalized weights over exactly the keys that were present.
 */
export function normalizeAspectPreferences(weights: AspectWeights | undefined): AspectWeights {
  const source: AspectWeights = weights ?? {};
  const raw: Array<[AspectKey, number]> = [];
  for (const aspect of WEIGHTABLE_ASPECTS) {
    const value = source[aspect];
    if (value === undefined) continue;
    if (!Number.isFinite(value)) continue;
    raw.push([aspect, Math.max(0, value)]);
  }
  const total = raw.reduce((sum, [, value]) => sum + value, 0);
  if (total <= 0) return normalizeAspectPreferences(DEFAULT_ASPECT_WEIGHTS);
  const out: AspectWeights = {};
  for (const [aspect, value] of raw) out[aspect] = round(value / total, 6);
  return out;
}

/**
 * Reliability of one aspect's score: how much the evidence supports it.
 *
 * Two ingredients, because either alone is misleading:
 *
 * - **Volume**, saturating: 2 reviews is weak, 40 is strong, 400 is not 10× 40.
 * - **Agreement**, from the review-level split: 20 reviews that all say "no
 *   attendance check" is a firmer claim than 20 that split 11/9.
 *
 * A unanimous single review still scores low, because volume is genuinely low —
 * that is what makes the shrinkage in {@link decisionScore} do its job.
 *
 * @param score - the aspect score produced by the Phase 2 engine.
 * @returns `0..1`.
 */
export function aspectReliability(score: AspectScore): number {
  const reviews = score.evidenceReviewCount;
  if (reviews <= 0 || score.score === undefined) return 0;
  const volume = 1 - Math.exp(-reviews / REVIEW_COUNT_SATURATION);
  const positive = score.positiveReviewCount;
  const negative = score.negativeReviewCount;
  const mixed = score.mixedReviewCount;
  const directional = positive + negative;
  // Mixed reviews count as half agreement: they did take a side, just both.
  const agreement = directional === 0
    ? 0.5
    : (Math.max(positive, negative) + mixed * 0.5) / (directional + mixed);
  return round(clamp01(0.6 * volume + 0.4 * agreement), 6);
}

/**
 * Shrink a raw score toward neutral by its reliability.
 *
 * @param raw - the raw `0..10` aspect score.
 * @param reliability - `0..1` support for that score.
 * @returns the decision score; equals `raw` when reliability is `1`, and
 *   {@link NEUTRAL_SCORE} when it is `0`.
 */
export function decisionScore(raw: number, reliability: number): number {
  const r = clamp01(reliability);
  return round(NEUTRAL_SCORE + r * (raw - NEUTRAL_SCORE), 4);
}

/**
 * Build the per-aspect decision breakdown for one review aggregate.
 *
 * Missing aspects are **not** treated as `0` or as neutral-and-counted: their
 * weight is redistributed across the aspects that do have data, and they are
 * reported in `missingDimensions` with an explicit note.
 *
 * @param review - the aggregated review data, or `undefined` when unmatched.
 * @param weights - aspect weights, relative.
 * @returns the breakdown including the weighted decision score.
 */
export function buildAspectBreakdown(
  review: CourseReview | CourseLevelReview | undefined,
  weights: AspectWeights,
): AspectBreakdown {
  const analysis: AspectAnalysis | undefined = review?.aspects;
  const preferred = normalizeAspectPreferences(weights);

  const aspects: AspectDecision[] = [];
  const missingDimensions: AspectKey[] = [];
  const notes: string[] = [];

  for (const aspect of WEIGHTABLE_ASPECTS) {
    const weight = preferred[aspect];
    if (weight === undefined || weight <= 0) continue;
    const score = analysis?.scores.find((entry) => entry.aspect === aspect);
    const raw = score?.score;
    const reliability = score === undefined ? 0 : aspectReliability(score);
    const base: AspectDecision = {
      aspect,
      reliability,
      weight: 0,
      evidenceReviewCount: score?.evidenceReviewCount ?? 0,
      mentionCount: score?.mentionCount ?? 0,
      matchedTerms: score?.matchedTerms ?? [],
    };
    if (raw === undefined) {
      missingDimensions.push(aspect);
      aspects.push(base);
      continue;
    }
    base.raw = raw;
    base.decision = decisionScore(raw, reliability);
    aspects.push(base);
  }

  const usable = aspects.filter((entry) => entry.decision !== undefined);
  const weightSum = usable.reduce((sum, entry) => {
    const weight = preferred[entry.aspect] ?? 0;
    entry.weight = weight;
    entry.contribution = round(weight * (entry.decision as number), 6);
    return sum + weight;
  }, 0);

  const appliedWeights: Partial<Record<AspectKey, number>> = {};
  let decisionTotal: number | null = null;
  if (usable.length > 0 && weightSum > 0) {
    for (const entry of usable) {
      appliedWeights[entry.aspect] = round((preferred[entry.aspect] ?? 0) / weightSum, 6);
    }
    decisionTotal = round(
      usable.reduce((sum, entry) => sum + (entry.contribution ?? 0), 0) / weightSum,
      4,
    );
  }

  for (const aspect of missingDimensions) {
    notes.push(
      `${aspectLabel(aspect)} 缺少可靠数据，本次排名未使用该维度`
      + `（其权重已按比例分配给其余维度）`,
    );
  }

  return { aspects, decisionScore: decisionTotal, appliedWeights, missingDimensions, notes };
}

/**
 * Weighted decision score over an aspect breakdown.
 *
 * @param breakdown - a breakdown from {@link buildAspectBreakdown}.
 * @returns the decision score, or `null` when nothing was usable.
 */
export function calculateDecisionScore(breakdown: AspectBreakdown): number | null {
  return breakdown.decisionScore;
}

/** Clamp into `0..1`, treating non-finite input as `0`. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Shrink a final score toward neutral by the confidence in it.
 *
 * `5.5 + confidence × (score − 5.5)` — the same shape used per aspect by {@link decisionScore}, applied
 * once more to the result. The purpose is to make two scores comparable when they rest on very different
 * amounts of evidence: 8.7 from one review and 8.5 from twenty are not equally actionable, and reporting
 * both as bare numbers invites the reader to trust the thinner one.
 *
 * This deliberately does **not** fold confidence into the weighting. Confidence is categorical — a low
 * value usually means "the teacher did not match", not "the course is 0.3 good" — and a weighted sum
 * cannot express that. Shrinking keeps the two questions separate: the weighted sum says *how good*, this
 * says *how sure*.
 *
 * @param score - the weighted decision score, or `null` when nothing was available.
 * @param confidence - review confidence in `0..1`.
 * @returns the shrunk score, or `null` when there was no score to shrink.
 */
export function riskAdjustedScore(score: number | null, confidence: number): number | null {
  if (score === null || !Number.isFinite(score)) return null;
  const c = clamp01(confidence);
  return round(NEUTRAL_SCORE + c * (score - NEUTRAL_SCORE), 4);
}

/** Thresholds for {@link evidenceStrength}. Named, so the cut points are not buried in a condition. */
export const EVIDENCE_STRENGTH_THRESHOLDS = {
  /** Reviews with evidence at or above this, **and** coverage at or above `coverage`, is `strong`. */
  strongReviews: 20,
  strongCoverage: 0.3,
  /** Reviews with evidence at or above this is at least `moderate`. */
  moderateReviews: 10,
  /** `moderate` additionally needs this much coverage. */
  moderateCoverage: 0.2,
  /** Below this many reviews the tier is `limited` however broad the coverage. */
  limitedReviews: 3,
} as const;

/**
 * Grade the evidence behind one aspect.
 *
 * Requires **both** a sample size and a coverage share, because measuring either alone misleads in a
 * different direction: 5 mentions out of 100 reviews is broad but too thin to lean on, while 9 of 10
 * agreeing is decisive but describes only ten students. Agreement is reported for context and quoted in
 * the note, but it does not raise the tier — five unanimous reviews are still five reviews.
 *
 * @param score - the aspect score to grade.
 * @param corpusReviews - how many reviews the aspect was assessed against.
 * @returns the tier plus the numbers behind it, for display.
 */
export function evidenceStrength(
  score: AspectScore,
  corpusReviews: number,
): EvidenceStrengthEntry {
  const reviewsWithEvidence = score.evidenceReviewCount;
  const corpus = Number.isFinite(corpusReviews) && corpusReviews > 0 ? corpusReviews : 0;
  const coverage = corpus === 0 ? 0 : clamp01(reviewsWithEvidence / corpus);
  const directional = score.positiveReviewCount + score.negativeReviewCount;
  const mixed = score.mixedReviewCount;
  // Mixed reviews took a side, just both, so they count as half agreement -- the same rule
  // `aspectReliability` uses, kept consistent on purpose.
  const agreement = directional === 0
    ? (mixed === 0 ? 0 : 0.5)
    : clamp01((Math.max(score.positiveReviewCount, score.negativeReviewCount) + mixed * 0.5) / (directional + mixed));

  const t = EVIDENCE_STRENGTH_THRESHOLDS;
  let level: EvidenceStrengthLevel;
  if (reviewsWithEvidence === 0) level = 'none';
  else if (reviewsWithEvidence >= t.strongReviews && coverage >= t.strongCoverage) level = 'strong';
  else if (reviewsWithEvidence >= t.moderateReviews && coverage >= t.moderateCoverage) level = 'moderate';
  else level = 'limited';

  const shared = `${reviewsWithEvidence}/${corpus === 0 ? '?' : corpus} 条评价提及（覆盖 ${(coverage * 100).toFixed(0)}%，一致性 ${(agreement * 100).toFixed(0)}%）`;
  const note = level === 'none'
    ? '没有评价谈到这一维度，因此不计入排序，其权重已分配给其他维度'
    : level === 'strong'
      ? `${shared}；样本量与覆盖面都足够，结论较稳`
      : level === 'moderate'
        ? `${shared}；有参考价值，但样本仍偏少`
        : `${shared}；样本或覆盖面偏少，结论仅供参考`;

  return { aspect: score.aspect, level, reviewsWithEvidence, corpusReviews: corpus, coverage, agreement, note };
}

/**
 * Describe which aspects lost their weight and where it went.
 *
 * The requested weighting and the effective one differ whenever an aspect has no evidence, and the
 * difference is not cosmetic: on a real corpus where `studentSentiment` was absent, the grade aspect's
 * applied weight was `0.526` rather than `0.50`. Reporting only the requested numbers would describe a
 * model that was not the one used.
 *
 * @param requested - the weights the caller asked for.
 * @param applied - the weights actually used.
 * @param missing - aspects that had no evidence.
 * @returns one sentence per missing aspect, empty when nothing moved.
 */
export function describeWeightRedistribution(
  requested: AspectWeights,
  applied: Readonly<Partial<Record<AspectKey, number>>>,
  missing: readonly AspectKey[],
): string[] {
  if (missing.length === 0) return [];
  const notes: string[] = [];
  for (const aspect of missing) {
    const askedFor = requested[aspect];
    if (askedFor === undefined || askedFor <= 0) continue;
    const receivers = (Object.entries(applied) as Array<[AspectKey, number]>)
      .filter(([key]) => key !== aspect && applied[key] !== undefined)
      .map(([key, value]) => `${aspectLabel(key)} ${(value * 100).toFixed(0)}%`);
    notes.push(
      `${aspectLabel(aspect)}无可用数据，其 ${(askedFor * 100).toFixed(0)}% 权重已分配至${receivers.length === 0 ? '其他维度' : `：${receivers.join('、')}`}`,
    );
  }
  return notes;
}

/** Round with a fixed precision. */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Chinese label for an aspect.
 *
 * ## These are the product words (Step 40.7)
 *
 * The four rankable aspects use the same words the preference contract publishes — 给分友好 / 学习负担轻 / 考勤宽松 /
 * 综合口碑 — because a reader sees both surfaces: the recommendation card and the run's own prose. They previously read
 * 给分友好度 / 课业轻松度 / 考勤宽松度 here, so the card and the prose beside it named the same weight differently.
 *
 * This stays the **one** label table rather than a second one: Core is the lower layer, so the pipeline contract cannot
 * be imported here (that would invert the dependency), and the contract's own words are mirrored instead.
 *
 * `examFriendliness` and `teachingQuality` are deliberately outside the four: they stay in the review analysis and the
 * explanation but never move the ranking, and the preference contract gives them no key at all.
 */
export function aspectLabel(aspect: AspectKey): string {
  switch (aspect) {
    case 'gradeFriendliness':
      return '给分友好';
    case 'workloadFriendliness':
      return '学习负担轻';
    case 'attendanceFriendliness':
      return '考勤宽松';
    case 'examFriendliness':
      return '考试友好';
    case 'teachingQuality':
      return '教学质量';
    case 'studentSentiment':
      return '综合口碑';
  }
}

/** The four legacy metric keys, mapped onto their Phase 2 aspect. */
export const LEGACY_METRIC_TO_ASPECT: Readonly<Record<string, AspectKey>> = {
  gradeFriendliness: 'gradeFriendliness',
  workloadFriendliness: 'workloadFriendliness',
  attendanceFriendliness: 'attendanceFriendliness',
  // `overallScore` was the old name for "what students thought generally".
  overallScore: 'studentSentiment',
};

/**
 * Turn a user-facing preference payload into aspect weights.
 *
 * Resolution order, most explicit first:
 *
 * 1. `preset` — a named intent (`easy_grade`, `balanced`, `learn_something`,
 *    `exam_light`), so a caller can say *what they want* instead of guessing numbers.
 * 2. Explicit aspect weights, including the opt-in `examFriendliness` and
 *    `teachingQuality`.
 * 3. The legacy four metrics, with `overallScore` mapped onto `studentSentiment`.
 *
 * When nothing is supplied the phase-3 default applies: "活少好拿分".
 *
 * @param preferences - the merged user preferences.
 * @returns aspect weights ready for {@link normalizeAspectPreferences}.
 */
export function aspectWeightsFromPreferences(
  preferences: Partial<RankingPreferences> | undefined,
): AspectWeights {
  const source = preferences ?? {};
  const preset = source.preset === undefined ? undefined : ASPECT_PRESETS[source.preset];
  if (preset !== undefined) return { ...preset };

  const explicit: AspectWeights = {};
  let anyExplicit = false;
  const set = (aspect: AspectKey, value: number | undefined): void => {
    if (value === undefined || !Number.isFinite(value)) return;
    explicit[aspect] = value;
    anyExplicit = true;
  };
  set('gradeFriendliness', source.gradeFriendliness);
  set('workloadFriendliness', source.workloadFriendliness);
  set('attendanceFriendliness', source.attendanceFriendliness);
  // `studentSentiment` is the phase-3 name; `overallScore` is the legacy alias.
  set('studentSentiment', source.studentSentiment ?? source.overallScore);
  set('examFriendliness', source.examFriendliness);
  set('teachingQuality', source.teachingQuality);
  if (anyExplicit) return explicit;

  return { ...DEFAULT_ASPECT_WEIGHTS };
}

/** Every aspect key, re-exported so callers need one import site. */
export { ASPECT_KEYS };
