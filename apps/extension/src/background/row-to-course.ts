/// <reference path="../types/chrome.d.ts" />

/**
 * The extension-local adapter from a scanned page row to a canonical course.
 *
 * ## Why this module exists rather than reusing the application's adapter
 *
 * The repository already has a canonical `toNormalizedCourse` in `src/adapters/table.ts`. It is browser-BUNDLEABLE — measured with
 * an esbuild browser probe, which resolved in six inputs with no Node coupling — but its closure reaches `src/core/parse.ts`,
 * `src/dom/html.ts` and `src/core/normalize.ts`. The extension has a hard boundary against depending on the application's `src/`
 * tree, enforced by several gates, so importing it is not an option and widening that boundary is not either.
 *
 * What remains is the small field mapping that is genuinely the extension's own: it decides nothing that the engine already
 * decides, and it reads no page itself.
 *
 * ## What it deliberately does not do
 *
 * It does not split teachers, dedupe sections, rank anything, filter by seats, or look up reviews. Each of those already has an
 * owner: `teacherNamesOfCourse` owns the teacher-splitting rules, the pipeline owns section identity, `filterEligible` owns
 * availability as an admission decision, and the provider owns reviews. A second implementation of any of them here would be a
 * second source of truth for the same question.
 *
 * @module
 */

import { normalizeCourseName, normalizeTeacherName } from '@course-copilot/core/normalize';
import { availabilityFromSeats } from '@course-copilot/core/eligibility';
import type { NormalizedCourse } from '@course-copilot/core/course';

/**
 * Convert one scanned teaching-class row into a canonical course.
 *
 * @param row - a row as the content script reports it.
 * @returns the canonical course, or `undefined` when the row names no course.
 */
export function rowIdentityToCourse(row: RowIdentity): NormalizedCourse | undefined {
  /*
   * The name is the identity, so a row without one is not a course.
   *
   * The scanner already guarantees a non-empty name — `parseHeading` drops a panel it cannot name and returns the name already
   * whitespace-normalized and trimmed — so this check is DEFENSIVE rather than a normal path. It is `undefined`-returning rather
   * than throwing because one unusable panel must not cost the caller every other row.
   *
   * The input type stays `RowIdentity`: `courseName` is required, so widening it to a partial shape would invent an input the
   * caller cannot actually produce.
   */
  const courseName = row.courseName.trim();
  if (courseName.length === 0) return undefined;

  const course: NormalizedCourse = {
    source: 'whu',
    courseName,
    normalizedName: normalizeCourseName(courseName),
    /*
     * Derived, never invented: `availabilityFromSeats` is the core's own rule, and calling it rather than restating it is what
     * keeps one answer to "is this course selectable". It maps `undefined` to `'unknown'`, which the eligibility stage KEEPS and
     * explains — an unstated seat count is not a full course.
     */
    availability: availabilityFromSeats(row.remainingSeats),
  };

  /*
   * Course code. The heading path already trims and whitespace-normalizes it, but the hidden-input fallback
   * (`kch_id`'s `value` attribute) is raw DOM text, so this is the one field where the scanner does NOT guarantee hygiene.
   * Trimming here is cheaper than a second scanner rule, and an all-whitespace code is omitted rather than written as empty —
   * the same treatment `parseHeading` gives it.
   *
   * Not copied to `sourceCourseId`: that field means "an id the source page exposes for the ROW", which this page does not.
   */
  if (row.courseCode !== undefined) {
    const courseCode = row.courseCode.trim();
    if (courseCode.length > 0) course.courseCode = courseCode;
  }

  /*
   * The teacher stays ONE string, exactly as the page published it — `周奕华、刘兴海` included.
   *
   * Splitting it here would discard `parseTeacher`'s rules (Latin full names are one person, several separators, non-name tokens
   * are not names at all), and that helper is what decides whether the review request carries an `instructor` filter. A second
   * split rule in this file is precisely how a co-taught class becomes silently unqueryable.
   */
  if (row.teacher !== undefined) {
    course.teacher = row.teacher;
    const normalizedTeacher = normalizeTeacherName(row.teacher);
    if (normalizedTeacher.length > 0) course.normalizedTeacher = normalizedTeacher;
  }

  /*
   * Credits are carried as a FACT and nothing else. They are not a filter, not a weight and not a tie-breaker: measured, nothing
   * in the engine reads them (`recommend`, `eligibility`, `ranking`, `confidence`, `matcher` all read `.credits` zero times).
   */
  if (row.credits !== undefined) course.credits = row.credits;

  /*
   * The seat count is kept as the page stated it, and is ALSO the input the availability above derives from. Both are correct and
   * they are not two meanings: this is a row-level fact, and availability is the admission reading of that same fact.
   *
   * There is deliberately NO competition conversion here. `roundQuota` in the presentation layer is documented as a rename of this
   * very number, so manufacturing one from the other would give a single value two identities — and eligibility currently reads
   * `remainingSeats` for its reason text, which stays as it is.
   */
  if (row.remainingSeats !== undefined) course.remainingSeats = row.remainingSeats;

  /*
   * The other row-level seat FACT, carried verbatim.
   *
   * UPDATED IN PRE-RELEASE-UX-A5. The boundary this comment has always stated still holds, and only its wording changes to stay
   * truthful now that a second raw seat number is preserved instead of being dropped: raw seat facts are carried individually, and
   * NO competition or risk interpretation is performed here. Nothing derives a ratio, a percentage, a tier or a comparison between
   * the two numbers — that decision belongs to a later layer that has not been written, and `competitionFacts` does not exist yet.
   *
   * `0` is carried as `0`: this is 本轮已选, not capacity, so it has no loading placeholder to discard.
   */
  if (row.selectedThisRound !== undefined) course.selectedThisRound = row.selectedThisRound;

  return course;
}

/**
 * Convert a scanned page into canonical courses, preserving one candidate per row.
 *
 * Map and drop unusable rows. Nothing else: no dedupe, no aggregation and no ordering, because one row is one teaching-class
 * SECTION and the section count is the row count. Two classes of the same course are two candidates that may share a review
 * lookup — a decision the pipeline makes, not this function.
 *
 * @param rows - the rows the content script reported.
 * @returns the courses that could be built, in the order they were given.
 */
export function rowIdentitiesToCourses(rows: readonly RowIdentity[]): NormalizedCourse[] {
  return rows
    .map((row) => rowIdentityToCourse(row))
    .filter((course): course is NormalizedCourse => course !== undefined);
}
