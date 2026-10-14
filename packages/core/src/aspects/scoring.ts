/**
 * Turning aspect evidence into `0..10` scores.
 *
 * ## The calibration rule: sample size is confidence, not extremity
 *
 * An earlier version summed *mention weights* across the whole corpus:
 *
 * ```
 * score = 5.5 + 4.5 * tanh(0.4 * Σ(polarity × strength))
 * ```
 *
 * That made the score a function of how much text existed. Across the real
 * 高等数学 corpus (254 reviews) it pinned four of six dimensions to 1.00 and 10.00,
 * which is not "extreme opinions" — it is sample size leaking into the estimate.
 * Thirty agreeing reviews and three hundred agreeing reviews describe the same
 * *direction*; only our certainty differs, and certainty belongs to confidence.
 *
 * So the input is now the **mean per-review signal**:
 *
 * ```
 * per review r, per aspect a:   s(r,a) = signed weight of that review's strongest mention ÷ 1.5
 * mean signal:                  m(a)   = Σ s(r,a) / #{reviews with evidence}
 * score:                        map(m) = 5.5 + 4.5 * tanh(1.2 * m)
 * ```
 *
 * Taking the **strongest mention per review** is what keeps one person to one
 * vote: a student who writes `很好，真的很好，非常好` does not speak three times as
 * loudly as one who writes `很好`. Dividing by the `strong` weight (`1.5`) makes
 * that weight the unit, so `s` stays inside `-1..1` while intensity is preserved:
 * a lone `作业多` (`normal`, `0.667`) still scores measurably better than a lone
 * `作业很多` (`strong`, `1.0`), and `每节课签到` (`strong`) better than `签到`
 * (`mild`, `0.333`). Clamping everything to one value erased those distinctions,
 * which is the ordinality this module exists to preserve.
 *
 * Properties this buys, all under test:
 *
 * - `n` reviews that agree give the same score as `10n` that agree.
 * - Adding a review that agrees can only raise the score (monotonicity).
 * - `100 positive / 0 negative` is high **because the proportion is ~100%**, not
 *   because `n` is large.
 * - Repetition inside one review cannot vote twice.
 *
 * @module @course-copilot/core/aspects/scoring
 */

import {
  ASPECT_KEYS,
  STRENGTH_WEIGHT,
  type AspectAnalysis,
  type AspectKey,
  type AspectMention,
  type AspectScore,
  type ExamFormat,
  type Polarity,
  type ReviewAspects,
} from './types.js';
import { EXAM_FORMATS } from './types.js';

/** Neutral prior: the score of "no opinion either way". */
const NEUTRAL = 5.5;

/** How far a score may travel from neutral. */
const RANGE = 4.5;

/**
 * Amplifies the mean signal.
 *
 * `1.2` is a calibration choice, not an aesthetic one. Two constraints bracket it:
 *
 * - **Steep enough to be useful.** With `0.9` a unanimous corpus capped out at
 *   8.72, so "every single student says there is no attendance check" could never
 *   read as a strong signal.
 * - **Shallow enough to stay ordinal.** With `1.6`, `随机点名` and `每节课签到`
 *   collapsed onto the same 1.35 despite one being visibly milder. `1.2` keeps them
 *   apart (4.38 vs 2.60) while a unanimous corpus reaches ~9.3.
 */
const SLOPE = 1.2;

/**
 * Pseudo-reviews of shrinkage for sentiment.
 *
 * Sentiment is the one dimension where a single word (`神中神`) is a complete
 * opinion, so it gets a prior: one review alone stays moderate, while a unanimous
 * corpus still approaches the end. `1` means one neutral review on each side.
 */
const SENTIMENT_PRIOR = 1;

/** Whether an aspect shrinks its mean toward neutral by a prior. */
function priorFor(aspect: AspectKey): number {
  return aspect === 'studentSentiment' ? SENTIMENT_PRIOR : 0;
}

/**
 * The unit of a per-review signal: one `strong` mention.
 *
 * Dividing by it keeps the mean signal inside `-1..1` while letting `normal` and
 * `mild` mentions score proportionally lower, which is what preserves ordinality
 * between `作业多` and `作业很多`.
 */
export const SIGNAL_UNIT = STRENGTH_WEIGHT.strong;

/** Signed weight of one mention, normalized so a `strong` mention is `±1`. */
function signedWeight(polarity: Polarity, strength: AspectMention['strength']): number {
  const weight = STRENGTH_WEIGHT[strength] / SIGNAL_UNIT;
  return polarity === 'positive' ? weight : -weight;
}

/**
 * Map a review-level mean signal onto `0..10`.
 *
 * @param meanSignal - mean of per-review signals, in `-1..1`.
 * @returns the score, inside `0..10`.
 */
export function meanSignalToScore(meanSignal: number): number {
  const score = NEUTRAL + RANGE * Math.tanh(SLOPE * meanSignal);
  return Number(Math.max(0, Math.min(10, score)).toFixed(4));
}

/**
 * Combine several reviews' mentions of one aspect into a mean signal.
 *
 * @param signals - one `-1..1` value per review that had evidence.
 * @param prior - pseudo-neutral reviews to blend in; `0` disables shrinkage.
 * @returns the mean signal, or `undefined` when there is no evidence.
 */
export function meanSignal(signals: readonly number[], prior = 0): number | undefined {
  if (signals.length === 0) return undefined;
  const sum = signals.reduce((total, value) => total + value, 0);
  const denominator = signals.length + prior * 2;
  return Number((sum / denominator).toFixed(6));
}

/** Build one aspect's score from the reviews that mentioned it. */
function scoreAspect(aspect: AspectKey, reviews: readonly ReviewAspects[]): AspectScore {
  const mentions: AspectMention[] = [];
  const signals: number[] = [];
  let positiveReviewCount = 0;
  let negativeReviewCount = 0;
  let mixedReviewCount = 0;

  for (const review of reviews) {
    const mine = review.mentions.filter((mention) => mention.aspect === aspect && mention.formatOnly !== true);
    if (mine.length === 0) continue;
    mentions.push(...mine);
    // One vote per review: the strongest single mention sets the sign and the
    // intensity, so repetition cannot outvote a peer who mentioned it once.
    const weights = mine.map((mention) => signedWeight(mention.polarity, mention.strength));
    const strongest = weights.reduce(
      (best, weight) => (Math.abs(weight) > Math.abs(best) ? weight : best),
      weights[0] ?? 0,
    );
    signals.push(strongest);
    const hasPositive = mine.some((mention) => mention.polarity === 'positive');
    const hasNegative = mine.some((mention) => mention.polarity === 'negative');
    if (hasPositive && hasNegative) mixedReviewCount += 1;
    else if (hasPositive) positiveReviewCount += 1;
    else negativeReviewCount += 1;
  }

  const positiveMentions = mentions.filter((mention) => mention.polarity === 'positive').length;
  const matchedTerms = [...new Set(mentions.map((mention) => mention.phrase))];
  const evidenceReviewCount = signals.length;
  const mean = meanSignal(signals, priorFor(aspect));
  const score: AspectScore = {
    aspect,
    positiveMentions,
    negativeMentions: mentions.length - positiveMentions,
    sampleCount: mentions.length,
    evidenceReviewCount,
    mentionCount: mentions.length,
    positiveReviewCount,
    negativeReviewCount,
    mixedReviewCount,
    matchedTerms,
    note: evidenceReviewCount === 0
      ? '没有命中任何该维度的文本证据'
      : `依据 ${evidenceReviewCount} 条含证据评价（正面 ${positiveReviewCount}、负面 ${negativeReviewCount}、`
        + `混合 ${mixedReviewCount}），共 ${mentions.length} 处提及；`
        + `按评论取平均信号后映射：5.5 + 4.5×tanh(${SLOPE}×${(mean ?? 0).toFixed(3)})`,
  };
  if (evidenceReviewCount > 0 && mean !== undefined) {
    score.rawMeanSignal = mean;
    score.score = meanSignalToScore(mean);
  }
  return score;
}

/**
 * Score every aspect from a set of reviews.
 *
 * @param reviews - per-review extractions, each carrying its own signals.
 * @returns one entry per {@link ASPECT_KEYS} entry, in that fixed order.
 */
export function scoreAspectReviews(reviews: readonly ReviewAspects[]): AspectScore[] {
  return ASPECT_KEYS.map((aspect) => scoreAspect(aspect, reviews));
}

/** Tally how often each assessment format was stated. */
export function tallyExamFormats(reviews: readonly ReviewAspects[]): Record<ExamFormat, number> {
  const tally = Object.fromEntries(EXAM_FORMATS.map((format) => [format, 0])) as Record<ExamFormat, number>;
  for (const review of reviews) {
    if (review.examFormat !== undefined) tally[review.examFormat] += 1;
  }
  return tally;
}

/**
 * Aggregate several reviews' worth of aspects.
 *
 * @param reviews - per-review aspect extractions.
 * @returns scores plus mention totals, mixing counts, and the format tally.
 */
export function analyzeAspects(reviews: readonly ReviewAspects[]): AspectAnalysis {
  const mentions = reviews.flatMap((review) => review.mentions);
  const positiveMentions = mentions.filter((mention) => mention.polarity === 'positive').length;
  return {
    scores: scoreAspectReviews(reviews),
    positiveMentions,
    negativeMentions: mentions.length - positiveMentions,
    mixedReviewCount: reviews.filter((review) => review.mixed).length,
    coveredReviewCount: reviews.filter((review) => review.mentions.length > 0).length,
    reviewCount: reviews.length,
    examFormats: tallyExamFormats(reviews),
  };
}

/** Look up one aspect's score in an analysis. */
export function aspectScore(analysis: AspectAnalysis, aspect: AspectKey): AspectScore | undefined {
  return analysis.scores.find((entry) => entry.aspect === aspect);
}
