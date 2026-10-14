/**
 * Aspect-based review analysis: the data model.
 *
 * A student review is not one sentiment label. A single sentence routinely
 * carries several independent judgements — `老师讲得很好，但是作业特别多，而且考试很难`
 * is praise for teaching, a complaint about workload, and a warning about the
 * exam — and collapsing it into one number loses exactly the information a course
 * chooser needs. Everything here exists to keep those judgements separate,
 * reproducible, and explainable.
 *
 * @module @course-copilot/core/aspects
 */

/**
 * The dimensions a review can speak to.
 *
 * `gradeFriendliness`, `workloadFriendliness`, and `attendanceFriendliness` back
 * the existing four-metric ranking API. `examFriendliness`, `teachingQuality`,
 * and `studentSentiment` are Phase 2 additions surfaced through evidence first —
 * the ranking weights are unchanged until a later phase decides otherwise.
 */
export type AspectKey =
  | 'gradeFriendliness'
  | 'workloadFriendliness'
  | 'attendanceFriendliness'
  | 'examFriendliness'
  | 'teachingQuality'
  | 'studentSentiment';

/** Every aspect, in a stable order so outputs are byte-identical run to run. */
export const ASPECT_KEYS: readonly AspectKey[] = [
  'gradeFriendliness',
  'workloadFriendliness',
  'attendanceFriendliness',
  'examFriendliness',
  'teachingQuality',
  'studentSentiment',
] as const;

/** Which way a phrase points for its aspect. */
export type Polarity = 'positive' | 'negative';

/** How strongly a phrase points, before negation or overlap rules apply. */
export type Strength = 'strong' | 'normal' | 'mild';

/** Numeric weight of each strength, so scoring is one lookup and one sum. */
export const STRENGTH_WEIGHT: Record<Strength, number> = {
  strong: 1.5,
  normal: 1,
  mild: 0.5,
};

/**
 * The physical format of the final assessment, when the text states one.
 *
 * Deliberately separate from difficulty: `闭卷` describes *how* the exam is run,
 * not how hard it is. Treating the format as a difficulty signal made every
 * closed-book course look brutal, which is why format is recorded as provenance
 * and never scored on its own.
 */
export type ExamFormat =
  | 'closed_book'
  | 'open_book'
  | 'paper'
  | 'presentation'
  | 'no_exam'
  | 'unknown';

/** Every exam format, in a stable order for deterministic output. */
export const EXAM_FORMATS: readonly ExamFormat[] = [
  'no_exam',
  'open_book',
  'closed_book',
  'paper',
  'presentation',
  'unknown',
] as const;

/**
 * One lexicon rule.
 *
 * Every rule states its own aspect and polarity, so the same surface phrase can
 * legitimately appear twice with different meanings — `水` is positive for
 * workload and negative for teaching quality, and modelling that as one
 * "sentiment" would be wrong.
 */
export interface LexiconEntry {
  /** The surface phrase to find, exactly as students write it. */
  phrase: string;
  /** Which dimension this phrase speaks to. */
  aspect: AspectKey;
  /** Which direction it points. */
  polarity: Polarity;
  /** How strongly it points; defaults to `normal` when omitted. */
  strength?: Strength;
  /**
   * True when the phrase is *already* negated in its surface form (`不签到`,
   * `无考试`), so a preceding `不` must not flip it a second time.
   */
  preNegated?: boolean;
  /** Optional note for reviewers of the lexicon. */
  note?: string;
  /**
   * For `examFriendliness` rules only: the phrase states a **format**, not a
   * difficulty. Format evidence is counted as provenance and never scored, so
   * `闭卷` cannot make a course look hard on its own.
   */
  formatOnly?: boolean;
}

/** One lexicon hit, with its position so overlaps can be resolved. */
export interface AspectMention {
  aspect: AspectKey;
  polarity: Polarity;
  strength: Strength;
  /** The surface phrase that matched. */
  phrase: string;
  /** The phrase as it appeared, including surrounding negation when applied. */
  surface: string;
  /** Character offset of the match in the analysed text. */
  index: number;
  /** True when a negation prefix flipped the rule's polarity. */
  negated: boolean;
  /** True when the rule states an exam *format* rather than a difficulty. */
  formatOnly?: boolean;
  /** The format this mention reported, for `formatOnly` mentions. */
  format?: ExamFormat;
}

/**
 * Per-aspect result.
 *
 * ## Score is a direction; counts are confidence inputs
 *
 * `score` is `0..10`, higher always better for the student, and is derived from
 * the **mean per-review signal** — not from the number of mentions. Adding
 * reviews that agree raises confidence, not extremity, so three glowing reviews
 * and three hundred glowing reviews land on the same score. `undefined` means the
 * text offered no usable evidence for that aspect — never `0`, so a missing
 * dimension can be redistributed instead of dragging a course down.
 *
 * `sampleCount` and the `*Mentions` fields count **mentions**; the `*ReviewCount`
 * fields count **reviews that carry them**. A student who writes `很好，非常好`
 * contributes one review, not two votes.
 */
export interface AspectScore {
  aspect: AspectKey;
  score?: number;
  /** Reviews that carried any evidence for this aspect. */
  evidenceReviewCount: number;
  /** Total surface mentions across those reviews. */
  mentionCount: number;
  /** Reviews whose net signal for this aspect was positive. */
  positiveReviewCount: number;
  /** Reviews whose net signal for this aspect was negative. */
  negativeReviewCount: number;
  /** Reviews that carried both directions for this aspect. */
  mixedReviewCount: number;
  /** Review-level mean signal in `-1..1`, the input the score is mapped from. */
  rawMeanSignal?: number;
  /** Positive-polarity mentions. */
  positiveMentions: number;
  /** Negative-polarity mentions. */
  negativeMentions: number;
  /** Retained alias of {@link mentionCount} for existing callers. */
  sampleCount: number;
  matchedTerms: string[];
  /** How the score was produced, in words, for `course_explain` to quote. */
  note: string;
  /**
   * The constituent signals behind {@link score}, when more than one was blended.
   *
   * Today only `gradeFriendliness` uses this: its score is a **50/50 blend** of the published grade
   * distribution and what students say about marking, and those two halves routinely rest on very
   * different sample sizes — measured on a real corpus, 9 grade samples against **2** text mentions.
   *
   * Without this field the two halves collapse into one number and the blend ratio is recoverable only
   * by reading the prose in {@link note}. Reporting a blended figure as though it were a single
   * measurement is misleading, so the parts are carried as data.
   *
   * Optional and additive: absent for every aspect that is not a blend.
   */
  signalBreakdown?: AspectSignalBreakdown;
}

/** One constituent signal of a blended aspect score. */
export interface AspectSignalPart {
  /** `0..10`, or absent when this signal had no evidence. */
  score?: number;
  /** Observations behind this signal — grades for the outcome half, reviews for the text half. */
  sampleCount: number;
  /** How this half was derived, for the explanation to quote. */
  note: string;
}

/**
 * A blended score's parts, so the explanation can show which one drove the result.
 *
 * `appliedWeights` are the weights actually used, which are `1/0`, `0/1` or `0.5/0.5` — never an
 * interpolated ratio — because a half with no evidence is dropped rather than weighted down.
 */
export interface AspectSignalBreakdown {
  /** The objective half: published grades. Present only when grade samples existed. */
  outcome?: AspectSignalPart;
  /** The subjective half: what students wrote about marking. */
  text?: AspectSignalPart;
  /** Weights actually applied to the two halves; sums to 1 when both exist. */
  appliedWeights: { outcome: number; text: number };
}

/** Per-review aspect breakdown, keeping the multi-label nature visible. */
export interface ReviewAspects {
  /** Aspects this review expressed at least one opinion about. */
  aspects: Partial<Record<AspectKey, { positive: number; negative: number }>>;
  /** True when the review carried both positive and negative evidence. */
  mixed: boolean;
  /** All mentions, in text order. */
  mentions: AspectMention[];
  /**
   * This review's bounded `-1..1` signal per aspect.
   *
   * Multiple mentions of one aspect inside one review are combined here, so a
   * review cannot outweigh another just by being repetitive.
   */
  signals: Partial<Record<AspectKey, number>>;
  /** The assessment format this review stated, when it stated one. */
  examFormat?: ExamFormat;
}

/** Aggregate aspect analysis of a set of reviews. */
export interface AspectAnalysis {
  /** Scores per aspect, in {@link ASPECT_KEYS} order. */
  scores: AspectScore[];
  positiveMentions: number;
  negativeMentions: number;
  /** Reviews that carried both positive and negative evidence. */
  mixedReviewCount: number;
  /** Reviews that carried any evidence at all. */
  coveredReviewCount: number;
  /** Reviews analysed. */
  reviewCount: number;
  /** How often each assessment format was stated, over all reviews. */
  examFormats: Record<ExamFormat, number>;
}

/** One aspect's raw/decision pair, with the provenance for both. */
export interface AspectDecision {
  aspect: AspectKey;
  /** The centre estimate from the text, `0..10`. Absent when no evidence. */
  raw?: number;
  /** How much the evidence supports this aspect, `0..1`. */
  reliability: number;
  /** `NEUTRAL_SCORE + reliability × (raw - NEUTRAL_SCORE)`. */
  decision?: number;
  /** Weight actually applied after renormalizing onto the available aspects. */
  weight: number;
  /** `weight × decision`, when a decision exists. */
  contribution?: number;
  evidenceReviewCount: number;
  mentionCount: number;
  matchedTerms: string[];
}

/** The full per-course decision breakdown. */
export interface AspectBreakdown {
  aspects: AspectDecision[];
  /** Weighted decision score, or `null` when no aspect had evidence. */
  decisionScore: number | null;
  /** Weights after renormalizing onto the available aspects. */
  appliedWeights: Partial<Record<AspectKey, number>>;
  /** Aspects the caller weighted but that had no usable data. */
  missingDimensions: AspectKey[];
  /** Human-readable notes about renormalization, for the user. */
  notes: string[];
}

/**
 * Interpolation anchors mapping a published grade onto grade friendliness.
 *
 * Ascending `[grade, friendliness]` pairs with at least two entries: below the first grade the first
 * friendliness applies, above the last grade the last one does, and in between the value is linearly
 * interpolated.
 *
 * This is an **institution's** grade distribution, not an algorithm constant. A campus whose grades
 * cluster near 90 needs different anchors from one where 75 is a good mark, so the table is supplied by
 * the caller rather than defaulted here — the same reasoning that keeps default weights out of the
 * ranking algorithm.
 */
export type GradeCalibration = readonly (readonly [number, number])[];
