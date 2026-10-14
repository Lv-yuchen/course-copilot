/**
 * Core algorithm tuning.
 *
 * These numbers are behaviour, not preference: they are read by the matcher and the confidence model
 * and are what make the engine reproducible. They belong in the package because they encode the
 * domain's semantics, not because a host happens to import them.
 *
 * Deliberately **not** here: user-facing defaults, tool payload bounds and review-transport settings.
 * Those stay in the application's own config module, which re-exports these nine so every existing
 * `from '../config.js'` import keeps resolving. See `docs/config-ownership-audit.md` for how the
 * split was decided.
 *
 * @module @course-copilot/core/config
 */

import type { ReviewMetricKey } from './types/course.js';

/**
 * Minimum match confidence for a review record to be treated as the same course.
 *
 * Below this the engine refuses the binding and reports `match.trusted: false`
 * instead of attaching possibly-wrong data.
 */
export const REVIEW_MATCH_THRESHOLD = 0.72;

/** Confidence `value` at or above which the tier is `high`. */
export const CONFIDENCE_HIGH = 0.75;

/** Confidence `value` at or above which the tier is `medium` (below is `low`). */
export const CONFIDENCE_MEDIUM = 0.45;

/**
 * Confidence weights for the five review-evidence components.
 *
 * There is deliberately **no recency weight**: whucourses.cn publishes no review
 * date, so a recency term would be a constant pretending to be information. Every
 * component that cannot be computed is dropped and the rest renormalized.
 */
export const CONFIDENCE_WEIGHTS = {
  /** Is this the same course? (from the matcher) */
  matching: 0.3,
  /** How much evidence backs the scope actually used. */
  evidence: 0.3,
  /** Does the corpus agree about the teacher? */
  teacherAgreement: 0.15,
  /** How many of the six aspects had any evidence. */
  aspectCoverage: 0.15,
  /** How much of the teacher column was parseable. */
  dataHygiene: 0.1,
} as const;

/** Multiplicative confidence penalty when scoring fell back to course level. */
export const CONFIDENCE_FALLBACK_PENALTY = 0.6;

/** Multiplicative confidence penalty when the course matched through an alias. */
export const CONFIDENCE_ALIAS_PENALTY = 0.85;

/**
 * Evidence volume at which the confidence gate stops biting: `sqrt(n / this)`.
 *
 * The gate makes volume a *ceiling* on confidence rather than one term among
 * several, because otherwise a single review reaches "medium" on the strength of
 * a good name match — which describes the binding, not the evidence.
 */
export const EVIDENCE_GATE_SATURATION = 8;

/** Half-life-ish constant for the review-count saturation curve. */
export const REVIEW_COUNT_SATURATION = 20;

/** Metric keys in a fixed order, so every output has stable key ordering. */
export const METRIC_KEYS: readonly ReviewMetricKey[] = [
  'gradeFriendliness',
  'workloadFriendliness',
  'attendanceFriendliness',
  'overallScore',
] as const;

