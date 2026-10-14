/**
 * Eligibility filtering, kept strictly separate from ranking.
 *
 * The rule this module enforces is a product decision, not a scoring nuance:
 * a course the student cannot get into must be *excluded*, and a course whose
 * seat count is merely unknown must be *kept* and flagged. Seat availability is
 * therefore never a term in the quality score.
 *
 * @module @course-copilot/core/eligibility
 */

import type {
  Availability,
  EligibilityDecision,
  NormalizedCourse,
  RankingPreferences,
} from './types/course.js';

/**
 * Derive availability from a seat count.
 *
 * @param remainingSeats - seats free, or undefined when the page did not say.
 * @returns `unknown` when the count is absent, `full` when it is `<= 0`, else
 *   `available`. A `0` is treated as full, but an absent value is never coerced
 *   to `0`.
 */
export function availabilityFromSeats(remainingSeats: number | undefined): Availability {
  if (remainingSeats === undefined || Number.isNaN(remainingSeats)) return 'unknown';
  return remainingSeats > 0 ? 'available' : 'full';
}

/** Does this course already carry a usable name for matching? */
function hasUsableName(course: NormalizedCourse): boolean {
  return course.normalizedName.length > 0 || course.courseCode !== undefined;
}

/**
 * Decide whether a course may enter ranking.
 *
 * @param course - normalized course from an adapter.
 * @param preferences - optional seat requirement.
 * @returns the decision with human-readable reasons; reasons are populated for
 *   both outcomes so a caller can explain why something was kept.
 */
export function evaluateEligibility(
  course: NormalizedCourse,
  preferences: RankingPreferences | undefined = undefined,
): EligibilityDecision {
  const reasons: string[] = [];
  let eligible = true;

  if (!hasUsableName(course)) {
    eligible = false;
    reasons.push('课程名称与课程号均为空，无法识别该课程');
  }

  if (course.availability === 'full') {
    /**
     * State only what was actually observed.
     *
     * The previous message asserted a sign it had not checked: `余量 ${remainingSeats}（<= 0）`. Measured on a
     * live selection page, a course arrived with `availability: 'full'` **and** `remainingSeats: 27`, so the
     * tool reported *"不可选：余量 27（<= 0）"* — a sentence that contradicts itself and tells the reader
     * nothing about which signal to trust.
     *
     * Three cases, and the third is the honest one:
     *
     * * a non-positive count agrees with the page, so it may be quoted as the reason;
     * * no count at all leaves the page's own marker as the only evidence;
     * * a **positive** count beside a full marker is a conflict. Neither value is discarded and neither is
     *   chosen: the reason reports both, so the reader can see the page is ambiguous instead of being handed
     *   a confident pick. Which signal is authoritative needs an observed expansion of the row, and is
     *   deliberately not decided here.
     *
     * The eligibility outcome is unchanged in all three cases — this is a reporting change only.
     */
    let detail: string;
    if (course.remainingSeats === undefined) {
      detail = '页面标记为已满';
    } else if (course.remainingSeats <= 0) {
      detail = `余量 ${course.remainingSeats}（<= 0）`;
    } else {
      detail = `页面状态标记为已满，但同时读取到余量 ${course.remainingSeats}；页面信息存在冲突`;
    }
    if (preferences?.requireAvailableSeats === false) {
      reasons.push(`已满但按偏好保留：${detail}`);
    } else {
      eligible = false;
      reasons.push(`不可选：${detail}`);
    }
  } else if (course.availability === 'unknown') {
    reasons.push('余量未知，未按已满处理（availability=unknown）');
  } else {
    reasons.push(`余量充足：${course.remainingSeats ?? '?'}`);
  }

  if (course.selectable === false) {
    eligible = false;
    reasons.push('页面显示该行不可选（selectable=false）');
  }

  return { course, eligible, reasons };
}

/**
 * Filter a course list, returning both the survivors and the rejected ones.
 *
 * @param courses - normalized courses.
 * @param preferences - optional seat requirement.
 * @returns the eligible courses and one decision per rejected course.
 */
export function filterEligible(
  courses: readonly NormalizedCourse[],
  preferences: RankingPreferences | undefined = undefined,
): { eligible: NormalizedCourse[]; excluded: EligibilityDecision[] } {
  const eligible: NormalizedCourse[] = [];
  const excluded: EligibilityDecision[] = [];
  for (const course of courses) {
    const decision = evaluateEligibility(course, preferences);
    if (decision.eligible) eligible.push(course);
    else excluded.push(decision);
  }
  return { eligible, excluded };
}
