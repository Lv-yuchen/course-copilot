/**
 * The recommendation pipeline.
 *
 * Wiring, in the order the product spec fixes it:
 *
 * ```
 * courses -> eligibility filter -> provider lookup -> match -> score
 *         -> confidence -> deterministic sort -> structured result
 * ```
 *
 * Nothing in this module is stochastic, and the LLM is not involved: the agent
 * supplies structured preferences and receives a fully computed ranking, then
 * writes the prose around it.
 *
 * @module course-selection-copilot/pipeline/recommend
 */

import { METRIC_KEYS, REVIEW_MATCH_THRESHOLD } from '@course-copilot/core/config';
import type { RecommendationPolicy } from './policy.js';
import { calculateReviewConfidence } from '@course-copilot/core/confidence';
import { evaluateEligibility, filterEligible } from '@course-copilot/core/eligibility';
import { normalizeCourseName, normalizeTeacherName } from '@course-copilot/core/normalize';
import { teacherSetRelation } from '@course-copilot/core/normalize';
import { queryTeacherFilter, teacherNamesOfCourse } from '@course-copilot/provider/whu';
import { calculateCourseScore, clampMetric, metricLabel, normalizePreferences } from '@course-copilot/core/ranking';
import {
  aspectLabel,
  aspectWeightsFromPreferences,
  buildAspectBreakdown,
  describeWeightRedistribution,
  evidenceStrength as gradeEvidenceStrength,
  riskAdjustedScore,
  type AspectBreakdown,
} from '@course-copilot/core/recommendation';
import { matchCourse, type CourseMatcher } from '@course-copilot/core/matching/courseMatcher';
import { courseLevelAsReview, capReviewExcerpts, type CourseSearchQuery, type ReviewProvider, type ReviewSearchResult } from '@course-copilot/provider';
import type {
  AspectKey,
} from '@course-copilot/core/aspects';
import type {
  CleanReview,
  CourseLevelReview,
  CourseReview,
  CourseScore,
  DataCoverage,
  EligibilityDecision,
  GradeAggregate,
  HydratableField,
  MatchResult,
  NormalizedCourse,
  RankingPreferences,
  RatedButNotRecommendedEntry,
  Recommendation,
  RecommendationGradeAggregates,
  RecommendationResult,
  ReviewConfidence,
  ReviewContext,
  ReviewExcerpt,
  ReviewMetricKey,
  ReviewSourceFailureKind,
  ReviewSourceHealth,
  ReviewSourceQueryOutcome,
  ReviewStats,
  ScoreComponent,
  SectionHydration,
  TeacherCandidate,
} from '@course-copilot/core/course';

/**
 * Count distinct courses and teaching-class rows in an extracted list.
 *
 * The selection page yields **one entry per teaching class**, not per course: measured live, 193 rows covered
 * only 143 distinct courses, so reporting the row count as a course count overstates the pool by 35%.
 *
 * `courseCode` is the course identity and the row count is the section count; both were measured unique in the
 * earlier audit. The fallbacks matter because a code can be masked on the page (`2030******001`) and several
 * courses can share a masked code, so a missing code falls back to the name. When even the name is absent
 * there is no evidence two rows are the same course, so each is counted separately — collapsing them would
 * assert an identity nothing supports.
 *
 * @param courses - extracted entries, one per teaching class.
 * @returns the two counts, which are equal only when every course has exactly one class.
 */
export function countCoursesAndSections(courses: readonly NormalizedCourse[]): {
  courseCount: number;
  sectionCount: number;
} {
  const identities = new Set<string>();
  courses.forEach((course, index) => {
    const code = (course.courseCode ?? '').trim();
    if (code.length > 0) {
      identities.add(`code:${code}`);
      return;
    }
    const name = (course.normalizedName ?? course.courseName ?? '').trim();
    identities.add(name.length > 0 ? `name:${name}` : `row:${index}`);
  });
  return { courseCount: identities.size, sectionCount: courses.length };
}


/** Provider lookup that the pipeline depends on; a fake can be injected. */
export type ProviderLookup = (query: CourseSearchQuery) => Promise<ReviewedSearchResult>;

/**
 * The per-query review-source facts a lookup result carries.
 *
 * Kept beside the provider contract rather than inside it: a provider reports what IT found, while these facts describe whether the query
 * itself succeeded, which is only known by whoever made the call. `ReviewSearchResult` documents its `warnings` as human-readable, so a
 * machine-readable outcome needs its own field rather than a parsing convention.
 */
export interface ReviewSourceQueryFacts {
  /** One entry per provider query, in call order. */
  outcomes: ReviewSourceQueryOutcome[];
  /** The kinds of failure seen, deduplicated. Absent when nothing failed. */
  failureKinds?: ReviewSourceFailureKind[];
}

/** A `ReviewSearchResult` that also states how its queries ended. */
export type ReviewedSearchResult = ReviewSearchResult & ReviewSourceQueryFacts;

/**
 * Section fields the extraction layer produces separately, in a fixed order.
 *
 * `location` is deliberately **not** here. The adapter folds the room into {@link NormalizedCourse.schedule}
 * as `时间 @ 地点`, so there is no independent "the room is known" signal to report — listing a `location`
 * field would mean claiming knowledge the value does not carry. Where the room is absent while `schedule` is
 * present, `status: 'full'` is what says the omission is real rather than unloaded.
 */
const HYDRATABLE_FIELDS: readonly HydratableField[] = ['teacher', 'schedule', 'department', 'capacity'];

/** Whether one hydratable field is actually present on a course. */
function hasHydratableField(course: NormalizedCourse, field: HydratableField): boolean {
  switch (field) {
    case 'teacher': return (course.teacher ?? '').trim().length > 0;
    case 'schedule': return (course.schedule ?? []).length > 0;
    case 'department': return (course.department ?? '').trim().length > 0;
    case 'capacity': return course.capacity !== undefined;
    case 'location': return (course.schedule ?? []).some((entry) => entry.includes(' @ '));
    default: return false;
  }
}

/**
 * Report what of this section the page actually loaded.
 *
 * ### Why one fact, not five fields
 *
 * The selection page fetches `teacher`, `schedule`, `location`, `department` and `capacity` together, in one
 * request per course (`loadJxbxxZzxk`). Measured on a live page, 87 of 89 section rows had all five absent
 * and 2 had all five present — never a partial mixture caused by the page. So reporting five independent
 * gaps would invent a distinction the page does not make, and invite the reader to conclude "this course has
 * no teacher" when the truth is "this row has not been expanded".
 *
 * ### Why the page's own flag decides the status
 *
 * Field presence alone cannot separate the two cases, because a **hydrated** row may legitimately have no
 * room assignment or no listed department. `raw.wholeRowHydrated` — recorded by the extraction layer from
 * the page's `czzt` cell — is the only signal that answers "was this row fetched?", so `status` follows it
 * and the field lists are reported beside it rather than folded into it.
 *
 * @param course - the extracted course.
 * @returns the hydration status plus the available and missing field lists.
 */
export function describeSectionHydration(course: NormalizedCourse): SectionHydration {
  const raw = (course.raw ?? {}) as { wholeRowHydrated?: unknown };
  const rawHydrated = typeof raw.wholeRowHydrated === 'boolean' ? raw.wholeRowHydrated : null;
  const available = HYDRATABLE_FIELDS.filter((field) => hasHydratableField(course, field));
  const missing = HYDRATABLE_FIELDS.filter((field) => !hasHydratableField(course, field));
  // A source with no hydration notion falls back to what the fields themselves say: a section carrying any
  // detail field has clearly been loaded, and one carrying none has not.
  const status: SectionHydration['status'] = (rawHydrated ?? available.length > 0) ? 'full' : 'basic';
  return { status, available, missing, rawHydrated };
}

/**
 * State the scope the score came from, and what that scope does and does not represent.
 *
 * @param review - the matched review, when there was one.
 * @param course - the input course, which is what says whether the caller named a teacher.
 * @param teacherMatchConfidence - confidence of the teacher-level match, or null when none was attempted.
 * @returns the context block attached to every recommendation.
 */
export function describeReviewContext(
  review: CourseReview | undefined,
  course: NormalizedCourse,
  teacherMatchConfidence: number | null,
): ReviewContext {
  const teacherSpecified = (course.teacher ?? '').trim().length > 0;
  const reviewTeacher = (review?.teacher ?? '').trim();
  const teacher = reviewTeacher.length > 0 ? reviewTeacher : null;
  const scope = review?.aggregateScope === 'course' ? 'course' : 'teacher';
  const reviewCount = review?.reviewCount ?? 0;

  let aggregationNote: string;
  if (scope === 'course') {
    aggregationNote = `该评价覆盖课程整体（共 ${reviewCount} 条学生评价），不代表任何单一位教师`;
  } else if (!teacherSpecified) {
    /**
     * The page named no teacher, but the corpus offered exactly one candidate and the matcher bound it.
     *
     * The wording carries real weight. Measured on a live page, a teacher-less course bound a corpus teacher,
     * and a UI line reading "评价来源：刘嘉梅老师" would state an attribution the **page never made** — the
     * student's own section may be taught by someone else entirely. So the note leads with what is not known
     * and presents the bound name as the corpus's subject, not as this section's teacher.
     */
    aggregationNote = teacher === null
      ? `匹配到的评价未标注教师（${reviewCount} 条学生评价），仅依据课程名称匹配，无法确认是否为该教学班教师`
      : `匹配到的评价对应 ${teacher} 老师（${reviewCount} 条学生评价），但页面未提供本教学班的教师信息，`
        + '无法确认本班是否由该教师授课';
  } else {
    aggregationNote = `该评价来自指定教师 ${teacher ?? course.teacher ?? ''}（${reviewCount} 条学生评价）`;
  }

  return { scope, reviewCount, teacherSpecified, teacher, teacherMatchConfidence, aggregationNote };
}

/**
 * Compute pooled coverage from what the caller reported.
 *
 * @param input - the caller's counts; `exhausted` may be null when the source exposes no such flag.
 * @returns the coverage block, with a ratio that is null rather than 0 when nothing was discovered.
 */
export function buildDataCoverage(input: {
  coursesDiscovered: number;
  sectionsDiscovered: number;
  sectionsHydrated: number;
  exhausted?: boolean | null;
}): DataCoverage {
  const { coursesDiscovered, sectionsDiscovered, sectionsHydrated } = input;
  return {
    coursesDiscovered,
    sectionsDiscovered,
    sectionsHydrated,
    hydratedRatio: sectionsDiscovered > 0 ? sectionsHydrated / sectionsDiscovered : null,
    exhausted: input.exhausted ?? null,
  };
}

/** Dependencies of the pipeline. */
export interface RecommendDeps {
  /** Providers to consult, in priority order. */
  providers: readonly ReviewProvider[];
  /**
   * Every host policy value the engine needs. REQUIRED.
   *
   * It replaces the former `candidateLimit` field and the four values this module used to import from the application's config:
   * a reusable engine owns no host default, so the policy is an input and the module has exactly one place to read it from.
   */
  policy: RecommendationPolicy;
  /** Matching strategy. */
  matcher?: CourseMatcher;
  /** Match threshold override (tests use this). */
  matchThreshold?: number;
  /** Clock, injected for deterministic output. */
  now?: () => Date;
  /**
   * Per-provider lookup override. The plugin supplies an implementation that
   * adds disk-backed corpus caching; tests supply fakes.
   */
  lookup?: ProviderLookup;
  /**
   * How many raw review rows `lookupReviews` may expose as evidence.
   *
   * Storage and computation always use the full corpus; this bounds only what
   * is handed to the model.
   */
  evidenceSampleLimit?: number;
}

/** Options for a recommendation run. */
export interface RecommendOptions {
  topN?: number;
  preferences?: Partial<RankingPreferences>;
  /** Extra providers appended to the injected set. */
  extraProviders?: readonly ReviewProvider[];
}

/**
 * Build the default provider lookup from a provider list.
 *
 * ## Structured evidence is passed through for ONE provider, and withheld for several
 *
 * `ReviewSearchResult` carries three aggregates beside its rows — `courseLevel`, `teachingClassLevel` and
 * `courseSupplementary`. They are what `calculateReviewConfidence` reads for the course's row-level hygiene and for the current
 * teaching class's own evidence, so losing them here silently degrades every recommendation to the bucket-only fallback.
 *
 * They travel ONLY when there is exactly one provider:
 *
 * - **one provider** — single source, so the aggregates describe exactly the rows that were returned. Passed through unchanged.
 * - **several providers** — `reviews` is concatenated across providers, so any single provider's aggregate would be a count over
 *   ONE source attached to a corpus built from SEVERAL. `dataHygiene` divides by `courseLevel.courseReviewCount`, so that
 *   mismatch is not cosmetic: it would compute a ratio whose numerator and denominator come from different sets of rows.
 *
 * There is deliberately no "first non-undefined wins" here. That rule exists in `lookupReviews` as an implementation detail of a
 * path that calls each provider directly; it has no contract behind it, and copying it here would encode an unaudited merge rule.
 * For several providers the aggregates are therefore ABSENT rather than guessed — not merged, not first, not last, and no
 * canonical provider is assumed — until a cross-provider rule is defined on its own. Nothing in production registers more than one
 * provider today, so this is a constraint on a future change rather than a current behaviour.
 *
 * @param providers - the providers to consult, in priority order.
 * @param candidateLimit - the per-query row cap, from the host policy.
 * @returns a lookup that merges rows and preserves single-source aggregates.
 */
export function defaultLookup(providers: readonly ReviewProvider[], candidateLimit: number): ProviderLookup {  return async (query) => {
    const warnings: string[] = [];
    const reviews: CourseReview[] = [];
    let fromCache = false;
    /*
     * Held as separate bindings rather than collected into an array, because the rule is about the NUMBER of sources: with more
     * than one, none of them may be published.
     */
    let courseLevel: ReviewSearchResult['courseLevel'];
    let teachingClassLevel: ReviewSearchResult['teachingClassLevel'];
    let courseSupplementary: ReviewSearchResult['courseSupplementary'];
    /**
     * Excerpts as the providers reported them, before the engine's own total cap.
     *
     * The provider already bounded and de-duplicated ITS array; this collects across providers so that a two-provider run cannot
     * publish six excerpts for one course. Teachers' identities are NOT re-derived here — each excerpt arrives scoped.
     */
    const reportedExcerpts: ReviewExcerpt[] = [];
    /** One entry per provider query, in call order. */
    const outcomes: ReviewSourceQueryOutcome[] = [];
    const failureKinds: ReviewSourceFailureKind[] = [];
    /** Accumulated from each provider's own report, so a multi-request call is counted at request granularity. */
    let providerHealth: ReviewSourceHealth = rollUpReviewSourceHealth([]);
    for (const provider of providers) {
      try {
        const result = await provider.searchCourse({ ...query, limit: candidateLimit });
        reviews.push(...result.reviews);
        warnings.push(...result.warnings);
        if (result.fromCache) fromCache = true;
        /*
         * A provider that knows how many REQUESTS it made reports its own health, and that is authoritative: one `searchCourse` can issue two
         * requests, so counting one outcome per call would understate a partial failure. A provider that reports nothing gets the one fact
         * known here — its call completed — which keeps an injected fake working without inventing a failure.
         */
        providerHealth = mergeReviewSourceHealth(
          providerHealth,
          result.reviewSource ?? rollUpReviewSourceHealth([result.reviews.length > 0 ? 'rows' : 'empty']),
        );
        if (providers.length === 1) {
          courseLevel = result.courseLevel;
          teachingClassLevel = result.teachingClassLevel;
          courseSupplementary = result.courseSupplementary;
        }
        /*
         * Collected from EVERY provider, not only from a lone one. Three aggregates must be published by one source or by none,
         * because they are alternative readings of one corpus; a quotation is not an aggregate, so a provider that offers one
         * is contributing a fact rather than a second interpretation.
         */
        reportedExcerpts.push(...(result.reviewExcerpts ?? []));
      } catch (error) {
        /*
         * The message is kept for the internal warnings, but the STRUCTURED outcome is what a caller may rely on: a public result must not
         * require anyone to parse this sentence to learn whether the source failed.
         */
        warnings.push(`${provider.id} 查询失败：${(error as Error).message}`);
        outcomes.push('unavailable');
        const kind = classifyProviderFailure(error);
        if (!failureKinds.includes(kind)) failureKinds.push(kind);
        // A provider that threw reports no health of its own, so this failed call is recorded here.
        providerHealth = mergeReviewSourceHealth(providerHealth, rollUpReviewSourceHealth(['unavailable'], [kind]));
      }
    }
    return {
      reviews,
      provider: providers.map((provider) => provider.id).join('+'),
      fromCache,
      warnings,
      /*
       * The structured facts a caller can branch on. `warnings` above stays for human diagnostics, but nothing public may depend on reading
       * its text to find out whether the source failed — so the rolled-up health is published here as well as the per-query outcomes.
       */
      outcomes,
      ...(failureKinds.length === 0 ? {} : { failureKinds }),
      /*
       * The provider-reported health when any provider gave one, otherwise the call-level roll-up. Reported rather than recomputed, so the
       * request count matches what was actually attempted.
       */
      reviewSource: providerHealth.queries > 0
        ? providerHealth
        : rollUpReviewSourceHealth(outcomes, failureKinds),
      // Offsets keep the keys absent rather than present-and-undefined, which is what `ReviewSearchResult` documents.
      ...(courseLevel === undefined ? {} : { courseLevel }),
      ...(teachingClassLevel === undefined ? {} : { teachingClassLevel }),
      ...(courseSupplementary === undefined ? {} : { courseSupplementary }),
      // Always present: the projection below may legitimately produce an empty array, and `[]` is a real answer.
      reviewExcerpts: capReviewExcerpts(reportedExcerpts),
    };
  };
}

/**
 * Reduce a provider failure to the coarse kind a public result may carry.
 *
 * The provider's own `code` is the input, because that is where the distinction is actually known: it already separates a network failure, an
 * HTTP status, an unparseable body and an unexpected shape. `ReviewProviderError` arrives from the provider package as a plain object at
 * runtime, so its `code` is read structurally rather than by importing the class — the engine must not need a provider's concrete error type
 * to describe a failure, and an unknown provider's error still has to be answerable.
 *
 * @param error - whatever the provider threw.
 * @returns `network`, `http` or `malformed`; unknown codes are reported as `malformed`, because an answer that could not be interpreted is
 *   indistinguishable from one that arrived in an unusable form.
 */
function classifyProviderFailure(error: unknown): ReviewSourceFailureKind {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  if (code === 'network-error' || code === 'timeout' || code === 'aborted') return 'network';
  if (code === 'http-error' || code.startsWith('http-') || code === 'rate-limited') return 'http';
  return 'malformed';
}

/**
 * Roll a set of query outcomes up into one health record.
 *
 * `status` is derived from the counts, so it can never contradict them: nothing failed is `healthy`, everything failed is `unavailable`, and a
 * mix is `partial`. An empty outcome list is `healthy` with `queries: 0` — no failure was observed, and claiming `unavailable` would blame
 * the source for a query that was never made.
 *
 * @param outcomes - one entry per review-source query.
 * @param failureKinds - the failure kinds seen, when any query failed.
 * @returns the health record.
 */
function rollUpReviewSourceHealth(
  outcomes: readonly ReviewSourceQueryOutcome[],
  failureKinds: readonly ReviewSourceFailureKind[] = [],
): ReviewSourceHealth {
  const rows = outcomes.filter((outcome) => outcome === 'rows').length;
  const empty = outcomes.filter((outcome) => outcome === 'empty').length;
  const unavailable = outcomes.filter((outcome) => outcome === 'unavailable').length;
  const queries = outcomes.length;
  const status: ReviewSourceHealth['status'] = unavailable === 0
    ? 'healthy'
    : unavailable === queries ? 'unavailable' : 'partial';
  return {
    status,
    queries,
    rows,
    empty,
    unavailable,
    ...(failureKinds.length === 0 ? {} : { failureKinds: [...failureKinds] }),
  };
}

/**
 * Combine one course's health with the run's running total.
 *
 * Counts add; the status is re-derived from the combined counts by {@link rollUpReviewSourceHealth}'s rule, so a run that saw one unavailable
 * course among ten reports `partial` rather than inheriting either extreme.
 *
 * @param total - the run-level health so far.
 * @param course - this course's health.
 * @returns the updated run-level health.
 */
function mergeReviewSourceHealth(total: ReviewSourceHealth, course: ReviewSourceHealth): ReviewSourceHealth {
  const kinds = [...(total.failureKinds ?? [])];
  for (const kind of course.failureKinds ?? []) if (!kinds.includes(kind)) kinds.push(kind);
  const queries = total.queries + course.queries;
  const unavailable = total.unavailable + course.unavailable;
  const status: ReviewSourceHealth['status'] = unavailable === 0
    ? 'healthy'
    : unavailable === queries ? 'unavailable' : 'partial';
  return {
    status,
    queries,
    rows: total.rows + course.rows,
    empty: total.empty + course.empty,
    unavailable,
    ...(kinds.length === 0 ? {} : { failureKinds: kinds }),
  };
}

/**
 * Project one aggregate's grade statistics into the display shape.
 *
 * A projection, not a computation: every number is the aggregate's own, and `meanGrade` / `medianGrade` stay **absent** when the source had
 * none, so a course with no usable grades cannot be shown as `0` or `null`.
 *
 * @param source - a teacher bucket, a teaching-class roll-up, or a course roll-up.
 * @returns the display aggregate, or `undefined` when there is no source at all.
 */
function projectGradeAggregate(source: CourseReview | CourseLevelReview | undefined): GradeAggregate | undefined {
  if (source === undefined) return undefined;
  /*
   * The teacher bucket and the roll-ups carry the same facts in different places: a `CourseReview` states `gradedSampleCount` on itself and
   * keeps no `grades`, while a `CourseLevelReview` keeps the whole `GradeStatistics` under `grades`. Both are read, and neither is
   * recomputed here.
   */
  const grades = 'grades' in source ? source.grades : undefined;
  const gradedSampleCount = 'gradedSampleCount' in source && typeof source.gradedSampleCount === 'number'
    ? source.gradedSampleCount
    : grades?.validSampleCount ?? 0;
  return {
    ...(source.meanGrade === undefined ? {} : { meanGrade: source.meanGrade }),
    ...(source.medianGrade === undefined ? {} : { medianGrade: source.medianGrade }),
    gradedSampleCount,
    gradeDistribution: grades?.percentageDistribution ?? {},
  };
}

/**
 * Assemble a recommendation's grade aggregates from the aggregates the lookup already produced.
 *
 * ## Which scopes are published, and why `teacher` is conditional
 *
 * `teachingClass` and `course` are projected whenever the provider produced them, because they describe different row sets and the caller
 * chooses between them. `teacher` is published **only for a single-teacher class**: for a co-taught class the matched `review` is one
 * teacher's bucket, so exposing it as "the teacher aggregate" would invite a caller to show one co-teacher's grades as the class's. Absent
 * is the honest answer there, and `teacherSet.names` already says why.
 *
 * @param review - the matched teacher bucket, when there is one.
 * @param teachingClassLevel - the class's own roll-up, when the provider partitioned the corpus.
 * @param courseLevel - the whole-course roll-up, when the provider produced one.
 * @param teacherNames - the class's teachers, normalized and deduplicated.
 * @returns the aggregates, always with `teacherSet` so the structure is never conditional.
 */
function describeGradeAggregates(
  review: CourseReview | undefined,
  teachingClassLevel: CourseLevelReview | undefined,
  courseLevel: CourseLevelReview | undefined,
  teacherNames: readonly string[],
): RecommendationGradeAggregates {
  const teacher = teacherNames.length === 1 ? projectGradeAggregate(review) : undefined;
  const teachingClass = projectGradeAggregate(teachingClassLevel);
  const course = projectGradeAggregate(courseLevel);
  return {
    teacherSet: { names: [...teacherNames] },
    ...(teacher === undefined ? {} : { teacher }),
    ...(teachingClass === undefined ? {} : { teachingClass }),
    ...(course === undefined ? {} : { course }),
  };
}

/** Deduplicate provider queries for identical course/teacher pairs. */
interface QueryPlan {
  courses: NormalizedCourse[];
  queries: Map<string, CourseSearchQuery>;
}

/**
 * Work out which distinct provider queries a course list needs.
 *
 * Courses are grouped by `normalizedName + teacher`, so scanning a page with the
 * same course listed under three sections issues one provider query, not three.
 * The first course in each group carries the query.
 *
 * ## Why a co-taught class is queried by course name only
 *
 * The provider's `instructor` filter is a substring match on a column holding one teacher per review row. A published cell
 * like `翟显、廖冬梅、滕芸、余伟、蔡天富、杨尚尚、葛东升` is a list of people, so sending it whole matches nothing and the
 * class would silently lose every review; sending just the first name would instead treat seven teachers as one. A
 * co-taught class therefore drops the filter and relies on the course-name query plus local set-overlap matching, which can
 * see every teacher the class names. A single-teacher cell keeps the filter, which is exact and narrows the corpus.
 *
 * @param courses - eligible courses.
 * @returns the courses and the unique queries keyed by group.
 */
export function planQueries(courses: readonly NormalizedCourse[]): QueryPlan {
  const queries = new Map<string, CourseSearchQuery>();
  for (const course of courses) {
    const teacherKey = course.normalizedTeacher ?? normalizeTeacherName(course.teacher);
    const key = `${course.normalizedName}\u0000${teacherKey}`;
    if (queries.has(key)) continue;
    const query: CourseSearchQuery = { courseName: course.courseName };
    /*
     * The filter is taken from the parser rather than from the raw cell: it returns a name only for a cell that names
     * exactly one person, so a co-taught, missing or unusable cell yields no `instructor` parameter at all.
     */
    const teacherFilter = queryTeacherFilter(course.teacher);
    if (teacherFilter !== undefined && teacherFilter.trim().length > 0) query.teacher = teacherFilter;
    /*
     * The COMPLETE published teacher set travels separately, for local partitioning only. It is not the wire filter: for a
     * co-taught class `teacher` is absent while this carries every named teacher, which is what lets the provider work out
     * which returned rows are related to this class.
     */
    const localTeacherNames = teacherNamesOfCourse(course.teacher);
    if (localTeacherNames.length > 0) query.localTeacherNames = localTeacherNames;
    if (course.courseCode !== undefined) query.courseCode = course.courseCode;
    queries.set(key, query);
  }
  return { courses: [...courses], queries };
}

/** The group key used by {@link planQueries}. */
export function groupKey(course: NormalizedCourse): string {
  const teacherKey = course.normalizedTeacher ?? normalizeTeacherName(course.teacher);
  return `${course.normalizedName}\u0000${teacherKey}`;
}

/**
 * Narrow a provider's teacher candidates to the CURRENT teaching class.
 *
 * ## The problem this solves
 *
 * The provider reports every teacher its corpus names, which is right for whole-course context but wrong for "who teaches
 * this class". Real data makes the difference stark: for one course the corpus named six "teachers" — `廖冬梅` plus
 * `不错`, `挺有意思`, `好多老师`, `几位老师共同授课` and `瞿显等` — where five are review text or a typo, not people. Exposing
 * that list let a SINGLE-teacher class be reported as having several teachers, which is a wrong statement about the course
 * rather than a cosmetic blemish.
 *
 * ## The rule
 *
 * A candidate belongs to the class when its teacher set overlaps the class's teacher set. Overlap is enough — full-set
 * equality would drop every co-taught class, and each name of a co-taught corpus row becomes its own candidate during
 * aggregation, so comparing the candidate's own name is sufficient.
 *
 * ## What this does NOT do
 *
 * It does not re-classify anything and does not touch the provider. `不错` stays a `valid` teacher of the whole course and
 * keeps its bucket, its counts and its place in `courseLevel`; it simply is not a teacher of THIS class, so it is absent from
 * this class's candidate list. Deleting it from the provider would lose real course-level information.
 *
 * @param candidates - every teacher the provider found.
 * @param localTeacherNames - the selection page's teacher set for this class, normalized.
 * @returns the candidates related to the class, or the input unchanged when the class's teachers are unknown.
 */
export function currentClassTeacherCandidates(
  candidates: readonly TeacherCandidate[],
  localTeacherNames: readonly string[],
): TeacherCandidate[] {
  // No published teacher set means there is no ground truth to compare against. Guessing from the names themselves would
  // reintroduce exactly the misattribution this guards against, so the caller's list is passed through untouched.
  if (localTeacherNames.length === 0) return [...candidates];
  return candidates.filter((candidate) => teacherSetRelation(localTeacherNames, candidate.teacher) === 'agree');
}

/**
 * Run the full pipeline over an already-extracted course list.
 *
 * @param courses - normalized courses from an adapter.
 * @param options - top N and user preferences.
 * @param deps - providers, matcher, and clock.
 * @param coverage - pool counts as the **caller** observed them, or omitted when there is no page behind
 *   this run. Never inferred here: how many courses a selection system holds, and whether its list has been
 *   loaded to the end, exist only in the page DOM, so the engine reports what it was told and `null`
 *   otherwise rather than writing a default that would read as fact.
 * @returns the structured recommendation result.
 */
export async function recommendCourses(
  courses: readonly NormalizedCourse[],
  options: RecommendOptions,
  deps: RecommendDeps,
  coverage?: {
    coursesDiscovered: number;
    sectionsDiscovered: number;
    sectionsHydrated: number;
    exhausted?: boolean | null;
  },
): Promise<RecommendationResult> {
  const now = deps.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  const threshold = deps.matchThreshold ?? REVIEW_MATCH_THRESHOLD;
  const matcher = deps.matcher ?? matchCourse;
  const candidateLimit = deps.policy.candidateLimit;
  const providers = [...deps.providers, ...(options.extraProviders ?? [])];
  const lookup = deps.lookup ?? defaultLookup(providers, candidateLimit);

  // 1. Preferences are validated and normalized first, so an invalid payload can
  //    never produce a silently wrong ranking. The default weights are supplied
  //    here because they are host policy, not an algorithm input.
  const preferences = normalizePreferences(options.preferences, deps.policy.defaultPreferences);
  const requestedTopN = options.topN ?? deps.policy.defaultTopN;
  const topN = Math.max(0, Math.min(deps.policy.maxTopN, Math.trunc(Number.isFinite(requestedTopN) ? requestedTopN : deps.policy.defaultTopN)));

  // 2. Eligibility, strictly before ranking.
  const { eligible, excluded } = filterEligible(courses, preferences);

  // 3. Deduplicated provider lookups.
  const plan = planQueries(eligible);
  const lookupWarnings: string[] = [];
  let usedCache = false;
  const byGroup = new Map<string, CourseReview[]>();
  /*
   * The class-scoped roll-up travels beside the candidates. `matchCourse` only receives `CourseReview[]`, so it has no
   * provider aggregate context and cannot attach this itself — the pipeline is the layer holding both the provider result
   * and the MatchResult, which is why the attachment happens here.
   */
  const scopedByGroup = new Map<string, CourseLevelReview | undefined>();
  /** The whole-course roll-up, authoritative for the teacher-column hygiene counts (row-level, unlike a bucket's). */
  const courseLevelByGroup = new Map<string, CourseLevelReview | undefined>();
  /** Per-course review-source health, so each candidate can state it without re-deriving it. */
  const healthByGroup = new Map<string, ReviewSourceHealth>();
  /**
   * Per-course bounded review excerpts, as the provider scoped them.
   *
   * Travelling beside the candidates for the same reason the class-scoped roll-up does: `matchCourse` receives only
   * `CourseReview[]` and cannot attach provider context itself, while this pipeline holds both the provider result and the
   * `MatchResult`. Nothing here re-decides which teacher a comment belongs to.
   */
  const excerptsByGroup = new Map<string, ReviewExcerpt[]>();

  const keys = [...plan.queries.keys()];
  const lookups = keys.map(async (key) => {
    const query = plan.queries.get(key);
    if (query === undefined) return;
    const result = await lookup(query);
    byGroup.set(key, result.reviews);
    scopedByGroup.set(key, result.teachingClassLevel);
    courseLevelByGroup.set(key, result.courseLevel);
    excerptsByGroup.set(key, result.reviewExcerpts ?? []);
    /*
     * A provider that reports no facts still contributes the one thing that is known: the call completed. Defaulting to a healthy record with a
     * single successful outcome keeps an injected fake working without pretending a failure happened.
     */
    healthByGroup.set(key, result.reviewSource ?? rollUpReviewSourceHealth([result.reviews.length > 0 ? 'rows' : 'empty']));    if (result.fromCache) usedCache = true;
    for (const warning of result.warnings) lookupWarnings.push(warning);
  });
  // Providers already rate-limit internally, so groups may run concurrently.
  await Promise.all(lookups);

  // 4. Match every eligible course against its own group's candidates.
  const matches: MatchResult[] = eligible.map((course) => {
    const key = groupKey(course);
    const candidates = byGroup.get(key) ?? [];
    const match = matcher(course, candidates);
    const scoped = scopedByGroup.get(key);
    const corpus = courseLevelByGroup.get(key);
    /*
     * Attached as a new object rather than mutated, so a matcher returning a shared or frozen value is not altered.
     *
     * `courseLevel` is carried so confidence can later read the course's row-level teacher-column counts — the only
     * unit-consistent source for `dataHygiene`, since a bucket's own malformed/missing counts are structurally zero and
     * `validTeacherReviewCount` counts teacher ASSIGNMENTS rather than rows.
     *
     * It is attached ONLY when a review was bound, and that guard is what makes this change provably inert. Every read of
     * `match.courseLevel` in `calculateReviewConfidence` is a `review?.X ?? level?.X` fallback, and the bound review's fields
     * are required by type and always populated, so the level can never be consulted. Without the guard one case would
     * change: an unmatched course takes a `value: 0` early return but still publishes its `dataHygiene` component, which
     * would flip from 1 to a real ratio. Nothing consumes that value today, but "nothing consumes it" is not the same
     * guarantee as "it did not change", and this step is meant to change nothing at all.
     */
    const withScoped = scoped === undefined ? match : { ...match, teachingClassLevel: scoped };
    /*
     * The excerpts are attached whether or not a review was bound, because they answer a question about the COURSE and were scoped
     * by the provider against the same class teacher set the roll-up used. Absent rather than `[]` when there are none, so the
     * `MatchResult` does not grow three empty arrays per unmatched course; the entry construction publishes the array.
     */
    const excerpts = excerptsByGroup.get(key) ?? [];
    const withExcerpts = excerpts.length === 0 ? withScoped : { ...withScoped, reviewExcerpts: excerpts };
    if (corpus === undefined || withExcerpts.review === undefined) return withExcerpts;
    return { ...withExcerpts, courseLevel: corpus };
  });

  // 5. Rank deterministically on the **decision** score.
  const scored: CourseScore[] = matches.map((match) => {
    // `calculateCourseScore` derives the legacy four metrics from the decision
    // scores, so `components` and the total agree by construction.
    const legacy = calculateCourseScore(match.review, preferences);
    const breakdown = legacy.decision;
    return {
      course: match.course,
      score: legacy.score,
      components: legacy.components,
      appliedWeights: legacy.appliedWeights,
      redistributed: legacy.redistributed,
      match,
      confidence: calculateReviewConfidence(match),
      decision: breakdown,
    };
  });
  scored.sort((left, right) => compareDecisions(left, right));

  const recommendations: Recommendation[] = [];
  const ratedButNotRecommended: RatedButNotRecommendedEntry[] = [];
  const insufficientData: RecommendationResult['insufficientData'] = [];
  const ambiguousCandidates: RecommendationResult['ambiguousCandidates'] = [];

  for (const [index, entry] of scored.entries()) {
    const trusted = entry.match.review !== undefined && entry.match.confidence >= threshold;
    // `rankCourses` always fills this in; the fallback keeps the type honest for a
    // hand-built CourseScore.
    const breakdown = entry.decision
      ?? buildAspectBreakdown(entry.match.review, aspectWeightsFromPreferences(preferences));
    if (!trusted) {
      // An alias or fuzzy hit that did not clear the threshold is surfaced as a
      // candidate to confirm, never silently ranked.
      if (entry.match.method.startsWith('alias_') || entry.match.method.startsWith('fuzzy_')) {
        ambiguousCandidates.push({
          course: entry.course,
          method: entry.match.method,
          confidence: entry.match.confidence,
          reason: entry.match.note
            ?? `名称近似（${entry.match.method}，置信度 ${entry.match.confidence.toFixed(2)}），需确认后才会使用评价数据`,
        });
        continue;
      }
      insufficientData.push({
        course: entry.course,
        reason: entry.match.method === 'unmatched'
          ? (entry.match.note ?? '未匹配到评价记录')
          : `评价匹配不确定（${entry.match.method}，置信度 ${entry.match.confidence.toFixed(2)} < ${threshold}），未参与排序`,
        match: { method: entry.match.method, confidence: entry.match.confidence },
        /*
         * Carried here too, because this is exactly the list where the distinction matters most: "the site has no reviews for this course" and
         * "the site could not be reached" both land here, and only the health says which one happened.
         */
        reviewSource: healthByGroup.get(groupKey(entry.course)) ?? rollUpReviewSourceHealth([]),
      });
      continue;
    }
    if (entry.score === null || breakdown.decisionScore === null) {
      insufficientData.push({
        course: entry.course,
        reason: '评价记录存在，但没有任何可用的评分维度',
        match: { method: entry.match.method, confidence: entry.match.confidence },
        reviewSource: healthByGroup.get(groupKey(entry.course)) ?? rollUpReviewSourceHealth([]),
      });
      continue;
    }

    const warnings = buildWarnings(entry.match, entry.course, threshold);
    warnings.push(...warningsFromBreakdown(breakdown));
    // The weighting actually used, keyed by aspect so it can be compared against what was requested.
    // These differ whenever an aspect had no evidence, and the explanation has to say so.
    const effectiveWeights: Partial<Record<AspectKey, number>> = { ...breakdown.appliedWeights };
    const requestedWeights = aspectWeightsFromPreferences(preferences);
    const corpusReviews = entry.match.review?.reviewCount ?? 0;
    // The review's own aspect scores carry the counts the tier is graded on. When there is no review
    // (an unmatched entry) every aspect is genuinely zero-evidence, which the counts already say.
    const reviewScores = entry.match.review?.aspects?.scores ?? [];
    const evidenceStrength = breakdown.aspects.map((aspect) => {
      const score = reviewScores.find((candidate) => candidate.aspect === aspect.aspect);
      return score === undefined
        ? { aspect: aspect.aspect, level: 'none' as const, reviewsWithEvidence: 0, corpusReviews,
          coverage: 0, agreement: 0, note: '没有评价记录，无法评估证据强度' }
        : gradeEvidenceStrength(score, corpusReviews);
    });
    const recommendation: Recommendation = {
      rank: recommendations.length + 1,
      course: entry.course,
      reviewContext: describeReviewContext(
        entry.match.review,
        entry.course,
        // Confidence is a teacher-match figure only when a teacher was actually supplied; otherwise there is
        // no teacher match to be confident about.
        (entry.course.teacher ?? '').trim().length > 0 ? entry.match.confidence : null,
      ),
      sectionHydration: describeSectionHydration(entry.course),
      /*
       * Presentation data, projected from the aggregates the lookup already produced. It is deliberately built here, at the object
       * construction, because that is the only place the structured evidence was previously dropped: it lives on `MatchResult` all the way
       * through the lookup and was simply not carried into the recommendation.
       */
      gradeAggregates: describeGradeAggregates(
        entry.match.review,
        entry.match.teachingClassLevel,
        entry.match.courseLevel,
        /*
         * The canonical splitter, not a local one: `teacherNamesOfCourse` owns the rules for what counts as a teacher cell naming several
         * people, and re-deriving the names here would create a second, divergent answer to "is this class co-taught?".
         */
        teacherNamesOfCourse(entry.course.teacher),
      ),
      /*
       * The candidate's own review-source state. A `partial` or `unavailable` status qualifies every figure on this object, so it travels with
       * them rather than being looked up separately by a consumer.
       */
      reviewSource: healthByGroup.get(groupKey(entry.course)) ?? rollUpReviewSourceHealth([]),
      recommendationStatus: 'recommended',
      /*
       * The comments, carried for the same reason as `gradeAggregates` above and at the same construction site: the lookup produced
       * them and this is where they were previously dropped. They arrive already scoped and bounded by the provider — no teacher
       * matching happens here, and `[]` is published rather than `undefined` so a renderer has no maybe to interpret.
       */
      reviewExcerpts: entry.match.reviewExcerpts ?? [],
      score: entry.score,
      riskAdjustedScore: riskAdjustedScore(entry.score, entry.confidence.value),
      effectiveWeights,
      defaultWeights: { ...requestedWeights },
      effectiveWeightNotes: describeWeightRedistribution(
        requestedWeights,
        effectiveWeights,
        breakdown.missingDimensions,
      ),
      evidenceStrength,
      confidence: entry.confidence,
      reasons: buildAspectReasons(breakdown, entry.confidence),
      warnings,
      match: {
        method: entry.match.method,
        confidence: entry.match.confidence,
        trusted: true,
        ...(entry.match.aliasUsed === true ? { aliasUsed: true } : {}),
      },
      aspects: breakdown,
      missingDimensions: breakdown.missingDimensions,
      topAspects: breakdown.aspects
        .filter((aspect) => aspect.decision !== undefined && aspect.weight > 0)
        .sort((left, right) => (right.contribution ?? 0) - (left.contribution ?? 0))
        .slice(0, 3)
        .map((aspect) => aspect.aspect),
      components: entry.components,
      appliedWeights: entry.appliedWeights,
      redistributed: entry.redistributed,
    };
    if (entry.match.review !== undefined) recommendation.review = entry.match.review;
    recommendations.push(recommendation);
    if (recommendations.length >= topN) {
      /**
       * The cut has been reached. Everything below it is still scored and still ordered, so record it
       * instead of discarding it.
       *
       * This is the Step 36a.5 finding F2: previously the loop simply `break`ed, so a course that ranked
       * 6th of 60 reached the caller looking identical to a course that had no review data at all — one was
       * a quality judgement, the other a data gap, and nothing in the result distinguished them.
       *
       * Only entries that reached this point are listed, so `ratedButNotRecommended` is by construction all
       * courses with a genuine score below the cut — never a silent bucket for data failures.
       */
      for (const rest of scored.slice(index + 1)) {
        const restTrusted = rest.match.review !== undefined && rest.match.confidence >= threshold;
        const restBreakdown = rest.decision
          ?? buildAspectBreakdown(rest.match.review, aspectWeightsFromPreferences(preferences));
        if (!restTrusted || rest.score === null || restBreakdown.decisionScore === null) continue;
        ratedButNotRecommended.push({
          course: rest.course,
          // Ranks continue the same order, so the list reads as "6th, 7th, …" rather than restarting at 1.
          rank: recommendations.length + ratedButNotRecommended.length + 1,
          score: rest.score,
          reviewContext: describeReviewContext(
            rest.match.review,
            rest.course,
            (rest.course.teacher ?? '').trim().length > 0 ? rest.match.confidence : null,
          ),
          sectionHydration: describeSectionHydration(rest.course),
          /*
           * THE SAME PROJECTION THE RECOMMENDATION PATH USES, from the same lookup result.
           *
           * PRE-RELEASE-UX-A11. `rest.match` carries the identical structured evidence a recommended entry's `match` does, so the aggregates are projected here
           * rather than recomputed: no second algorithm, no re-fetch, and no way for the two paths to describe one course differently. What varies between them is
           * only whether the entry is above or below the cut.
           *
           * This is presentation data. It is populated AFTER the entry has already been placed, so nothing about `rank`, `score` or membership can depend on it.
           */
          gradeAggregates: describeGradeAggregates(
            rest.match.review,
            rest.match.teachingClassLevel,
            rest.match.courseLevel,
            teacherNamesOfCourse(rest.course.teacher),
          ),
          /*
           * The same excerpt array the recommended path publishes, read from the same lookup result. A course that missed the cut is still a course a reader may open,
           * and its comments must be the provider's scoping — not a second derivation that could disagree with the entry above the cut.
           */
          reviewExcerpts: rest.match.reviewExcerpts ?? [],
        });
      }
      break;
    }
  }

  return {
    recommendations,
    ratedButNotRecommended,
    considered: eligible.length,
    excluded,
    insufficientData,
    ambiguousCandidates,
    preferences,
    /*
     * The run-level roll-up: a fold over every course's health, so a caller can say "some review requests failed" without walking the
     * candidates. It reports only what was observed and never feeds back into scoring.
     */
    reviewSource: [...healthByGroup.values()].reduce(
      mergeReviewSourceHealth,
      rollUpReviewSourceHealth([]),
    ),
    dataCoverage: coverage === undefined
      ? null
      : buildDataCoverage({
        coursesDiscovered: coverage.coursesDiscovered,
        sectionsDiscovered: coverage.sectionsDiscovered,
        sectionsHydrated: coverage.sectionsHydrated,
        exhausted: coverage.exhausted,
      }),
    meta: {
      adapters: unique(courses.map((course) => course.source)),
      providers: unique(providers.map((provider) => provider.id)),
      reviewMatchThreshold: threshold,
      generatedAt,
      usedCache: usedCache || lookupWarnings.some((warning) => warning.includes('缓存')),
    },
  };
}

/** Warnings derived from the aspect breakdown, e.g. thin per-dimension evidence. */
function warningsFromBreakdown(breakdown: AspectBreakdown): string[] {
  const warnings: string[] = [];
  for (const aspect of breakdown.aspects) {
    if (aspect.decision === undefined || aspect.weight <= 0) continue;
    if (aspect.evidenceReviewCount > 0 && aspect.evidenceReviewCount < 3) {
      warnings.push(`${aspectLabel(aspect.aspect)} 仅有 ${aspect.evidenceReviewCount} 条评价提到，该维度不确定性较高`);
    }
  }
  return warnings;
}
/**
 * Deterministic ordering on the decision score.
 *
 * Ties break on confidence, then review count, then course code/name, so the
 * result can never depend on input order.
 *
 * Exported so the ordering CONTRACT can be asserted directly. It is the comparator `recommendCourses` actually sorts
 * with, and it is deliberately not the same function as Core's `compareScores`: this one is the recommend path's own
 * ordering and must stay pinned even if the Core comparator is ever adjusted. Asserting the contract through a full
 * pipeline run cannot reach its later tie-break layers, because they only trigger on an exact match of every earlier key.
 *
 * @param left - first scored course.
 * @param right - second scored course.
 * @returns negative when `left` ranks first.
 */
export function compareDecisions(left: CourseScore, right: CourseScore): number {
  if (left.score === null && right.score !== null) return 1;
  if (left.score !== null && right.score === null) return -1;
  if (left.score !== null && right.score !== null && left.score !== right.score) {
    return right.score - left.score;
  }
  if (left.confidence.value !== right.confidence.value) {
    return right.confidence.value - left.confidence.value;
  }
  const leftReviews = left.match.review?.reviewCount ?? 0;
  const rightReviews = right.match.review?.reviewCount ?? 0;
  if (leftReviews !== rightReviews) return rightReviews - leftReviews;
  const leftKey = left.course.courseCode ?? left.course.normalizedName;
  const rightKey = right.course.courseCode ?? right.course.normalizedName;
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  if (left.course.courseName !== right.course.courseName) {
    return left.course.courseName < right.course.courseName ? -1 : 1;
  }
  return 0;
}

/**
 * Rule-based reasons: facts about the numbers, not generated prose.
 *
 * The agent may polish the wording, but it must not change these statements —
 * they are derived from the aspect breakdown and the confidence inputs, so they
 * say the same thing every run.
 *
 * @param breakdown - the aspect breakdown behind the score.
 * @param confidence - the review confidence for the same record.
 * @returns short fact lines, strongest contribution first.
 */
function buildAspectReasons(breakdown: AspectBreakdown, confidence: ReviewConfidence): string[] {
  const reasons: string[] = [];
  const ranked = breakdown.aspects
    .filter((aspect) => aspect.decision !== undefined)
    .sort((left, right) => (right.decision as number) - (left.decision as number));

  for (const aspect of ranked) {
    const decision = aspect.decision as number;
    if (decision >= 7) reasons.push(`${aspectLabel(aspect.aspect)}较好（${decision.toFixed(1)}/10）`);
    else if (decision <= 4) reasons.push(`${aspectLabel(aspect.aspect)}偏弱（${decision.toFixed(1)}/10）`);
  }
  if (reasons.length === 0 && ranked[0] !== undefined) {
    reasons.push(`${aspectLabel(ranked[0].aspect)} 居中（${(ranked[0].decision as number).toFixed(1)}/10）`);
  }
  for (const aspect of breakdown.aspects) {
    if (aspect.raw === undefined) continue;
    if (Math.abs((aspect.decision as number) - aspect.raw) >= 1) {
      reasons.push(
        `${aspectLabel(aspect.aspect)} 原始分 ${aspect.raw.toFixed(1)}，`
        + `因证据仅 ${aspect.evidenceReviewCount} 条按可靠性 ${aspect.reliability.toFixed(2)} 向中性收缩为 `
        + `${(aspect.decision as number).toFixed(1)}`,
      );
    }
  }
  const strong = confidence.inputs.evidenceReviewCount;
  reasons.push(strong >= 10
    ? `教师评价样本较充分（本次计分 ${strong} 条）`
    : `教师评价样本较少（本次计分 ${strong} 条），结论仅供参考`);
  if (breakdown.missingDimensions.length > 0) {
    reasons.push(`缺少可靠数据的维度：${breakdown.missingDimensions.map(aspectLabel).join('、')}`);
  }
  return reasons;
}

/** Deterministic caveats for one recommendation. */
function buildWarnings(match: MatchResult, course: NormalizedCourse, threshold: number): string[] {
  const warnings: string[] = [];
  if (match.note !== undefined) warnings.push(match.note);
  if (match.confidence < threshold + 0.1) {
    warnings.push(`评价匹配置信度 ${match.confidence.toFixed(2)} 接近阈值，建议人工核对评价来源课程是否为同一门`);
  }
  if (match.review !== undefined && match.review.reviewCount < 5) {
    warnings.push(`评价样本仅 ${match.review.reviewCount} 条，统计意义有限`);
  }
  const courseTeacher = course.normalizedTeacher ?? normalizeTeacherName(course.teacher);
  const reviewTeacher = match.review?.normalizedTeacher;
  if (courseTeacher.length > 0 && reviewTeacher !== undefined && reviewTeacher.length > 0 && courseTeacher !== reviewTeacher) {
    warnings.push(`教师不一致：选课页为「${course.teacher ?? ''}」，评价记录为「${match.review?.teacher ?? ''}」`);
  }
  if (course.availability === 'unknown') {
    // Same field, same precise name: it is the round's quota the page did not publish, not "seats free now".
    warnings.push('页面未提供本轮余量，是否可选需要人工确认');
  }
  return warnings;
}

/** Stable, de-duplicated, sorted list. */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** Result of a single-course review lookup. */
export interface LookupResult {
  course: { courseName: string; teacher?: string; courseCode?: string };
  providers: Array<{
    id: string;
    status: 'ok' | 'error';
    fromCache: boolean;
    candidates: CourseReview[];
    /** Course-level roll-up over every row the provider returned, when it produced one. */
    courseLevel?: CourseLevelReview;
    /** Class-scoped roll-up over the rows related to the current teaching class, when the provider partitioned them. */
    teachingClassLevel?: CourseLevelReview;
    warnings: string[];
    error?: string;
  }>;
  /**
   * Course-level roll-up for the queried name, from the first provider that
   * produced one. This is the number a caller may call "the course total"; the
   * per-teacher `reviewCount` inside `matches[].review` must never be reported
   * as such.
   */
  courseLevel?: CourseLevelReview;
  /**
   * The CURRENT teaching class's own roll-up, from the first provider that produced one.
   *
   * Carried on the lookup result so a caller that binds a match by hand — `explainCourse` does — can attach it to that
   * `MatchResult` and get class-scoped confidence. It is NOT a substitute for {@link courseLevel}: this covers only the
   * rows related to the class's teachers, so it answers "how much backs this class" while `courseLevel` answers "how much
   * exists for this course name".
   */
  teachingClassLevel?: CourseLevelReview;
  /**
   * How this course's review queries ended.
   *
   * Assigned once the provider loop is done, so the initial object can be built without inventing a value.
   */
  reviewSource?: ReviewSourceHealth;
  /** Best match per provider that returned candidates. */
  matches: Array<{
    /** The course that was asked about, so confidence can see the request. */
    course: NormalizedCourse;
    /** The course-level roll-up, when the provider produced one. */
    courseLevel?: CourseLevelReview;
    provider: string;
    method: MatchResult['method'];
    confidence: number;
    trusted: boolean;
    review?: CourseReview;
    alternatives?: CourseReview[];
    note?: string;
    /** True when an alias resolved this match. */
    aliasUsed?: boolean;
  }>;
  /**
   * Teachers the corpus holds for this course, most-reviewed first, and whether
   * several of them tie for best. Present when the query named no teacher and
   * the course has more than one: in that case `matches[].review` is the
   * course-level roll-up, never a single teacher's bucket.
   *
   * **Aggregation always keeps every candidate** — this array is never truncated
   * by a presentation concern. The tool layer renders a bounded slice and reports
   * `teacherCandidatesShown` against `teacherCandidateCount` so a reader can tell
   * `Top 15 of 74` from `only 15 exist`.
   */
  teacherCandidates?: TeacherCandidate[];
  /** Total distinct teachers found by aggregation, before any display limit. */
  teacherCandidateCount?: number;
  /** How many of {@link teacherCandidates} were actually shown. */
  teacherCandidatesShown?: number;
  /** True when no single teacher may be chosen on the caller's behalf. */
  ambiguous?: boolean;
  /** Structured statistics for the agent, so no side-channel API work is needed. */
  reviewStats?: ReviewStats;
  /** A handful of raw review rows for provenance, not the whole corpus. */
  evidenceSamples?: CleanReview[];
}

/**
 * Look up review candidates for one course without ranking anything.
 *
 * Useful on its own for "is the data even there?" and for debugging matches
 * before trusting a recommendation.
 *
 * @param course - the course identity to look up.
 * @param deps - providers and matcher.
 * @returns every provider's candidates plus the best match per provider.
 */
export async function lookupReviews(
  course: { courseName: string; teacher?: string; courseCode?: string },
  deps: RecommendDeps,
): Promise<LookupResult> {
  const threshold = deps.matchThreshold ?? REVIEW_MATCH_THRESHOLD;
  const matcher = deps.matcher ?? matchCourse;
  const candidateLimit = deps.policy.candidateLimit;

  const query: CourseSearchQuery = { courseName: course.courseName };
  /*
   * The SAME filter rule {@link planQueries} uses. Sending a co-taught cell whole — `翟显、廖冬梅、…` — would filter the
   * provider's one-teacher-per-row column by a list of people and match nothing, so this path must not build its own
   * teacher value. Keeping the decision in one function is what stops the two lookup entry points from drifting apart,
   * which is exactly how `lookupReviews` kept the defect after `planQueries` was fixed.
   */
  const teacherFilter = queryTeacherFilter(course.teacher);
  if (teacherFilter !== undefined && teacherFilter.trim().length > 0) query.teacher = teacherFilter;
  // The full published set, for local partitioning. Same rule as `planQueries`, from the same helper.
  const localTeacherNames = teacherNamesOfCourse(course.teacher);
  if (localTeacherNames.length > 0) query.localTeacherNames = localTeacherNames;
  if (course.courseCode !== undefined) query.courseCode = course.courseCode;

  const synthetic = syntheticCourse(course);
  const result: LookupResult = { course: { courseName: course.courseName }, providers: [], matches: [] };
  /*
   * One entry per review-source query for THIS course. A provider call that also asks for the course roll-up is two queries, because it is
   * two chances to fail, and a run that quietly dropped one of them would understate how incomplete the evidence is.
   */
  const outcomes: ReviewSourceQueryOutcome[] = [];
  const failureKinds: ReviewSourceFailureKind[] = [];
  if (course.teacher !== undefined) result.course.teacher = course.teacher;
  if (course.courseCode !== undefined) result.course.courseCode = course.courseCode;

  /*
   * "Specified" means the provider was actually scoped to one teacher, not merely that the page published a cell. A
   * co-taught or unusable cell is NOT a teacher-scoped request: it asks for the whole course, so the course-level roll-up
   * has to be fetched rather than assumed, and a name-only ambiguity must be reported rather than attributed to one person.
   */
  const teacherSpecified = teacherFilter !== undefined && teacherFilter.trim().length > 0;

  for (const provider of deps.providers) {
    try {
      // Ask for everything; the cap below is presentation-only, so no count and
      // no teacher must ever depend on it.
      const found = await provider.searchCourse({ ...query, limit: candidateLimit });
      /*
       * Exactly ONE outcome per provider call is recorded here, from this layer's own point of view: the call completed, and it either brought
       * rows back or legitimately brought none. A provider's finer sub-query facts are NOT appended, because a `defaultLookup` over several
       * providers has already recorded one outcome per provider and adding them again would count the same query twice.
       */
      outcomes.push(found.reviews.length > 0 ? 'rows' : 'empty');
      const providerEntry: LookupResult['providers'][number] = {
        id: provider.id,
        status: 'ok',
        fromCache: found.fromCache,
        candidates: found.reviews,
        warnings: found.warnings,
      };
      // The class-scoped roll-up, mirrored onto the lookup result so hand-built matches can carry it too.
      if (found.teachingClassLevel !== undefined) {
        providerEntry.teachingClassLevel = found.teachingClassLevel;
        if (result.teachingClassLevel === undefined) result.teachingClassLevel = found.teachingClassLevel;
      }
      // A provider that only scopes the corpus to the requested teacher still
      // has to answer "how big is the course", so ask it for the roll-up when it
      // did not volunteer one.
      let courseLevel = found.courseLevel;
      if (courseLevel === undefined && teacherSpecified) {
        /*
         * A roll-up request is its own query: it can fail on its own, and when it does the teacher's own evidence must still be used. That
         * is the partial case the health record exists to report.
         */
        try {
          const rollUp = await provider.aggregateForCourse?.(course.courseName);
          if (rollUp === undefined) {
            // The provider has no course-level notion, so no query was made and none may be reported.
            if (provider.aggregateForCourse !== undefined) outcomes.push('empty');
          } else {
            outcomes.push('rows');
            courseLevel = rollUp;
          }
        } catch (error) {
          outcomes.push('unavailable');
          const kind = classifyProviderFailure(error);
          if (!failureKinds.includes(kind)) failureKinds.push(kind);
        }
      }
      if (courseLevel !== undefined) {
        providerEntry.courseLevel = courseLevel;
        if (result.courseLevel === undefined) result.courseLevel = courseLevel;
      }
      result.providers.push(providerEntry);

      // A name-only lookup of a multi-teacher course must not bind one teacher's
      // bucket: that would report one person's data as the course's. Bind the
      // course-level roll-up instead and surface the teachers to choose from.
      const classCandidates = currentClassTeacherCandidates(courseLevel?.teacherCandidates ?? [], localTeacherNames);
      const multipleTeachers = classCandidates.length > 1;
      if (!teacherSpecified && courseLevel !== undefined && multipleTeachers) {
        const rollUp = courseLevelAsReview(courseLevel);
        result.matches.push({
          course: synthetic,
          courseLevel,
          provider: provider.id,
          method: 'exact_name',
          confidence: 0.78,
          trusted: true,
          review: rollUp,
          note: `该课程下有 ${classCandidates.length} 位教师，未指定教师时返回课程级汇总`
            + `（课程总评价 ${courseLevel.courseReviewCount} 条），不代表任何单一位教师；请提供 teacher 以查看具体教师数据`,
          alternatives: found.reviews.slice(0, 3),
        });
        result.teacherCandidates = classCandidates;
        result.teacherCandidateCount = classCandidates.length;
        result.ambiguous = true;
        result.reviewStats = statsFromCourseLevel(courseLevel);
        continue;
      }

      const match = matcher(synthetic, found.reviews);
      const entry: LookupResult['matches'][number] = {
        // `course` and `courseLevel` travel with the entry so the confidence
        // calculator can see *what was asked for* and which aggregate scope
        // answered. Without them it cannot tell a teacher binding from a fallback.
        course: synthetic,
        provider: provider.id,
        method: match.method,
        confidence: match.confidence,
        trusted: match.review !== undefined && match.confidence >= threshold,
      };
      if (match.aliasUsed === true) entry.aliasUsed = true;
      if (courseLevel !== undefined) entry.courseLevel = courseLevel;
      if (match.review !== undefined) entry.review = match.review;
      if (match.alternatives !== undefined) entry.alternatives = match.alternatives;
      if (match.note !== undefined) entry.note = match.note;
      result.matches.push(entry);

      if (entry.review !== undefined) {
        if (courseLevel !== undefined) {
          result.teacherCandidates = currentClassTeacherCandidates(courseLevel.teacherCandidates, localTeacherNames);
          result.teacherCandidateCount = result.teacherCandidates.length;
          result.reviewStats = statsFromCourseLevel(courseLevel, entry.review);
        } else {
          result.reviewStats = statsFromReview(entry.review);
        }
      } else if (courseLevel !== undefined) {
        // No bucket to bind, but the corpus still answers "how much data is
        // there" — report it as a course-level scope with nothing attributed.
        result.teacherCandidates = currentClassTeacherCandidates(courseLevel.teacherCandidates, localTeacherNames);
        result.teacherCandidateCount = result.teacherCandidates.length;
        result.reviewStats = statsFromCourseLevel(courseLevel);
      }
    } catch (error) {
      /*
       * The whole provider call failed. Its successful siblings are untouched: this only records that no answer came from THIS provider, and
       * whatever another provider or an earlier query already contributed stays in `result` and continues into matching.
       */
      outcomes.push('unavailable');
      const kind = classifyProviderFailure(error);
      if (!failureKinds.includes(kind)) failureKinds.push(kind);
      result.providers.push({
        id: provider.id,
        status: 'error',
        fromCache: false,
        candidates: [],
        warnings: [],
        error: (error as Error).message,
      });
    }
  }
  result.reviewSource = rollUpReviewSourceHealth(outcomes, failureKinds);

  // Rows for provenance only. The corpus itself stays in the provider; this is
  // what an agent may quote, never the whole set.
  const sampleLimit = deps.evidenceSampleLimit ?? EVIDENCE_SAMPLE_LIMIT;
  const sampleSource = result.matches
    .map((entry) => entry.review?.sampleRows)
    .find((rows) => rows !== undefined)
    ?? result.courseLevel?.sampleRows;
  if (sampleSource !== undefined) {
    result.evidenceSamples = sampleSource.slice(0, Math.max(0, sampleLimit));
  }
  return result;
}

/** Maximum raw review rows exposed as evidence, regardless of corpus size. */
const EVIDENCE_SAMPLE_LIMIT = 5;

/** Build {@link ReviewStats} from a course-level roll-up and an optional teacher bucket. */
function statsFromCourseLevel(course: CourseLevelReview, teacherReview?: CourseReview): ReviewStats {
  const useTeacher = teacherReview?.aggregateScope === 'teacher';
  const grades = useTeacher
    ? {
        validSampleCount: teacherReview.gradedSampleCount,
        ambiguousSampleCount: teacherReview.ambiguousGradeSampleCount ?? 0,
        invalidSampleCount: teacherReview.invalidGradeSampleCount ?? 0,
        belowPassSampleCount: teacherReview.belowPassSampleCount ?? 0,
        distribution: teacherReview.gradeDistribution ?? {},
        ...(teacherReview.meanGrade === undefined ? {} : { average: teacherReview.meanGrade }),
        ...(teacherReview.medianGrade === undefined ? {} : { median: teacherReview.medianGrade }),
      }
    : course.grades;
  const stats: ReviewStats = {
    courseReviewCount: course.courseReviewCount,
    matchedTeacherReviewCount: useTeacher ? teacherReview.reviewCount : 0,
    malformedTeacherReviewCount: course.malformedTeacherReviewCount,
    missingTeacherReviewCount: course.missingTeacherReviewCount,
    multipleTeacherReviewCount: course.multipleTeacherReviewCount,
    validGradeSampleCount: grades.validSampleCount,
    ambiguousGradeSampleCount: grades.ambiguousSampleCount,
    invalidGradeSampleCount: grades.invalidSampleCount,
    belowPassSampleCount: grades.belowPassSampleCount,
    gradeDistribution: grades.distribution,
    gradeScale: 'percentage',
    aggregateScope: useTeacher ? 'teacher' : 'course',
  };
  if (grades.average !== undefined) stats.reportedGradeAverage = grades.average;
  if (grades.median !== undefined) stats.reportedGradeMedian = grades.median;
  return stats;
}

/** Build {@link ReviewStats} from a single aggregate record, when no roll-up exists. */
function statsFromReview(review: CourseReview): ReviewStats {
  const stats: ReviewStats = {
    courseReviewCount: review.courseReviewCount ?? review.reviewCount,
    matchedTeacherReviewCount: review.aggregateScope === 'course' ? 0 : review.reviewCount,
    malformedTeacherReviewCount: 0,
    missingTeacherReviewCount: 0,
    multipleTeacherReviewCount: 0,
    validGradeSampleCount: review.gradedSampleCount,
    ambiguousGradeSampleCount: review.ambiguousGradeSampleCount ?? 0,
    invalidGradeSampleCount: review.invalidGradeSampleCount ?? 0,
    belowPassSampleCount: review.belowPassSampleCount ?? 0,
    gradeDistribution: review.gradeDistribution ?? {},
    gradeScale: review.gradeScale ?? 'percentage',
    aggregateScope: review.aggregateScope ?? 'teacher',
  };
  if (review.meanGrade !== undefined) stats.reportedGradeAverage = review.meanGrade;
  if (review.medianGrade !== undefined) stats.reportedGradeMedian = review.medianGrade;
  return stats;
}

/** Build a course object from a bare identity, for matching without a page. */
export function syntheticCourse(course: { courseName: string; teacher?: string; courseCode?: string }): NormalizedCourse {
  const normalized: NormalizedCourse = {
    source: 'lookup',
    courseName: course.courseName,
    normalizedName: normalizeCourseName(course.courseName),
    availability: 'unknown',
  };
  if (course.teacher !== undefined && course.teacher.trim().length > 0) {
    normalized.teacher = course.teacher;
    const key = normalizeTeacherName(course.teacher);
    if (key.length > 0) normalized.normalizedTeacher = key;
  }
  if (course.courseCode !== undefined) normalized.courseCode = course.courseCode;
  return normalized;
}

/**
 * Explain one course's ranking components.
 *
 * @param course - the course identity.
 * @param preferences - the user's preferences, so the explanation matches the
 *   ranking the user actually saw.
 * @param deps - providers and matcher.
 * @returns the match, the score breakdown, the confidence, and the raw evidence.
 */
export async function explainCourse(
  course: { courseName: string; teacher?: string; courseCode?: string },
  preferences: Partial<RankingPreferences> | undefined,
  deps: RecommendDeps,
): Promise<{
  course: NormalizedCourse;
  eligibility: EligibilityDecision;
  lookup: LookupResult;
  preferences: RankingPreferences;
  match?: MatchResult;
  components: ReturnType<typeof scoreOnly>['components'];
  score: number | null;
  appliedWeights: Partial<Record<ReviewMetricKey, number>>;
  redistributed: ReviewMetricKey[];
  confidence?: ReturnType<typeof calculateReviewConfidence>;
  metricScale: Record<string, string>;
}> {
  const normalizedPreferences = normalizePreferences(preferences, deps.policy.defaultPreferences);
  const synthetic = syntheticCourse(course);
  const lookup = await lookupReviews(course, deps);

  const best = lookup.matches
    .filter((entry) => entry.trusted && entry.review !== undefined)
    .sort((left, right) => right.confidence - left.confidence)[0];

  const match: MatchResult | undefined = best?.review === undefined
    ? undefined
    : {
        course: synthetic,
        review: best.review,
        confidence: best.confidence,
        method: best.method,
        // Same scope attachments as the ranking path, from the lookup result this function already holds.
        ...(lookup.teachingClassLevel === undefined ? {} : { teachingClassLevel: lookup.teachingClassLevel }),
        ...(lookup.courseLevel === undefined ? {} : { courseLevel: lookup.courseLevel }),
      };

  const scored = scoreOnly(match, normalizedPreferences);
  const result: Awaited<ReturnType<typeof explainCourse>> = {
    course: synthetic,
    eligibility: evaluateEligibility(synthetic, normalizedPreferences),
    lookup,
    preferences: normalizedPreferences,
    components: scored.components,
    score: scored.score,
    appliedWeights: scored.appliedWeights,
    redistributed: scored.redistributed,
    metricScale: {
      scale: '0-10，数值越高越友好',
      gradeFriendliness: '0-10：越容易拿到高分越高（由评价样本的平均/中位成绩映射）',
      workloadFriendliness: '0-10：作业与考核越轻越高（由评价文本关键词推断）',
      attendanceFriendliness: '0-10：考勤越宽松越高（由评价文本关键词推断）',
      overallScore: '0-10：评价正文情感越正面越高（情感分，不是原始成绩）',
      meanGrade: '0-100：评价样本的平均原始成绩',
    },
  };
  if (match !== undefined) {
    result.match = match;
    result.confidence = calculateReviewConfidence(match);
  }
  return result;
}

/** Score one match without ranking, used by the explainer. */
function scoreOnly(
  match: MatchResult | undefined,
  preferences: RankingPreferences,
): {
  score: number | null;
  components: ScoreComponent[];
  appliedWeights: Partial<Record<ReviewMetricKey, number>>;
  redistributed: ReviewMetricKey[];
} {
  return calculateCourseScore(match?.review, preferences);
}

/** Re-export metric metadata so tools can label components consistently. */
export const METRIC_ORDER: readonly ReviewMetricKey[] = METRIC_KEYS;
export { metricLabel, clampMetric };
