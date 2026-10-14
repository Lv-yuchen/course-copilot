/// <reference path="../types/chrome.d.ts" />

/**
 * The composed page-reading capability: ask a tab for its rows, then turn them into canonical courses.
 *
 * ## What this module is for
 *
 * `requestVisibleRows` owns the transport (one message, one shape check, failures become an empty list) and
 * `rowIdentitiesToCourses` owns the mapping (one row is one section candidate). This composes the two so a caller has a single
 * step from "a tab" to "the courses on it", without either component having to know about the other.
 *
 * ## What it is NOT
 *
 * It stops at courses. It does not rank, score, filter, look up reviews or run the recommendation engine — that is a separate
 * capability with its own policy binding, and composing it here would silently join two stages that are deliberately kept
 * separable. This module names no recommendation symbol at all, which is what makes that separation checkable.
 *
 * It also holds no state: no cache, no worker memory, no `Map`. Every call asks the page and maps the answer, so a remembered
 * row can never be mistaken for a current one.
 *
 * @module
 */

import type { NormalizedCourse } from '@course-copilot/core/course';
import { rowIdentitiesToCourses } from './row-to-course.js';
import { requestVisibleRows } from './visible-rows.js';

/** What one read of a tab produced, with both counts kept so they cannot be confused. */
export interface VisibleCoursesSnapshot {
  /** How the ask went; see {@link VisibleRowsSnapshot.read}. */
  readonly read: 'ok' | 'unavailable' | 'malformed';
  /** The content script's page verdict, when it answered. */
  readonly supported?: boolean;
  /** The page's own completeness signal, when the script reported one. */
  readonly loadState?: CourseListLoadState;
  /**
   * Rows the content script reported.
   *
   * Kept beside {@link courses} rather than summarised into it, because the two disagree in a case worth telling apart: DOM rows that exist but
   * cannot be mapped. Reporting only the courses would make "one unreadable row" and "no rows at all" the same answer.
   */
  readonly rowCount: number;
  /** Rows that became a canonical course. */
  readonly courseCount: number;
  /** The mapped courses, in page order. */
  readonly courses: NormalizedCourse[];
}

/**
 * Read one tab's loaded teaching-class rows and convert them into canonical courses.
 *
 * The transport's verdict is carried through UNCHANGED rather than collapsed: this function reports how the ask went, what the page said about
 * itself, how many rows arrived and how many became courses. It still does not invent an error object, and it still does not decide what any of
 * this means for a recommendation — that judgement belongs to the caller, which is the only layer that knows what it is trying to show.
 *
 * Mapping is unchanged: `rowIdentitiesToCourses` owns it, and a row it refuses simply does not appear in `courses`. The row is still counted in
 * `rowCount`, so a refusal is visible rather than silent.
 *
 * @param tabId - the tab to read. Accepted as `unknown` because it arrives from a message.
 * @returns the snapshot: the ask's outcome, the page verdict when there was one, both counts, and the courses.
 */
export async function requestVisibleCourses(tabId: unknown): Promise<VisibleCoursesSnapshot> {
  // Transport, then mapping. Both are delegated, neither is repeated.
  const snapshot = await requestVisibleRows(tabId);
  const courses = rowIdentitiesToCourses(snapshot.rows);
  return {
    read: snapshot.read,
    ...(snapshot.supported === undefined ? {} : { supported: snapshot.supported }),
    ...(snapshot.loadState === undefined ? {} : { loadState: snapshot.loadState }),
    rowCount: snapshot.rows.length,
    courseCount: courses.length,
    courses,
  };
}
