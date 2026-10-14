/**
 * The review-provider contract.
 *
 * A provider knows one review site and nothing else. In particular it must not know anything about a university's selection
 * system: it receives a search query and returns normalized review records.
 *
 * This module is provider-GENERIC: nothing here names a particular site. It lives in `@course-copilot/provider` because it is
 * the contract every provider in this package implements, and because a consumer of a provider needs these types without
 * reaching into the application that happens to use one.
 *
 * @module @course-copilot/provider/types
 */

import type { CourseLevelReview, CourseReview, ReviewExcerpt, ReviewSourceHealth } from '@course-copilot/core/course';

/** What a provider is asked for. */
export interface CourseSearchQuery {
  /** Course name as it appeared on the selection page. */
  courseName: string;
  /**
   * The value to send as the site's teacher filter, when the selection page named exactly ONE teacher.
   *
   * This is what goes on the wire, so it must stay a single person's name. A co-taught or unusable cell must leave it unset
   * rather than send a list of people: the filter is a substring match over a column holding one teacher per review row, so a
   * published list can match nothing and the class silently loses all of its reviews.
   */
  teacher?: string;
  /**
   * The selection page's COMPLETE teacher list for this teaching class, for local use only.
   *
   * Deliberately separate from {@link teacher}, because the two are not the same value and must not be conflated: `teacher` is
   * a wire filter narrowed to one person, while this is the full published set (`翟显、廖冬梅、…`). A provider needs the set
   * to decide which returned rows are related to the class, and it must never put this on the wire.
   */
  localTeacherNames?: readonly string[];
  /** Course code, when available. Most review sites do not index it. */
  courseCode?: string;
  /** Maximum records to return. */
  limit?: number;
  /** Abort signal. */
  signal?: AbortSignal;
}

/** Outcome of one provider search, including what the provider actually did. */
export interface ReviewSearchResult {
  /** Candidate review records, best-effort ordered by relevance. */
  reviews: CourseReview[];
  /**
   * Course-level roll-up over **every** row of the course, when the provider can produce one. Present only for a name-only
   * search: a teacher-scoped search already names the person, so the roll-up would restate its rows.
   *
   * `reviews` is capped for presentation; this is not, which is exactly why the two must travel together.
   */
  courseLevel?: CourseLevelReview;
  /**
   * The CURRENT teaching class's own evidence: rows related to its teachers, each counted once.
   *
   * Present only when the query carried `localTeacherNames`. It is NOT `courseLevel` — that one covers the whole course and
   * therefore includes teachers outside this class — and it is not derived from the teacher buckets either, whose counts
   * overlap because a co-taught row belongs to several of them.
   *
   * Absent means "the selection page did not name this class's teachers", so no related set can be defined. It never means
   * "this class has no reviews".
   */
  teachingClassLevel?: CourseLevelReview;
  /**
   * Rows that name no usable teacher, kept as course-level evidence.
   *
   * These belong to the course but cannot be attributed to a person, so they are held apart rather than folded into the
   * class's total or into any teacher's bucket.
   */
  courseSupplementary?: CourseLevelReview;
  /**
   * Bounded, already-attributed student comments for this course, best evidence first.
   *
   * ## Why the provider produces these and nothing downstream may
   *
   * Which rows relate to the current teaching class is teacher matching, and the provider is where that decision is made and
   * verified. This field is that decision PROJECTED outward, so the engine, the panel and the renderer never have to ask the
   * question again — and cannot answer it differently from the partition the numbers were computed over.
   *
   * Contains at most `MAX_REVIEW_EXCERPTS` entries, each at most `MAX_REVIEW_EXCERPT_CHARS` code points, never empty, already
   * de-duplicated, and carrying no raw payload, no grade cell, no score and no identifier.
   *
   * Optional on this interface, and an absent value means "this provider does not produce excerpts" — an injected fake in a test,
   * for instance. The ENGINE normalises absent to an empty array before publishing, so every consumer of a recommendation sees a
   * real array rather than a maybe.
   */
  reviewExcerpts?: ReviewExcerpt[];
  /** Provider id. */
  provider: string;
  /** Whether the answer came from cache. */
  fromCache: boolean;
  /** Non-fatal issues worth surfacing. */
  warnings: string[];
  /**
   * How this search's own sub-queries ended, when the caller tracked them.
   *
   * A teacher-scoped search can be more than one request, so "this call returned" can hide a request that failed. `warnings` describes problems
   * for a human to read; this is the machine-readable counterpart a caller may branch on without parsing text.
   *
   * Optional because a provider answering in one request has nothing finer to report.
   */
  reviewSource?: ReviewSourceHealth;
}

/** A source of course review data. */
export interface ReviewProvider {
  /** Stable provider id, e.g. `whucourses`. */
  readonly id: string;
  /** Human label, e.g. `WHU 课程评价 (whucourses.cn)`. */
  readonly label: string;
  /** Home page a human can open. */
  readonly homepage: string;
  /** Whether the provider is currently usable (e.g. its host is reachable). */
  isAvailable(): Promise<boolean>;
  /**
   * Search for review records matching a course.
   *
   * @param query - the search query.
   * @returns candidates plus provenance; must not throw for an empty result.
   */
  searchCourse(query: CourseSearchQuery): Promise<ReviewSearchResult>;
  /**
   * Course-level roll-up over every row of one course name.
   *
   * Optional because not every provider has a course-level notion. A provider that implements it must scope the fetch by course
   * name **only** — never by teacher — so a course total cannot depend on which teacher was asked about.
   *
   * @param courseName - the published course name.
   * @param signal - caller abort signal.
   * @returns the roll-up, or `undefined` when the provider has no rows for it.
   */
  aggregateForCourse?(courseName: string, signal?: AbortSignal): Promise<CourseLevelReview | undefined>;
  /** Release any resources (timers, handles). */
  dispose?(): Promise<void>;
}

/** Why a provider call failed. */
export class ReviewProviderError extends Error {
  readonly code: string;
  readonly provider: string;
  readonly status?: number;

  constructor(provider: string, code: string, message: string, status?: number) {
    super(message);
    this.name = 'ReviewProviderError';
    this.provider = provider;
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/**
 * Project a course-level roll-up into the {@link CourseReview} shape, so the existing matcher, scorer, and explainer can consume
 * it unchanged.
 *
 * The projection carries no `teacher`, which is the whole point: nothing downstream can attribute this data to a person.
 *
 * It lives in the provider contract rather than in a provider implementation because it is a pure field-by-field projection
 * between two domain types — both declared in `@course-copilot/core/course`. No provider-specific field, network call, or runtime
 * state is involved, so a second provider needs exactly the same conversion. Keeping it here is what lets the recommendation
 * pipeline depend on the contract alone instead of on one concrete provider.
 *
 * @param course - the course-level roll-up.
 * @returns a teacher-less review record.
 */
export function courseLevelAsReview(course: CourseLevelReview): CourseReview {
  const review: CourseReview = {
    provider: course.provider,
    courseName: course.courseName,
    normalizedName: course.normalizedName,
    reviewCount: course.courseReviewCount,
    courseReviewCount: course.courseReviewCount,
    matchedTeacherReviewCount: 0,
    gradedSampleCount: course.grades.validSampleCount,
    ambiguousGradeSampleCount: course.grades.ambiguousSampleCount,
    invalidGradeSampleCount: course.grades.invalidSampleCount,
    belowPassSampleCount: course.grades.belowPassSampleCount,
    gradeDistribution: course.grades.percentageDistribution,
    gradeScale: 'percentage',
    aggregateScope: 'course',
  };
  if (course.gradeFriendliness !== undefined) review.gradeFriendliness = course.gradeFriendliness;
  if (course.workloadFriendliness !== undefined) review.workloadFriendliness = course.workloadFriendliness;
  if (course.attendanceFriendliness !== undefined) review.attendanceFriendliness = course.attendanceFriendliness;
  if (course.overallScore !== undefined) review.overallScore = course.overallScore;
  if (course.meanGrade !== undefined) review.meanGrade = course.meanGrade;
  if (course.medianGrade !== undefined) review.medianGrade = course.medianGrade;
  if (course.sourceUrl !== undefined) review.sourceUrl = course.sourceUrl;
  // Provenance travels with the projection, otherwise a course-level result would be the one aggregate with no auditable rows
  // behind it.
  if (course.sampleRows !== undefined) review.sampleRows = course.sampleRows;
  /*
   * The aspect analysis must travel too, and this line was missing.
   *
   * The four scalar metrics above are the *legacy* four-metric surface. The decision layer ranks on `aspects`, so a roll-up
   * projected without them reached `buildAspectBreakdown` empty: measured on a 254-review course-level aggregate, the lookup
   * produced `decisionScore: null` with **0 of 4** aspects carrying evidence and all four reported as `missingDimensions` — for
   * a course with six aspects of real data behind it.
   *
   * The observable symptom was that `course_explain` reported *"评价记录存在，但没有任何可用的评分维度"* for multi-teacher courses
   * reached by name, while `course_recommend` scored the same course fine (it resolves a teacher bucket, which carries its own
   * aspects). So the defect was confined to the explain path — but it made exactly the courses the user is most likely to ask
   * about unexplainable.
   *
   * The reference is carried across rather than deep-copied, which is what this projection already does for `grades` and
   * `sampleRows`: `AspectAnalysis` is a read-only value rebuilt per aggregate, and the caller receives a `CourseReview` with no
   * other route back to the `CourseLevelReview`.
   */
  if (course.aspects !== undefined) review.aspects = course.aspects;
  return review;
}
