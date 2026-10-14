/**
 * Grade friendliness: two independent signals, combined with provenance.
 *
 * ## Why the two are kept apart
 *
 * `课程成绩 = 95` is an *outcome*: the student did well. `给分高` is *behaviour*:
 * the course is generous. Mapping the first directly onto "friendliness" confuses
 * a strong cohort with a lenient marker, and lets a single 95 turn a course into
 * 9.8. So both are computed separately, reported separately, and only then
 * combined — and the combination is stated in the output so a reader can audit it.
 *
 * The outcome signal is also shrunk toward neutral when few grades exist, which is
 * the same reasoning as {@link GRADE_OUTCOME_PRIOR_SAMPLES}: one 95 is a rumour,
 * twenty 88s are data.
 *
 * @module @course-copilot/core/aspects/gradeSignal
 */

import { gradeToFriendliness } from '@course-copilot/core/aspects/grade';
import type { GradeStatistics } from '../types/course.js';
import type { AspectMention, AspectScore, AspectSignalBreakdown, GradeCalibration } from './types.js';

/** Grade samples below which the outcome signal is pulled toward neutral. */
export const GRADE_OUTCOME_PRIOR_SAMPLES = 5;

/** Weight of each signal when both exist. */
const OUTCOME_WEIGHT = 0.5;
const TEXT_WEIGHT = 0.5;

/** One signal's contribution, for `course_explain` to quote. */
export interface GradeSignalPart {
  /** `0..10`, or `undefined` when the signal has no evidence. */
  score?: number;
  /** How many observations backed it. */
  sampleCount: number;
  /** Human-readable derivation. */
  note: string;
}

/**
 * The two DISTINCT evidence counts this dimension needs.
 *
 * ## Why one count is not enough
 *
 * This aspect draws on two sources that can cover the SAME review: a student may write `给分很高` *and* publish a grade of 95. So there are
 * three different numbers, and only two of them are supplied here:
 *
 * - `text` — reviews carrying **text** evidence for this aspect. This is what `gradeTextSignal` describes, so it is the only count the
 *   text signal may be told about. Feeding it the union would make it claim support from reviews that said nothing about marking.
 * - `union` — reviews carrying text evidence **or** a usable percentage grade. This is the honest "how many reviews back this
 *   dimension" figure, and it is what the final {@link AspectScore.evidenceReviewCount} must hold.
 *
 * The third number, the usable-grade count, is read by `gradeOutcomeSignal` from `GradeStatistics.validSampleCount` and is deliberately
 * not repeated here, so there is exactly one source for it.
 *
 * `text + grade` is NOT the union — that double-counts every review that did both. The union cannot be recovered from the two counts, so
 * the caller must compute it from row-level facts, which is why it arrives as its own value.
 */
export interface GradeEvidenceCounts {
  /** Reviews carrying text evidence for this aspect. */
  text: number;
  /** Reviews carrying text evidence OR a usable percentage grade. */
  union: number;
}

/** The combined grade-friendliness result. */
export interface GradeFriendlinessSignal {
  /** The combined `0..10` score, absent when neither signal exists. */
  score?: number;
  /** Signal derived from the published grade distribution. */
  outcome: GradeSignalPart;
  /** Signal derived from what students *say* about marking. */
  text: GradeSignalPart;
  /** Weights actually applied, which sum to 1 when both signals exist. */
  appliedWeights: { outcome: number; text: number };
  /** The distinct evidence counts, carried through so the final aspect can report the union. */
  evidenceCounts: GradeEvidenceCounts;
}

/**
 * Build the outcome signal from grade statistics.
 *
 * Uses the mean and the median, then shrinks toward neutral by sample size:
 * `w = n / (n + prior)`. With one sample the signal is pulled most of the way
 * back to 5.5; with twenty it is essentially the observed value.
 *
 * @param grades - percentage-grade statistics.
 * @returns the outcome part and the weight its sample size earns.
 */
export function gradeOutcomeSignal(grades: GradeStatistics, calibration: GradeCalibration): { part: GradeSignalPart; weight: number } {
  const samples = grades.validSampleCount;
  if (samples === 0 || grades.percentageAverage === undefined) {
    return {
      part: {
        sampleCount: 0,
        note: '没有可用的百分制成绩样本，成绩结果信号缺失',
      },
      weight: 0,
    };
  }
  const meanScore = gradeToFriendliness(grades.percentageAverage, calibration);
  const medianScore = grades.percentageMedian === undefined
    ? meanScore
    : gradeToFriendliness(grades.percentageMedian, calibration);
  const observed = (meanScore + medianScore) / 2;
  const reliability = samples / (samples + GRADE_OUTCOME_PRIOR_SAMPLES);
  const shrunk = 5.5 + (observed - 5.5) * reliability;
  return {
    part: {
      score: Number(shrunk.toFixed(4)),
      sampleCount: samples,
      note: `百分制均值 ${grades.percentageAverage.toFixed(1)}、中位 ${(grades.percentageMedian ?? grades.percentageAverage).toFixed(1)}`
        + `（${samples} 条样本，其中低于及格线 ${grades.belowPassSampleCount} 条）→ 观测友好度 ${observed.toFixed(2)}，`
        + `按样本量收缩（w=${reliability.toFixed(2)}，先验 ${GRADE_OUTCOME_PRIOR_SAMPLES} 条）后为 ${shrunk.toFixed(2)}`,
    },
    weight: reliability,
  };
}

/** Build the text signal from `gradeFriendliness` mentions. */
export function gradeTextSignal(mentions: readonly AspectMention[], evidenceReviewCount?: number): GradeSignalPart {
  const mine = mentions.filter((mention) => mention.aspect === 'gradeFriendliness');
  if (mine.length === 0) {
    return {
      sampleCount: 0,
      note: '评价文本里没有提到给分（给分高/压分/平时分拉满 等），文本信号缺失',
    };
  }
  const positive = mine.filter((mention) => mention.polarity === 'positive').length;
  const negative = mine.length - positive;
  // Same smoothed shape as every other aspect, so the two signals are comparable:
  // strongest mention per review, averaged over the reviews that spoke.
  const weights = mine.map((mention) => (mention.polarity === 'positive' ? 1 : -1)
    * (mention.strength === 'strong' ? 1.5 : mention.strength === 'mild' ? 0.5 : 1));
  const strongest = weights.reduce((best, weight) => (Math.abs(weight) > Math.abs(best) ? weight : best), weights[0] ?? 0);
  const mean = strongest / 1.5;
  const score = Number((5.5 + 4.5 * Math.tanh(1.2 * mean)).toFixed(4));
  const reviews = evidenceReviewCount ?? mine.length;
  return {
    score,
    sampleCount: mine.length,
    note: `依据 ${reviews} 条给出给分评价的评论、合计 ${mine.length} 处提及`
      + `（正面 ${positive}、负面 ${negative}，最强信号 ${mean.toFixed(3)}，`
      + `关键词：${[...new Set(mine.map((mention) => mention.phrase))].join('、')}）`,
  };
}

/**
 * Combine the outcome and text signals.
 *
 * When only one signal exists it is used alone (a lone text signal is *not* a
 * reason to invent an outcome), and the applied weights say so.
 *
 * `calibration` is the institution's grade distribution. It is **required** and
 * has no default: the anchors decide how a published mark reads as
 * grade-friendliness, and hard-coding one campus's distribution here would make
 * the engine wrong for every other. The caller supplies it — the same shape as
 * `ranking`'s base preferences.
 *
 * @param grades - percentage-grade statistics.
 * @param mentions - aspect mentions from the review text.
 * @param evidenceCounts - the distinct TEXT and UNION review counts; see {@link GradeEvidenceCounts}.
 * @param calibration - ascending `[grade, friendliness]` anchors.
 * @returns the combined score plus both parts, the weights used, and the counts it was given.
 */
export function combineGradeSignals(
  grades: GradeStatistics,
  mentions: readonly AspectMention[],
  evidenceCounts: GradeEvidenceCounts,
  calibration: GradeCalibration,
): GradeFriendlinessSignal {
  const { part: outcome } = gradeOutcomeSignal(grades, calibration);
  /*
   * The TEXT count, never the union: this part describes what students said about marking, so telling it about reviews that published a
   * grade and said nothing would overstate its support.
   */
  const text = gradeTextSignal(mentions, evidenceCounts.text);
  const hasOutcome = outcome.score !== undefined;
  const hasText = text.score !== undefined;

  if (!hasOutcome && !hasText) {
    return { outcome, text, appliedWeights: { outcome: 0, text: 0 }, evidenceCounts };
  }
  if (hasOutcome && !hasText) {
    return { score: outcome.score, outcome, text, appliedWeights: { outcome: 1, text: 0 }, evidenceCounts };
  }
  if (!hasOutcome && hasText) {
    return { score: text.score, outcome, text, appliedWeights: { outcome: 0, text: 1 }, evidenceCounts };
  }
  const score = (outcome.score as number) * OUTCOME_WEIGHT + (text.score as number) * TEXT_WEIGHT;
  return {
    score: Number(score.toFixed(4)),
    outcome,
    text,
    appliedWeights: { outcome: OUTCOME_WEIGHT, text: TEXT_WEIGHT },
    evidenceCounts,
  };
}

/**
 * Overlay a combined grade score onto an aspect score list.
 *
 * ## What it replaces, and what it deliberately leaves alone
 *
 * `score` becomes the combined raw score, and `evidenceReviewCount` becomes the UNION count — the reviews backing this dimension from
 * *either* source. The aspect's own count only knew about the text half, so a course whose grades carried the evidence but whose prose
 * never mentioned marking reported zero evidence. That zero then reached `aspectReliability`, which returns 0 for no evidence, so
 * `decisionScore` shrank the combined score all the way back to neutral 5.5 — the outcome signal was computed and then discarded.
 *
 * `positiveReviewCount` / `negativeReviewCount` / `mixedReviewCount` are **not** touched: they express the *attitude* of the text, and a
 * published grade has no polarity. Recording a 95 as "a positive review" would be the strong-cohort-as-lenient-marker confusion this
 * module exists to avoid, so an outcome-only course keeps `directional = 0` and the reliability agreement term stays at its neutral
 * value.
 *
 * It also **retains the two halves** on `signalBreakdown`. They used to be folded into the `note`
 * prose and discarded, which meant a blended 7.87 could not be traced back to its 6.48 (grades) and
 * 9.25 (2 mentions) parts without parsing a sentence. The blend is now data.
 *
 * @param scores - aspect scores from {@link scoreAspects}.
 * @param signal - the combined grade signal.
 * @returns a new list with grade friendliness replaced when a score exists.
 */
export function withGradeSignal(scores: readonly AspectScore[], signal: GradeFriendlinessSignal): AspectScore[] {
  return scores.map((entry) => {
    if (entry.aspect !== 'gradeFriendliness') return entry;
    const breakdown: AspectSignalBreakdown = {
      ...(signal.outcome.score === undefined ? {} : {
        outcome: { score: signal.outcome.score, sampleCount: signal.outcome.sampleCount, note: signal.outcome.note },
      }),
      ...(signal.text.score === undefined ? {} : {
        text: { score: signal.text.score, sampleCount: signal.text.sampleCount, note: signal.text.note },
      }),
      appliedWeights: { ...signal.appliedWeights },
    };
    const merged: AspectScore = {
      ...entry,
      /*
       * The UNION, so the dimension reports how much evidence it really has. Never the text count: that would leave the outcome-only
       * case at zero and re-break the very path this function exists to fix.
       */
      evidenceReviewCount: signal.evidenceCounts.union,
      note: `${entry.note}；综合信号：${signal.appliedWeights.outcome}/${signal.appliedWeights.text}`
        + `（成绩结果权重/文本权重）。${signal.outcome.note}。${signal.text.note}`,
      signalBreakdown: breakdown,
    };
    if (signal.score !== undefined) merged.score = signal.score;
    return merged;
  });
}
