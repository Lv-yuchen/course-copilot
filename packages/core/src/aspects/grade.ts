/**
 * Grade-to-friendliness: the pure mapping from a published mark to a `0..10` reading.
 *
 * ## Why this is separate from the text layer
 *
 * This is arithmetic over a caller-supplied anchor table. It touches no review text, no lexicon, no
 * negation and no provider field — it takes a number and a distribution and returns a number. It lived
 * in the text-signal module only because the text layer happened to be where grade handling started.
 *
 * ## Why the anchors are an argument
 *
 * The anchors encode an **institution's** grade distribution, not an algorithm constant. The observed
 * WHU distribution is strongly skewed high (median ≈ 90), so a 90 is "normal" there rather than
 * "excellent" and the scale only saturates at 96+. A campus where 75 is a good mark needs different
 * anchors. So the table is required and has no default: the same reasoning that keeps default weights
 * out of the ranking algorithm.
 *
 * @module @course-copilot/core/aspects/grade
 */

import type { GradeCalibration } from './types.js';

/**
 * Map a published numeric grade onto grade friendliness.
 *
 * Piecewise linear over the supplied anchors: below the first grade the first friendliness applies,
 * above the last grade the last one does, and in between the value is linearly interpolated. A
 * non-finite grade reads as `0`.
 *
 * @param grade - mean or median grade on the original `0..100` scale.
 * @param calibration - ascending `[grade, friendliness]` anchors, at least two.
 * @returns `0..10` friendliness.
 */
export function gradeToFriendliness(grade: number, calibration: GradeCalibration): number {
  const anchors = calibration;
  if (!Number.isFinite(grade)) return 0;
  const first = anchors[0] as readonly [number, number];
  if (grade <= first[0]) return first[1];
  const last = anchors[anchors.length - 1] as readonly [number, number];
  if (grade >= last[0]) return last[1];
  for (let index = 1; index < anchors.length; index += 1) {
    const [rightX, rightY] = anchors[index] as readonly [number, number];
    const [leftX, leftY] = anchors[index - 1] as readonly [number, number];
    if (grade <= rightX) {
      const ratio = (grade - leftX) / (rightX - leftX);
      return Number((leftY + ratio * (rightY - leftY)).toFixed(4));
    }
  }
  return last[1];
}
