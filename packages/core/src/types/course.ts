/**
 * Canonical data model for the course-selection copilot.
 *
 * Every adapter and provider normalizes into these shapes, so the matching,
 * eligibility, ranking, and confidence stages never depend on a particular
 * university's page markup or a particular review site's wire format.
 *
 * Scale convention: every `*Friendliness`/`*Score` metric is `0..10` and higher
 * is always BETTER for the student. A provider that receives a
 * "difficulty = 8" style metric must invert it during normalization and say so
 * in its own module, never here.
 *
 * @module course-selection-copilot/types
 */

import type { AspectAnalysis, AspectBreakdown, AspectKey } from '../aspects/types.js';

/** Identifier of a selection-system adapter, e.g. `whu` or `generic`. */
export type AdapterId = string;

/** Identifier of a review provider, e.g. `whucourses`. */
export type ProviderId = string;

/**
 * Availability of a course, kept strictly separate from course quality.
 *
 * `unknown` is a first-class state: an adapter that cannot see a seat count must
 * never report `0`, because that would silently filter a real course out.
 */
export type Availability = 'available' | 'full' | 'unknown';

/** One normalized course taken from a selection system page. */
export interface NormalizedCourse {
  /** Adapter id that produced this course. */
  source: AdapterId;
  /** Stable id from the source page when it exposes one (row id, value id, ...). */
  sourceCourseId?: string;
  /** University course code, e.g. `2024101234567` or `MATH101`. */
  courseCode?: string;
  /** Course name exactly as the page showed it; never mutated. */
  courseName: string;
  /** Matching-friendly form of {@link courseName}, produced by `normalizeCourseName`. */
  normalizedName: string;
  /** Teacher/instructor name as shown. */
  teacher?: string;
  /** Normalized teacher name used for matching. */
  normalizedTeacher?: string;
  /** Department / college / school. */
  department?: string;
  /** Credits, when the page states them. */
  credits?: number;
  /** Seats still free. Absent when the page does not state it. */
  remainingSeats?: number;
  /**
   * How many students had already signed up for this teaching class in the current round.
   *
   * WHU publishes this as 「本轮已选」 / 「本轮次已选人数」. It is NOT the course's total enrolment and NOT capacity, and the
   * three must never be conflated. A raw course FACT: it takes no part in scoring, ranking, confidence or availability.
   *
   * `0` is a real value meaning "nobody has signed up yet" and is preserved as `0`. Absent means the page did not state it.
   */
  selectedThisRound?: number;
  /** Total capacity. Absent when the page does not state it. */
  capacity?: number;
  /** Human-readable schedule entries, e.g. `["周一 3-4节 1区-教5-203"]`. */
  schedule?: string[];
  /** Derived availability. Always present so downstream code has no ambiguity. */
  availability: Availability;
  /** Whether the page presented the row as selectable at all. */
  selectable?: boolean;
  /** Free-text notes the adapter judged useful (status column, remarks, ...). */
  notes?: string[];
  /** Page identity this course was extracted from, for provenance. */
  sourcePage?: PageIdentity;
  /** Untouched source record for debugging and `course_debug_page`. */
  raw?: unknown;
}

/** Identifies the page a value came from. */
export interface PageIdentity {
  /** Page URL when known. */
  url?: string;
  /** Page title when known. */
  title?: string;
  /** Adapter that claimed the page. */
  adapter?: AdapterId;
  /** ISO-8601 instant at which the page was read. */
  capturedAt: string;
  /** How the page content reached the adapter. */
  via?: string;
}

/** A single review row exactly as a review site published it. */
export interface RawReviewRow {
  /** Provider that produced the row. */
  provider: ProviderId;
  /** Course name as published. */
  courseName: string;
  /** Teacher as published, when the site states one. */
  teacher?: string;
  /** Free-text review body. */
  content?: string;
  /** Free-text final-assessment description. */
  assessment?: string;
  /** Free-text attendance/homework description. */
  attendance?: string;
  /** Grade exactly as published, possibly `"未知"`, `""`, or garbage. */
  grade?: string;
  /** Course attribute/category as published. */
  courseAttribute?: string;
  /** Elective field as published. */
  electiveField?: string;
  /** Publication date/time in ISO-8601 when the site exposes one. */
  publishedAt?: string;
  /** Untouched row. */
  raw: unknown;
}

/**
 * How usable a row's `teacher` cell is.
 *
 * The upstream corpus is free text entered by students, and some rows put a
 * whole comment in the teacher column. Those rows are **not discarded** — their
 * text stays as course-level evidence — but they must never create a teacher
 * bucket or count toward teacher-level statistics.
 *
 * `valid_multiple` is not an error: co-taught courses are real, and the row
 * belongs to every named teacher. It is kept separate from `valid` so a caller
 * that can only reason about one teacher knows to treat it as joint teaching
 * rather than as a single person.
 */
export type TeacherValidity = 'valid' | 'valid_multiple' | 'missing' | 'malformed';

/**
 * Which slice of a course's review corpus an excerpt came from.
 *
 * These three names are the provider's OWN partition of the corpus, projected outward. They are deliberately not derived from
 * the review text, and no other layer may re-derive them: deciding which rows relate to the current teaching class is teacher
 * matching, and teacher matching lives in one place.
 *
 * - `current_class` — rows related to the current teaching class's teachers. For a co-taught class this INCLUDES rows naming
 *   only one of them, because partial overlap is agreement ({@link teacherSetRelation}). The scope therefore says which BUCKET
 *   a row was filed in; it does not say that the row is about every teacher of the class. Read {@link ReviewExcerpt.teacherNames}
 *   for who a row actually named.
 * - `course_reference` — rows naming valid teachers, none of whom is in the current class's set. This includes the case where
 *   the class's teachers are unknown, so it means "not attributed to this class", NOT "attributed to someone else".
 * - `supplementary` — rows whose teacher cell was missing or unusable. They are course evidence that names nobody.
 */
export type ReviewExcerptScope = 'current_class' | 'course_reference' | 'supplementary';

/**
 * One bounded, literal student comment, already attributed by the provider.
 *
 * ## Why this is not a `CleanReview`
 *
 * A `CleanReview` carries the untouched provider payload, the raw grade cell, the assessment and attendance cells and the full
 * comment. Shipping those to a renderer would put ~17x the bytes across the extension's message boundary and would publish page
 * data that no excerpt needs. This DTO keeps the one field a reader is meant to see, plus the minimum provenance needed to label
 * it truthfully.
 *
 * ## What it must never contain
 *
 * `raw`, `rawGrade`, the assessment or attendance text, a score, a grade, a review id, or any synthetic student identifier. The
 * text is student-written prose: it is stored as a plain string and a renderer must set it with `textContent`, because provider
 * normalization collapses whitespace but does NOT sanitise HTML-like text.
 */
export interface ReviewExcerpt {
  /**
   * The comment, trimmed and bounded to the provider's character cap, otherwise byte-for-byte as the student wrote it.
   *
   * Never empty: a row with no usable comment produces no excerpt and a scope with none produces no excerpt at all. When the cap
   * truncated it, the last character is `…` and the result is still within the cap, counted in Unicode code points so an astral
   * character is never split.
   */
  text: string;
  /** Which partition of the corpus this row was filed in, as the provider determined it. */
  scope: ReviewExcerptScope;
  /**
   * Every teacher this row itself named, as published.
   *
   * This is the ONLY field a label may be derived from. It is present even for `current_class`, where it may name a proper subset
   * of the class's teachers — a co-taught class's single-teacher row is still this class's evidence, and labelling it with the
   * whole class's names would put one person's words in another person's mouth.
   */
  teacherNames: string[];
  /**
   * How usable this row's teacher cell was.
   *
   * Carried because `supplementary` rows are exactly the unattributable ones, and a reader is owed the difference between "this
   * comment came from a row that left the teacher field blank" and one that filled it with prose.
   */
  teacherValidity: TeacherValidity;
}

/**
 * Which scale a published grade cell appears to use.
 *
 * `percentage` is the only scale that feeds percentage statistics; `gpa` and
 * `unknown` are recorded but kept out of them, so a 4.0 or a 4 can never be
 * averaged together with a 90.
 */
export type GradeScale = 'percentage' | 'gpa' | 'other' | 'unknown';

/**
 * How usable a published grade cell is.
 *
 * - `usable` — a plausible percentage, **including values below 60**. A real 55
 *   is evidence about grading difficulty and must not be dropped.
 * - `ambiguous` — parseable but on an unclear scale (`0`…`9` integers, GPA-like
 *   decimals). Counted and quoted, never folded into percentage statistics.
 * - `invalid` — a sentinel (`未知`, `Unknown`), unparseable, or out of range.
 */
export type GradeValidity = 'usable' | 'ambiguous' | 'invalid';

/**
 * Counts and statistics for one grade sample set.
 *
 * Percentage statistics cover `validSampleCount` rows **only**; ambiguous and
 * invalid cells are counted separately so nothing is silently lost and no two
 * scales are ever mixed.
 */
export interface GradeStatistics {
  /** Rows whose grade was a usable percentage (may be below 60). */
  validSampleCount: number;
  /** Rows whose grade parsed but sits on an unclear scale. */
  ambiguousSampleCount: number;
  /** Rows whose grade was a sentinel, unparseable, or out of range. */
  invalidSampleCount: number;
  /** Mean over usable percentages, on the original 0..100 scale. */
  percentageAverage?: number;
  /** Median over usable percentages, on the original 0..100 scale. */
  percentageMedian?: number;
  /** Histogram over usable percentages, keyed by decade lower bound (`"90"`). */
  percentageDistribution: Record<string, number>;
  /** How many usable percentages fell below the pass line. */
  belowPassSampleCount: number;
  /** Mean over usable percentages, kept for backward compatibility. */
  average?: number;
  /** Median over usable percentages, kept for backward compatibility. */
  median?: number;
  /** Histogram over usable percentages, kept for backward compatibility. */
  distribution: Record<string, number>;
}

/**
 * A provider-neutral review row after cleaning, with the original kept intact.
 *
 * `raw` is preserved verbatim so any cleaning decision can be re-audited and the
 * scoring can be recomputed later without re-fetching. No field abnormality ever
 * removes a row: a malformed teacher cell becomes `commentText` evidence, and an
 * unusable grade keeps its `rawGrade`.
 */
export interface CleanReview {
  /** Course name as published (never mutated by cleaning). */
  courseName: string;
  /** Teacher, only when {@link teacherValidity} is `valid` (exactly one person). */
  teacher?: string;
  /** Whether the published teacher cell was usable, multi-teacher, or unusable. */
  teacherValidity: TeacherValidity;
  /** Every recognised teacher name, single or co-taught. */
  teacherNames?: string[];
  /** The published teacher cell verbatim, including when it was unusable. */
  teacherRaw?: string;
  /** Which scale the published grade appears to use. */
  gradeScale: GradeScale;
  /** Whether the published grade is usable, ambiguous, or invalid. */
  gradeValidity: GradeValidity;
  /** Numeric grade, present for `usable`/`ambiguous` rows only. */
  reportedGrade?: number;
  /** The published grade cell, exactly as received. */
  rawGrade?: string;
  /** Final-assessment free text, cleaned. */
  examMethodText?: string;
  /** Attendance/homework free text, cleaned. */
  attendanceWorkloadText?: string;
  /** Review body free text, cleaned; a malformed teacher cell is folded in. */
  commentText?: string;
  /** Text recovered from a malformed teacher cell, kept as evidence. */
  malformedTeacherText?: string;
  /** The untouched published row. */
  raw: RawReviewRow;
}

/** One teacher's share of a course's review corpus. */
export interface TeacherCandidate {
  /** Teacher name as published. */
  teacher: string;
  /** Rows that published this teacher. */
  reviewCount: number;
  /** Of those, how many carried a usable grade. */
  validGradeSampleCount: number;
  /** Same key the matcher uses, for downstream comparison. */
  normalizedTeacher: string;
}

/**
 * The numbers a caller needs to read a lookup correctly.
 *
 * Every count is here explicitly because the two corpus sizes are easy to
 * confuse and impossible to recover from one another afterwards:
 * `courseReviewCount` is the whole course, `matchedTeacherReviewCount` is one
 * teacher's share of it.
 */
export interface ReviewStats {
  /** Rows returned for the course name, across every teacher. */
  courseReviewCount: number;
  /** Rows belonging to the matched teacher, or `0` for a course-level result. */
  matchedTeacherReviewCount: number;
  /** Rows whose teacher cell held prose rather than a name. */
  malformedTeacherReviewCount: number;
  /** Rows with no teacher cell. */
  missingTeacherReviewCount: number;
  /** Rows whose teacher cell named several people (joint teaching). */
  multipleTeacherReviewCount: number;
  /** Usable percentage grade samples in scope (may include values below 60). */
  validGradeSampleCount: number;
  /** Grade cells that parsed but sat on an unclear scale, held aside. */
  ambiguousGradeSampleCount: number;
  /** Sentinel/unparseable/out-of-range grade cells. */
  invalidGradeSampleCount: number;
  /** Usable percentage samples below the pass line. */
  belowPassSampleCount: number;
  /** Mean over usable percentages, on the original 0..100 scale. */
  reportedGradeAverage?: number;
  /** Median over usable percentages, on the original 0..100 scale. */
  reportedGradeMedian?: number;
  /** Histogram of usable percentages keyed by decade lower bound. */
  gradeDistribution: Record<string, number>;
  /** Which scale {@link reportedGradeAverage} refers to; always `percentage`. */
  gradeScale: GradeScale;
  /** Whether the review bound to this lookup is one teacher or the whole course. */
  aggregateScope: 'teacher' | 'course' | 'none';
}

/**
 * Course-level view of a provider's corpus for one course.
 *
 * This exists because {@link CourseReview} is a *teacher-level* aggregate: its
 * `reviewCount` counts one teacher's rows. Reporting that number as "the course
 * has 17 reviews" is wrong, and so is reporting the course total as one
 * teacher's. Both numbers are exposed here, separately.
 */
/** Which corpus of rows a {@link CourseLevelReview} was computed over. */
export type CourseLevelScope = 'course' | 'teachingClass' | 'supplementary';

export interface CourseLevelReview {
  provider: ProviderId;
  /** Course name as published. */
  courseName: string;
  /** Matching-friendly form. */
  normalizedName: string;
  /**
   * Which corpus of rows this roll-up describes.
   *
   * The same statistics are computed over three different row sets, and they answer three different questions, so a caller
   * that reads `courseReviewCount` or `meanGrade` MUST know which one it is holding:
   *
   * - `course` — every row of the whole course, including teachers outside the current teaching class. Background, not the
   *   class's own total.
   * - `teachingClass` — the rows related to the current teaching class's teachers, counted once each. This is the class's own
   *   total, and the one to quote as such.
   * - `supplementary` — rows that name no usable teacher, so they belong to the course but cannot be attributed to a person.
   *
   * Optional so that existing producers and stored records keep type-checking; a consumer that needs to tell them apart must
   * treat an absent scope as "unknown provenance" rather than assuming `course`.
   */
  scope?: CourseLevelScope;
  /** Every row returned by the provider for this course name. */
  courseReviewCount: number;
  /** Rows whose teacher cell was usable. */
  validTeacherReviewCount: number;
  /** Rows whose teacher cell held something that is not a name. */
  malformedTeacherReviewCount: number;
  /** Rows with no teacher cell at all. */
  missingTeacherReviewCount: number;
  /** Rows whose teacher cell named several people (joint teaching). */
  multipleTeacherReviewCount: number;
  /** Distinct valid teachers, most-reviewed first. */
  teacherCandidates: TeacherCandidate[];
  /** Grade statistics over **all** rows of the course. */
  grades: GradeStatistics;
  /** Aspect-based analysis over **all** rows of the course (Phase 2). */
  aspects?: AspectAnalysis;
  /** The same four `0..10` metrics the teacher aggregates use, over all rows. */
  gradeFriendliness?: number;
  workloadFriendliness?: number;
  attendanceFriendliness?: number;
  overallScore?: number;
  /** Mean/median published grade over valid samples, on the original scale. */
  meanGrade?: number;
  medianGrade?: number;
  /**
   * A bounded slice of the cleaned rows behind these numbers.
   *
   * Deliberately a sample, not the corpus: storage keeps everything, presentation
   * shows a handful. Without it the aggregate is unauditable.
   */
  sampleRows?: CleanReview[];
  /** Canonical URL a human can open to verify the data. */
  sourceUrl?: string;
}

/** Per-dimension evidence, so a recommendation can explain itself. */
export interface MetricEvidence {
  /** Number of rows that contributed to this metric. */
  sampleCount: number;
  /** Deterministic explanation of how the value was derived. */
  note: string;
  /** Matched keywords/terms that drove a text-derived metric. */
  matchedTerms?: string[];
}

/**
 * Aggregated, normalized review data for one course as a review provider sees it.
 *
 * A provider aggregates rows for `(courseName, teacher)` because the upstream
 * corpus is a flat list of individual reviews. There may therefore be several
 * `CourseReview` records for the same course name with different teachers.
 */
export interface CourseReview {
  /** Provider id. */
  provider: ProviderId;
  /** Provider-side course id, when the site exposes one. */
  reviewCourseId?: string;
  /** Course code, when the site exposes one. */
  courseCode?: string;
  /** Course name as published. */
  courseName: string;
  /** Matching-friendly form of {@link courseName}. */
  normalizedName: string;
  /** Teacher this aggregate belongs to, when the site states exactly one. */
  teacher?: string;
  /** Matching-friendly teacher name. */
  normalizedTeacher?: string;
  /**
   * Every teacher on this aggregate; more than one means joint teaching.
   *
   * Present alongside `teacher` only for co-taught rows, so a caller can tell
   * "this bucket is one person" from "these rows belong to several people".
   */
  teacherNames?: string[];
  /** True when at least one row in this bucket named several teachers. */
  jointTeaching?: boolean;

  /** `0..10`, higher = easier to get a good grade. */
  gradeFriendliness?: number;
  /** `0..10`, higher = less work. */
  workloadFriendliness?: number;
  /** `0..10`, higher = attendance is more forgiving. */
  attendanceFriendliness?: number;
  /**
   * `0..10`, higher = reviewers were more positive overall.
   * This is a sentiment-style score, NOT the raw published grade.
   */
  overallScore?: number;

  /** Mean published grade across numeric samples, on the original 0..100 scale. */
  meanGrade?: number;
  /** Median published grade across numeric samples, on the original 0..100 scale. */
  medianGrade?: number;

  /** Number of review rows aggregated into **this teacher bucket**. */
  reviewCount: number;
  /**
   * Rows the provider returned for the whole course name, across every teacher.
   *
   * Distinct from {@link reviewCount} and never interchangeable with it: for a
   * popular course this is the corpus size (e.g. 254) while `reviewCount` is one
   * teacher's share (e.g. 17).
   */
  courseReviewCount?: number;
  /** Rows of this bucket that published a usable teacher (= `reviewCount` for a valid bucket). */
  matchedTeacherReviewCount?: number;
  /** Rows of this bucket whose teacher cell held prose rather than a name. */
  malformedTeacherReviewCount?: number;
  /** Rows of this bucket with no teacher cell at all. */
  missingTeacherReviewCount?: number;
  /** Rows of this bucket whose teacher cell named several people. */
  multipleTeacherReviewCount?: number;
  /** Usable percentage samples in this bucket (may include values below 60). */
  gradedSampleCount: number;
  /** Rows whose grade cell parsed but sat on an unclear scale (GPA-like, 0–9). */
  ambiguousGradeSampleCount?: number;
  /** Rows whose grade cell was a sentinel, unparseable, or out of range. */
  invalidGradeSampleCount?: number;
  /** Usable percentage samples below the pass line. */
  belowPassSampleCount?: number;
  /** Histogram of usable percentages keyed by decade lower bound (`"90"`). */
  gradeDistribution?: Record<string, number>;
  /** Which scale {@link meanGrade} refers to; always `percentage`. */
  gradeScale?: GradeScale;
  /** Whether this record came from a teacher bucket or a course-level roll-up. */
  aggregateScope?: 'teacher' | 'course';
  /** ISO-8601 date of the newest review, when the site exposes dates. */
  latestReviewDate?: string;

  /** Per-dimension derivation evidence. */
  evidence?: Partial<Record<ReviewMetricKey, MetricEvidence>>;

  /**
   * Aspect-based analysis of the review text (Phase 2).
   *
   * Kept beside the four canonical ranking metrics rather than inside them: the
   * ranking API is unchanged, while `examFriendliness`, `teachingQuality`, and
   * `studentSentiment` become visible through lookup and explain output first.
   */
  aspects?: AspectAnalysis;

  /**
   * A bounded slice of the cleaned rows behind this aggregate, so the numbers
   * can be traced back without shipping the whole corpus to the model.
   */
  sampleRows?: CleanReview[];

  /** Canonical URL a human can open to verify the data. */
  sourceUrl?: string;
  /** Untouched provider payload. */
  raw?: unknown;
}

/** Keys of the metrics that participate in scoring. */
export type ReviewMetricKey =
  | 'gradeFriendliness'
  | 'workloadFriendliness'
  | 'attendanceFriendliness'
  | 'overallScore';

/** The four weights a user can steer. All are relative; the engine normalizes. */
export interface RankingPreferences {
  gradeFriendliness: number;
  workloadFriendliness: number;
  attendanceFriendliness: number;
  overallScore: number;
  /**
   * Optional aspect weights added in Phase 3.
   *
   * `studentSentiment` mirrors `overallScore` (the old name for the same thing);
   * when both are given, `studentSentiment` wins. `examFriendliness` and
   * `teachingQuality` are **opt-in**: `examFriendliness` is absent from the
   * default ranking because only 6 of 254 高等数学 reviews say anything about exam
   * difficulty, so it must be requested explicitly rather than silently weighted.
   */
  studentSentiment?: number;
  examFriendliness?: number;
  teachingQuality?: number;
  /** Named preset (`easy_grade` | `balanced` | `learn_something` | `exam_light`). */
  preset?: string;
  /** Drop candidates whose review sample is smaller than this. */
  minReviewCount?: number;
  /** When true, courses with `availability === 'full'` are excluded. */
  requireAvailableSeats?: boolean;
}

/**
 * How a course and a review record were tied together.
 *
 * The order below is the confidence order, strongest first. `alias_*` sits
 * strictly between the exact methods and the fuzzy ones: an alias is a weaker
 * claim than an exact name, so it must never be reported as `exact_name`.
 */
export type MatchMethod =
  | 'course_code'
  | 'course_code_teacher'
  | 'name_teacher'
  | 'alias_name_teacher'
  | 'exact_name'
  | 'alias_name'
  | 'fuzzy_name_teacher'
  | 'fuzzy_name'
  | 'unmatched';

/** Methods that resolved through an alias rather than an exact identifier. */
export const ALIAS_METHODS: readonly MatchMethod[] = ['alias_name_teacher', 'alias_name'] as const;

/** Whether a match method used an alias, for provenance in tool output. */
export function isAliasMethod(method: MatchMethod): boolean {
  return ALIAS_METHODS.includes(method);
}

/** Result of matching one course against the provider's review candidates. */
export interface MatchResult {
  course: NormalizedCourse;
  review?: CourseReview;
  /**
   * The course-level roll-up, when the provider produced one.
   *
   * Present for a name-only lookup of a multi-teacher course, where binding one
   * teacher's bucket would silently misattribute that teacher's data to the
   * whole course.
   */
  courseLevel?: CourseLevelReview;
  /**
   * The CURRENT teaching class's own roll-up, when the provider produced one.
   *
   * Distinct from {@link courseLevel} in a way that matters for trust: `courseLevel` covers every teacher the site indexes
   * for the course name, including teachers of other classes and rows whose teacher cell is unusable, whereas this covers
   * only the rows related to the class's own teachers, counted once each. Confidence therefore reads its evidence volume
   * from here when it is available — a class taught by 张三 and 李四 has 3 unique related rows even though its two teacher
   * buckets hold 2 each, and reading a bucket (2) or the whole course (everyone) would both misstate how much evidence
   * backs *this* class.
   *
   * Optional: a selection page that published no teacher, or a provider that cannot partition, leaves it absent, and every
   * consumer must then behave exactly as it did before this field existed.
   */
  teachingClassLevel?: CourseLevelReview;
  /**
   * Bounded, provider-scoped student comments for this course, when the provider produced any.
   *
   * Carried on the match because this is the object the lookup pipeline hands to the engine, and the provider's scoping decision is
   * a fact about the corpus rather than something a later layer may recompute. Absent when there are none, so an unmatched course
   * does not carry an empty array it never filled.
   */
  reviewExcerpts?: ReviewExcerpt[];
  /** `0..1`; below the configured threshold the match is not trusted. */
  confidence: number;
  method: MatchMethod;
  /**
   * True when the match resolved through an alias rather than an exact
   * identifier. Reported separately because an alias is a weaker claim and the
   * caller may need the user to confirm it.
   */
  aliasUsed?: boolean;
  /** Review candidates that were considered but not chosen. */
  alternatives?: CourseReview[];
  /**
   * Distinct teachers the corpus holds for the matched course, most-reviewed
   * first. Listed so a name-only lookup can ask which teacher instead of
   * silently answering with one of them.
   */
  teacherCandidates?: TeacherCandidate[];
  /** True when several teachers tie for best, so no single one may be chosen. */
  ambiguous?: boolean;
  /** Reason a low-confidence match was rejected, when applicable. */
  note?: string;
}

/** Tiered confidence label. */
export type ConfidenceTier = 'low' | 'medium' | 'high';

/**
 * Confidence in the review data behind one recommendation.
 *
 * Kept strictly separate from the quality score, and separate again from
 * {@link MatchResult.confidence}: this is *review* confidence ("is there enough
 * evidence, and does it agree?"), whereas `match.confidence` is *matching*
 * confidence ("is this the same course?"). Mixing them would let a confident name
 * match imply a well-evidenced course.
 */
export interface ReviewConfidence {
  /** `0..1` combined score. */
  value: number;
  tier: ConfidenceTier;
  /** Every component score, each `0..1`, for explainability. */
  components: {
    /** How confident the matcher is that this is the same course. */
    matching: number;
    /** Evidence volume at the scope actually used for scoring. */
    evidence: number;
    /** Whether the corpus agrees with itself about the teacher. */
    teacherAgreement: number;
    /** Coverage of the aspects actually used for ranking. */
    aspectCoverage: number;
    /** Data hygiene: how much of the teacher column was unparseable prose. */
    dataHygiene: number;
  };
  /** Which components could not be computed from the available data. */
  missing: string[];
  /** Human-readable summary. */
  summary: string;
  /** Provenance the summary is derived from, so a caller can audit it. */
  inputs: {
    courseMatchConfidence: number;
    teacherSpecified: boolean;
    teacherMatched: boolean;
    /** True when scoring fell back to the course-level roll-up. */
    teacherFallbackUsed: boolean;
    aliasUsed: boolean;
    courseReviewCount: number;
    matchedTeacherReviewCount: number;
    evidenceReviewCount: number;
    percentageGradeSampleCount: number;
    malformedTeacherRatio: number;
  };
}

/** One weighted contribution to a course's score. */
export interface ScoreComponent {
  metric: ReviewMetricKey;
  /** Normalized weight actually applied after dropping missing metrics. */
  weight: number;
  /** The metric value `0..10`, when present. */
  value?: number;
  /** `weight * value`, when present. */
  contribution?: number;
  /** Whether the metric was available at all. */
  available: boolean;
}

/** Deterministic ranking result for one course. */
export interface CourseScore {
  course: NormalizedCourse;
  /** Weighted `0..10` score, or `null` when no metric was available. */
  score: number | null;
  /** Per-metric breakdown. */
  components: ScoreComponent[];
  /** Weights after renormalizing onto the available metrics. */
  appliedWeights: Partial<Record<ReviewMetricKey, number>>;
  /** Metrics that were requested but unavailable, so their weight was redistributed. */
  redistributed: ReviewMetricKey[];
  match: MatchResult;
  confidence: ReviewConfidence;
  /**
   * Phase 3 aspect breakdown behind `score`: raw / reliability / decision per
   * dimension. Present when the decision engine computed the score, absent when a
   * caller used the legacy four-metric path directly.
   */
  decision?: AspectBreakdown;
}

/**
 * Student-reported grade statistics for ONE scope, ready to display.
 *
 * A projection of an existing aggregate, never a recomputation: the numbers are the provider's own, carried through so a reader can be told
 * what the grades behind a course actually were.
 *
 * `meanGrade` and `medianGrade` are **absent**, not `0` and not `null`, when there is no usable sample. A course without published grades
 * has no average, and showing `0` would read as "everyone failed". `gradedSampleCount` is always present so a caller can tell the two apart
 * without guessing.
 */
export interface GradeAggregate {
  /** Mean over usable percentage grades, `0..100`. Absent when nothing was usable. */
  meanGrade?: number;
  /** Median over usable percentage grades, `0..100`. Absent when nothing was usable. */
  medianGrade?: number;
  /** Usable percentage samples. `0` means there is no average to show. */
  gradedSampleCount: number;
  /** Histogram over usable percentages, keyed by decade lower bound (`"90"`). */
  gradeDistribution: Record<string, number>;
}

/**
 * The grade statistics a recommendation carries, one entry per scope.
 *
 * ## Why three scopes, and which one a reader should see
 *
 * The same course yields different, equally true numbers depending on which rows are counted, so they are reported side by side and the
 * caller picks by the teaching-class structure:
 *
 * - `teacher` — the one teacher's own matched reviews. Correct for a single-teacher class.
 * - `teachingClass` — rows related to THIS class's teacher set, counted once each. Correct for a co-taught class (`A、B`), where the union
 *   of A's and B's related rows describes the class the user is actually choosing.
 * - `course` — every row of the course, including teachers of other classes. Background reference only; it must NOT stand in for a
 *   teaching class, because that would fold other teachers' cohorts into this one.
 *
 * `teacherSet.names` is stated rather than inferred so the caller never has to re-parse the teacher cell: `length === 0` means the page
 * published no teacher (so no candidate-specific grade may be shown at all), `1` means a single teacher, and `>= 2` means co-taught. The
 * raw cell stays on `course.teacher` for display.
 */
export interface RecommendationGradeAggregates {
  /** The class's teachers, normalized and deduplicated as the matcher uses them. */
  teacherSet: { names: string[] };
  /** The single matched teacher's grades. Absent unless exactly one teacher was named. */
  teacher?: GradeAggregate;
  /** Grades over the rows related to this class's teacher set. The class's own total, when the provider partitioned. */
  teachingClass?: GradeAggregate;
  /** Grades over the whole course, including teachers outside this class. Reference only. */
  course?: GradeAggregate;
}

/**
 * How one review-source query ended.
 *
 * The distinction this exists for is the one a reader cannot otherwise make: a site that answered "I have no reviews for this course" is not the
 * same as a site that could not be reached, and telling a user "no reviews found" when the request actually failed is a false statement about
 * the world rather than a graceful degradation.
 *
 * `empty` is a SUCCESS: the request completed and the answer was legitimately nothing. `unavailable` means no answer was obtained.
 */
export type ReviewSourceQueryOutcome = 'rows' | 'empty' | 'unavailable';

/**
 * Why a query was unavailable, in a form safe to publish.
 *
 * Deliberately coarse. The provider knows the difference between a timeout and a 500, but a result object is not the place to carry a stack,
 * a URL or a response body, so the reason is reduced to three kinds at the boundary and the detail stays in the internal warnings.
 */
export type ReviewSourceFailureKind = 'network' | 'http' | 'malformed';

/**
 * Review-source health for one course, or for a whole run.
 *
 * `status` is derived from the counts rather than stored independently, so the two can never disagree:
 *
 * - `healthy` — at least one query completed and none failed.
 * - `partial` — at least one query failed while at least one other completed. The successful data is still used; this only records that the
 *   picture is incomplete.
 * - `unavailable` — every query failed, so nothing about the source could be established.
 *
 * A course that never triggered a query keeps `status: 'healthy'` with `queries: 0`. That is not a claim that the source is fine; it is the
 * absence of any evidence to the contrary, and inventing `unavailable` there would blame the source for a query never made.
 */
export interface ReviewSourceHealth {
  /** `healthy` when nothing failed, `partial` for a mix, `unavailable` when nothing succeeded. */
  status: 'healthy' | 'partial' | 'unavailable';
  /** Review-source queries issued. */
  queries: number;
  /** Queries that returned at least one record. */
  rows: number;
  /** Queries that completed and legitimately found nothing. */
  empty: number;
  /** Queries that obtained no answer. */
  unavailable: number;
  /** The kinds of failure seen, deduplicated. Present only when something failed. */
  failureKinds?: ReviewSourceFailureKind[];
}

/** A ranked, explained recommendation. */
export interface Recommendation {
  rank: number;
  course: NormalizedCourse;
  /**
   * Which body of reviews produced this score, and how large it is.
   *
   * `scope: 'course'` means the figures cover the whole course across every teacher the review site
   * indexes; `'teacher'` means they describe one teacher. These are **not** interchangeable evidence: a
   * 254-review course-level aggregate and a 17-review teacher aggregate behind similar scores are
   * different claims, and a reader who cannot tell them apart cannot judge either.
   *
   * Always present, so no caller has to infer the scope from {@link review} being populated.
   */
  reviewContext: ReviewContext;
  /**
   * How much of this section's page information was loaded, as one fact.
   *
   * The selection page fills `teacher`, `schedule`, `location`, `department` and `capacity` in a single
   * per-course request, so those fields are present together or absent together. Reporting them as four
   * independent gaps would misdescribe page behaviour and invite a reader to conclude "this course has no
   * teacher" when the truth is "this row has not been expanded".
   */
  sectionHydration: SectionHydration;
  /**
   * Student-reported grade statistics for this recommendation, one entry per scope.
   *
   * Presentation data: it is projected from aggregates the engine already holds, and it takes no part in `score`, `confidence` or the
   * ranking. A caller showing an average must choose the scope by the teaching-class structure — see
   * {@link RecommendationGradeAggregates}.
   */
  gradeAggregates: RecommendationGradeAggregates;
  /**
   * Whether this candidate's review source answered, and how completely.
   *
   * A `partial` or `unavailable` status qualifies every figure above: the score was computed from whatever evidence arrived, and a reader
   * told "no reviews" for an `unavailable` candidate is being told something false about the site.
   */
  reviewSource: ReviewSourceHealth;
  /** Whether this course is recommended, merely rated, or unscoreable. */
  recommendationStatus: RecommendationStatus;
  /**
   * Weighted **decision** score: `5.5 + reliability × (raw - 5.5)` per aspect,
   * so thin evidence shrinks toward neutral instead of being read as bad.
   */
  score: number | null;
  confidence: ReviewConfidence;
  /** Rule-based facts about *why* this course ranks here. */
  reasons: string[];
  /** Caveats the agent must surface, e.g. an uncertain review match. */
  warnings: string[];
  match: {
    method: MatchMethod;
    confidence: number;
    /** Whether the match cleared the configured threshold. */
    trusted: boolean;
    /** Whether an alias resolved this match. */
    aliasUsed?: boolean;
  };
  /** Per-aspect raw / reliability / decision triple, for answering "why 8.4?". */
  aspects: AspectBreakdown;
  /** Aspects the caller weighted that had no usable data. */
  missingDimensions: AspectKey[];
  /** Short labels for the aspects that actually contributed, strongest first. */
  topAspects: AspectKey[];
  review?: CourseReview;
  /**
   * Up to `MAX_REVIEW_EXCERPTS` bounded student comments for this course, best evidence first.
   *
   * REQUIRED, and `[]` means "none usable" rather than "not computed". The engine publishes an array on every scored entry, so a
   * renderer has no maybe to branch on: the excerpts travel WITH the score they were computed alongside, exactly like
   * {@link gradeAggregates}.
   *
   * Already scoped by the provider — each excerpt states which partition it came from and which teachers its own row named — so
   * nothing downstream may re-derive either. In particular a label must read {@link ReviewExcerpt.teacherNames}, never the scope
   * name, because for a co-taught class a `current_class` row may name only one of the teachers.
   */
  reviewExcerpts: ReviewExcerpt[];
  /** Legacy four-metric breakdown, retained for backward compatibility. */
  components: ScoreComponent[];
  appliedWeights: Partial<Record<ReviewMetricKey, number>>;
  redistributed: ReviewMetricKey[];
  /**
   * The score after confidence shrinkage: `5.5 + confidence × (score − 5.5)`.
   *
   * Reported **alongside** {@link score}, never instead of it, and it does **not** affect the order of
   * this list. Confidence answers "how sure are we", not "how good is this course", so folding it into
   * the weighted sum would reward being *easy to identify* — a well-evidenced mediocre course overtaking
   * a thinly-evidenced excellent one. Shrinking the final number expresses the same uncertainty without
   * letting it compete with the aspects.
   *
   * Whether ranking should use this instead of `score` is a separate, later decision.
   */
  riskAdjustedScore: number | null;
  /**
   * Weights actually applied per aspect, after missing dimensions were redistributed.
   *
   * `appliedWeights` above uses the four legacy metric keys; this one is aspect-keyed and therefore
   * comparable against {@link defaultWeights}. They differ whenever an aspect had no evidence — and
   * presenting the requested weighting as though it were the effective one would misdescribe the model.
   */
  effectiveWeights: Partial<Record<AspectKey, number>>;
  /** The weighting requested before redistribution, for the default-versus-actual comparison. */
  defaultWeights: Partial<Record<AspectKey, number>>;
  /** Aspects whose requested weight moved to others because they had no evidence. */
  effectiveWeightNotes: string[];
  /**
   * How strong the evidence behind each aspect is, as a graded tier.
   *
   * Combines sample size, how much of the corpus spoke about the aspect, and how much the corpus
   * agreed — because neither size nor coverage alone is sufficient: 5 of 100 reviews mentioning an exam
   * is broad but thin, and 9 of 10 agreeing is narrow but decisive.
   */
  evidenceStrength: EvidenceStrengthEntry[];
}

/**
 * The review scope a recommendation was computed from.
 *
 * Reported rather than inferred, because the pipeline resolves review scope in two places that can
 * legitimately disagree: the recommend path binds a teacher bucket, while the explain path falls back to a
 * course-level roll-up when more than one teacher is indexed. Measured on a live page, the two resolved
 * different scopes for 60% of courses — so a single "review coverage" figure would misreport both.
 */
export interface ReviewContext {
  /** `course` = every teacher the site indexes; `teacher` = one teacher. */
  scope: ReviewAggregationScope;
  /** Reviews behind the figures. */
  reviewCount: number;
  /**
   * Whether the **caller supplied** a teacher for this course.
   *
   * Read from the input course, not from the matched review: a teacher-less course can match a review
   * record that happens to name someone, and that is not the user having specified a teacher.
   */
  teacherSpecified: boolean;
  /**
   * The teacher the matched review belongs to, or `null` when the review names nobody.
   *
   * Present even when the caller specified no teacher, so a reader can see which name the evidence is
   * actually about.
   */
  teacher: string | null;
  /**
   * Confidence of the teacher-level match, or `null` when no teacher was specified.
   *
   * `null` is deliberate: with no teacher supplied there is no teacher match to be confident about, and
   * reporting `0` would read as "a match that failed" rather than "no match was attempted".
   */
  teacherMatchConfidence: number | null;
  /** One line a UI can show verbatim, stating what the figures do and do not represent. */
  aggregationNote: string;
}

/** Which body of reviews an aggregate covers. */
export type ReviewAggregationScope = 'course' | 'teacher';

/**
 * How completely the selection page's information for one section has been loaded.
 *
 * `status` comes from the page's own hydration flag when the extraction layer recorded one, because field
 * presence alone cannot distinguish "the page has not fetched this row yet" from "this row legitimately has
 * no room assignment". A hydrated row may genuinely be missing `department` or `location` while still being
 * fully loaded, so the two signals are reported side by side rather than conflated.
 */
export interface SectionHydration {
  /** `full` when the page loaded this section's detail row; `basic` when only the list row is present. */
  status: SectionHydrationStatus;
  /** Section fields the extraction actually produced. */
  available: HydratableField[];
  /** Section fields that are absent — see `status` for why. */
  missing: HydratableField[];
  /**
   * The page's own hydration answer, or `null` when the source could not report one.
   *
   * Kept beside {@link status} so a consumer can tell a page-reported `basic` from a fallback guess, and so
   * a source that has no such notion does not have to invent one.
   */
  rawHydrated: boolean | null;
}

/** Section detail the selection page fills in one per-course request. */
export type HydratableField = 'teacher' | 'schedule' | 'location' | 'department' | 'capacity';

/** Whether a section's detail row has been loaded. */
export type SectionHydrationStatus = 'basic' | 'full';

/**
 * Where a course stands relative to the recommendation list.
 *
 * Three states, kept apart on purpose:
 *
 * - `recommended` — scored and inside the returned top N.
 * - `ratedButNotRecommended` — scored with usable evidence, but ranked below the cut. **This is the state
 *   that used to be invisible**: the pipeline computed and sorted a score for it and then discarded it at
 *   the `topN` break, so "ranked 40th" and "had no data at all" reached the user looking identical.
 * - `insufficientData` — no trusted match, or no aspect carried evidence, so no score exists. A data
 *   problem, never a quality judgement.
 */
export type RecommendationStatus = 'recommended' | 'ratedButNotRecommended' | 'insufficientData';

/**
 * A scored course that ranked below the returned cut.
 *
 * ## Why `gradeAggregates` is here too
 *
 * A rated course has a real score, real evidence and — as of PRE-RELEASE-UX-A11 — the same canonical grade aggregates a recommendation carries. Before that it
 * was the ONE thing a reader could see on a recommended card and not on a rated one, which made "self-reported average" look like a property of being
 * recommended rather than a property of the course.
 *
 * The field is the SAME `RecommendationGradeAggregates` object the recommendation path publishes, produced by the same projection from the same lookup result.
 * There is deliberately no flattened `averageGrade` beside it: a second, simpler number would be a second definition of "this course's average", and the two
 * would eventually disagree about scope — which is the one thing the three-scope structure exists to keep straight.
 */
export interface RatedButNotRecommendedEntry {
  course: NormalizedCourse;
  /** Position in the full scored order, 1-based. Always greater than the last returned rank. */
  rank: number;
  score: number;
  reviewContext: ReviewContext;
  sectionHydration: SectionHydration;
  /**
   * Student-reported grade statistics for this course, one entry per scope, identical in shape and semantics to
   * {@link Recommendation.gradeAggregates}.
   *
   * Presentation data only: it takes no part in `rank`, `score` or the decision to place the entry below the cut. A caller showing an average must choose the
   * scope by the teaching-class structure — see {@link RecommendationGradeAggregates}.
   */
  gradeAggregates: RecommendationGradeAggregates;
  /**
   * Bounded student comments for this course, identical in shape and semantics to {@link Recommendation.reviewExcerpts}.
   *
   * REQUIRED, and `[]` means "none usable" rather than "not computed", for the same reason as on a recommended entry: a course
   * that missed the cut is still a course a reader may open, and "no excerpts" and "not asked for" must not look alike.
   *
   * Presentation data only: it takes no part in `rank`, `score` or the decision to place the entry below the cut.
   */
  reviewExcerpts: ReviewExcerpt[];
}

/**
 * Pool coverage, supplied by the caller that read the page.
 *
 * Not computed by the engine: the number of courses a selection system holds, and whether the list has been
 * loaded to the end, live in the page DOM and are invisible from a course array. The engine reports what it
 * was told and writes `null` where it was told nothing, rather than guessing a value that would read as
 * fact.
 */
export interface DataCoverage {
  /** Courses discovered on the page. */
  coursesDiscovered: number;
  /** Section rows discovered on the page. */
  sectionsDiscovered: number;
  /** Section rows whose detail was loaded. */
  sectionsHydrated: number;
  /**
   * `sectionsHydrated / sectionsDiscovered`, or `null` when no section was discovered.
   *
   * Reported **beside** the raw counts, never instead of them: a lone percentage cannot distinguish "the
   * list was never paged further" from "the rows were never expanded", and those call for different user
   * actions.
   */
  hydratedRatio: number | null;
  /**
   * Whether the page's own end-of-list flag was set.
   *
   * `null` when the source does not expose one. Never defaulted to `false`, because `false` means "there are
   * more courses" — asserting it without evidence would tell a user their pool is partial when it may be
   * complete, or complete when it is not.
   */
  exhausted: boolean | null;
}

/** How much evidence stands behind one aspect, for display rather than scoring. */
export interface EvidenceStrengthEntry {
  aspect: AspectKey;
  /** `strong` when well-sampled and broadly covered, `limited` when either is scarce. */
  level: EvidenceStrengthLevel;
  /** Reviews that carried evidence for this aspect. */
  reviewsWithEvidence: number;
  /** Reviews in the corpus this aspect was assessed against. */
  corpusReviews: number;
  /** `reviewsWithEvidence / corpusReviews`, `0` when the corpus is empty. */
  coverage: number;
  /** Share of the directional evidence pointing the same way, `0..1`. */
  agreement: number;
  /** Why this tier was chosen, in words. */
  note: string;
}

/** Evidence tiers, ordered from most to least supported. */
export type EvidenceStrengthLevel = 'strong' | 'moderate' | 'limited' | 'none';

/** Courses dropped before ranking, with the reason. */
export interface EligibilityDecision {
  course: NormalizedCourse;
  eligible: boolean;
  reasons: string[];
}

/** Result of a full recommendation run. */
export interface RecommendationResult {
  /** Ranked recommendations, best first. */
  recommendations: Recommendation[];
  /**
   * Courses that were scored but ranked below the returned cut.
   *
   * Listed rather than counted, because "another 47 courses were rated lower" and "here is the 6th-best
   * course, at 5.9" answer different questions, and only the second lets a reader check whether the cut fell
   * in a sensible place. These courses carry a genuine score; they are not data failures, and keeping them
   * out of {@link recommendations} preserves the existing "at most `topN`, best first" contract.
   */
  ratedButNotRecommended: RatedButNotRecommendedEntry[];
  /** Courses that passed eligibility, whether or not they made the top N. */
  considered: number;
  /** Courses removed by the eligibility stage. */
  excluded: EligibilityDecision[];
  /** Courses with no trusted review data, listed so the agent can mention them. */
  insufficientData: Array<{
    course: NormalizedCourse;
    reason: string;
    match: { method: MatchMethod; confidence: number };
    /**
     * The review source's state for this course, so "the site had nothing" and "the site could not be reached" are structurally different
     * answers rather than two readings of one `reason` sentence.
     */
    reviewSource: ReviewSourceHealth;
  }>;
  /**
   * Courses whose name matched only approximately (alias or fuzzy).
   *
   * Kept out of {@link recommendations} on purpose: "these names look similar" is
   * a question for the user, not a basis for ranking. Listed here so the agent can
   * ask for confirmation instead of dropping them silently.
   */
  ambiguousCandidates: Array<{
    course: NormalizedCourse;
    method: MatchMethod;
    confidence: number;
    reason: string;
  }>;
  /** Weights actually used, after validation/normalization. */
  preferences: RankingPreferences;
  /**
   * Pool coverage as the caller reported it, or `null` when the caller reported none.
   *
   * `null` is a real answer, not a gap to fill with zeros: a run over a hand-built course array has no page
   * behind it, and reporting `coursesDiscovered: 0` would read as "nothing was found".
   */
  dataCoverage: DataCoverage | null;
  /**
   * Review-source health for the whole run, aggregated from every course's queries.
   *
   * A roll-up only: it never affects ranking, and it exists so a caller can say "some review requests failed" or "the review site was
   * unreachable" without parsing any per-course text. A run with no queries at all reports `healthy` with `queries: 0`, because no failure
   * was observed.
   */
  reviewSource: ReviewSourceHealth;
  /** Provenance and engine metadata. */
  meta: {
    adapters: AdapterId[];
    providers: ProviderId[];
    reviewMatchThreshold: number;
    generatedAt: string;
    /** True when the result was produced from a cached review corpus. */
    usedCache: boolean;
  };
}
