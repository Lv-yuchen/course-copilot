/**
 * whucourses.cn review provider.
 *
 * ## The upstream API (verified, see docs/WHUCOURSES_RESEARCH.md)
 *
 * The site is a Vue 3 SPA whose own code calls an unauthenticated, CORS-open
 * JSON API under `/api`. No CSS scraping is involved and no credentials are
 * used. Two `GET` endpoints matter:
 *
 * - `/api/search?course_name=<name>&instructor=<teacher>` — a flat array of
 *   individual reviews. With no parameters it returns the whole 2.7 MB corpus.
 *   A no-match returns HTTP 200 with a body of literal `null`, not `[]`.
 * - `/api/course_promotion?course_name=<name>` — promoted courses, the only
 *   place a `credit` value exists.
 *
 * ## The schema gap this module bridges
 *
 * The corpus has **no course id, no course code, no rating scale, no review
 * count, and no date**. Each row is one student's review carrying:
 *
 * | API field | meaning |
 * |---|---|
 * | `课程名称` | course name |
 * | `授课老师` | teacher |
 * | `课程属性` | course category |
 * | `期末考核方式` | final-assessment free text |
 * | `考勤与平时作业` | attendance/homework free text |
 * | `课程内容与评价` | review body |
 * | `课程成绩` | grade as a **string**, with `未知` sentinels and outliers |
 *
 * ## Three layers, in order
 *
 * 1. {@link normalizeRow} — a lossless `RawReviewRow` projection: the untouched
 *    row is kept in `raw`, nothing is judged yet.
 * 2. {@link cleanRow} — a {@link CleanReview}: teacher validity, grade
 *    classification, and text cleanup. A malformed `teacher` cell is **never**
 *    dropped; its text is folded into `commentText` as course-level evidence.
 * 3. {@link aggregateRows} / {@link aggregateCourse} — teacher buckets and a
 *    course-level roll-up. Both consume **every** row the API returned: the
 *    provider must not truncate the corpus, because a teacher outside the first
 *    N buckets would otherwise become a guaranteed false miss.
 *
 * `workloadDifficulty`-style upstream metrics do not exist here, but if a future
 * provider receives one it MUST invert it here in the provider, which is the
 * only place allowed to know an upstream scale.
 *
 * ## Limits
 *
 * `latestReviewDate` is always absent because the API publishes no dates;
 * `calculateReviewConfidence` handles that by dropping the recency component.
 * Review data is cached (memory + disk) and every request is rate limited.
 *
 * @module course-selection-copilot/providers/whucourses
 */

/*
 * The provider-owned transport defaults, taken from their canonical home rather than through the application's config re-export.
 * A provider that reached back into `../config.js` for its own fallback would make the application's config module the source of
 * truth for a provider's behaviour, and this module is the one that is going to move into the provider package.
 */
import {
  REVIEW_FETCH_CONCURRENCY,
  REVIEW_FETCH_MIN_INTERVAL_MS,
} from '@course-copilot/provider/defaults';
import { normalizeCourseName, normalizeTeacherName } from '@course-copilot/core/normalize';
import { gradeToFriendliness } from '@course-copilot/core/aspects/grade';
import { teacherSetRelation } from '@course-copilot/core/normalize';
import { queryTeacherFilter } from './whu.js';
import { GRADE_PASS_LINE, WHU_GRADE_CALIBRATION, classifyGrade, gradeDecade, parseTeacher } from './whu.js';
import { analyzeReviewRowsDetailed } from '@course-copilot/core/aspects/extractor';
import { selectReviewExcerpts } from './review-excerpts.js';
import {
  LEGACY_METRIC_TO_ASPECT,
  aspectReliability,
  decisionScore,
  type AspectDecision,
} from '@course-copilot/core/recommendation';
import type { AspectAnalysis, ReviewAspects } from '@course-copilot/core/aspects';
import { combineGradeSignals, withGradeSignal } from '@course-copilot/core/aspects/gradeSignal';
import type { CacheLike } from './cache.js';
import { RequestLimiter } from './limiter.js';
import type {
  CleanReview,
  CourseLevelReview,
  CourseLevelScope,
  CourseReview,
  GradeStatistics,
  MetricEvidence,
  RawReviewRow,
  ReviewMetricKey,
  ReviewSourceFailureKind,
  ReviewSourceHealth,
  ReviewSourceQueryOutcome,
  TeacherCandidate,
} from '@course-copilot/core/course';
import {
  ReviewProviderError,
  type CourseSearchQuery,
  type ReviewProvider,
  type ReviewSearchResult,
} from './types.js';

/** Production host. */
export const WHUCOURSES_ORIGIN = 'https://whucourses.cn';

/** The API's own field names, in one place so a schema change is a one-line diff. */
export const WHUCOURSES_FIELDS = {
  courseName: '课程名称',
  teacher: '授课老师',
  courseAttribute: '课程属性',
  electiveField: '公选课领域',
  assessment: '期末考核方式',
  attendance: '考勤与平时作业',
  content: '课程内容与评价',
  grade: '课程成绩',
  /** The site also emits a legacy empty-string key holding the same grade. */
  legacyGrade: '',
} as const;

/** Collapse whitespace runs so downstream text scoring sees stable input. */
function tidyText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = value.replace(/\s+/gu, ' ').trim();
  return collapsed.length === 0 ? undefined : collapsed;
}

/**
 * Normalize an API row into the provider-neutral raw shape.
 *
 * Lossless by construction: no field is dropped, judged, or rewritten, and the
 * original row travels along in `raw` so every later cleaning decision can be
 * re-audited.
 *
 * @param raw - one element of the API's JSON array.
 * @returns the raw row projection.
 */
export function normalizeRow(raw: Record<string, unknown>): RawReviewRow {
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
    return undefined;
  };
  const row: RawReviewRow = {
    provider: 'whucourses',
    courseName: pick(WHUCOURSES_FIELDS.courseName) ?? '',
    raw,
  };
  const teacher = pick(WHUCOURSES_FIELDS.teacher);
  if (teacher !== undefined) row.teacher = teacher;
  const content = pick(WHUCOURSES_FIELDS.content);
  if (content !== undefined) row.content = content;
  const assessment = pick(WHUCOURSES_FIELDS.assessment);
  if (assessment !== undefined) row.assessment = assessment;
  const attendance = pick(WHUCOURSES_FIELDS.attendance);
  if (attendance !== undefined) row.attendance = attendance;
  const grade = pick(WHUCOURSES_FIELDS.grade) ?? pick(WHUCOURSES_FIELDS.legacyGrade);
  if (grade !== undefined) row.grade = grade;
  const attribute = pick(WHUCOURSES_FIELDS.courseAttribute);
  if (attribute !== undefined) row.courseAttribute = attribute;
  const elective = pick(WHUCOURSES_FIELDS.electiveField);
  if (elective !== undefined) row.electiveField = elective;
  return row;
}

/**
 * Clean one raw row into a {@link CleanReview}.
 *
 * A row is never dropped for a bad field. When the teacher cell holds prose, the
 * row loses its teacher (so it cannot create a bucket or influence teacher
 * matching) but the prose is preserved as `commentText` evidence at course level.
 *
 * @param row - a {@link normalizeRow} output.
 * @returns the cleaned row plus its classification.
 */
export function cleanRow(row: RawReviewRow): CleanReview {
  const parsedTeacher = parseTeacher(row.teacher);
  const grade = classifyGrade(row.grade);
  const comment = tidyText(row.content);
  const malformedTeacherText = parsedTeacher.validity === 'malformed' ? tidyText(row.teacher) : undefined;

  const clean: CleanReview = {
    courseName: row.courseName,
    teacherValidity: parsedTeacher.validity,
    gradeScale: grade.scale,
    gradeValidity: grade.validity,
    raw: row,
  };
  if (parsedTeacher.validity === 'valid' && parsedTeacher.teacher !== undefined) {
    clean.teacher = parsedTeacher.teacher;
  }
  if (parsedTeacher.names.length > 0) clean.teacherNames = [...parsedTeacher.names];
  const teacherRaw = tidyText(row.teacher);
  if (teacherRaw !== undefined) clean.teacherRaw = teacherRaw;
  if (grade.value !== undefined) clean.reportedGrade = grade.value;
  if (row.grade !== undefined) clean.rawGrade = row.grade;
  const assessment = tidyText(row.assessment);
  if (assessment !== undefined) clean.examMethodText = assessment;
  const attendance = tidyText(row.attendance);
  if (attendance !== undefined) clean.attendanceWorkloadText = attendance;
  // A malformed teacher cell is student text, so it belongs with the comment.
  const merged = [comment, malformedTeacherText].filter((part): part is string => part !== undefined);
  if (merged.length > 0) clean.commentText = merged.join(' ');
  if (malformedTeacherText !== undefined) clean.malformedTeacherText = malformedTeacherText;
  return clean;
}

/** Mean of a number list. */
function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Median of a number list (lower-middle for even counts, deterministic). */
function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * `termNames` lived here to format the retired text scorer's matched terms, which were shaped as
 * `MatchedTerm` (`{ term, negated }`). The metric evidence now takes `matchedTerms` straight from the
 * aspect decisions, so the helper has no callers and went with the scorer.
 */

/** Average a list of `0..10` scores, ignoring `undefined`. */
function average(scores: readonly (number | undefined)[]): number | undefined {
  const usable = scores.filter((value): value is number => value !== undefined);
  if (usable.length === 0) return undefined;
  return usable.reduce((total, value) => total + value, 0) / usable.length;
}

/**
 * Reduce a caught failure to the coarse kind a caller may publish.
 *
 * The provider's own error `code` is the input, because this is the only layer that knows the difference between a timeout, a 500, an
 * unparseable body and an unexpected shape. Only three kinds leave here: a result object is not the place to carry a stack, a URL or a
 * response body, so the detail stays in `warnings` for a human and the kind is what a machine branches on.
 *
 * @param error - whatever the fetch layer threw.
 * @returns `network`, `http` or `malformed`.
 */
function classifyFetchFailure(error: unknown): ReviewSourceFailureKind {
  const code = error instanceof ReviewProviderError
    ? error.code
    : typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  if (code === 'network-error' || code === 'timeout' || code === 'aborted') return 'network';
  if (code === 'http-error' || code.startsWith('http-') || code === 'rate-limited') return 'http';
  return 'malformed';
}

/** Roll a set of request outcomes up into one health record, with `status` derived from the counts. */
function healthFromOutcomes(
  outcomes: readonly ReviewSourceQueryOutcome[],
  failureKinds: readonly ReviewSourceFailureKind[],
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
    ...(failureKinds.length === 0 ? {} : { failureKinds: [...new Set(failureKinds)] }),
  };
}

/**
 * Count the reviews that back grade friendliness, from **either** source.
 *
 * ## Why this is a union and not a sum
 *
 * A single review can carry both facts: a student may write `给分很高` *and* publish `课程成绩 = 95`. So the text count and the usable-grade
 * count overlap, and adding them double-counts every such review. Measured on a three-row fixture with one text-only, one grade-only and
 * one review carrying both: the true union is 3 while the sum is 4. The union is also not recoverable from the two counts afterwards,
 * which is why it has to be computed here, while the rows and their per-review extractions are still paired up.
 *
 * ## Why it is computed this way
 *
 * `analyzeReviewRowsDetailed` already returns one {@link ReviewAspects} per row, in the same order as the input rows, so the two facts for
 * a review are read off the same index. The text side uses those canonical mentions rather than re-scanning the prose: a second
 * classifier here would be a second source of truth for what counts as evidence, and the `formatOnly` mentions are excluded exactly as
 * `scoreAspect` excludes them, so this count agrees with the published `evidenceReviewCount` on the text side.
 *
 * @param rows - cleaned rows, in the order the extractions were produced for.
 * @param reviews - per-row extractions from {@link analyzeReviewRowsDetailed}, index-aligned with `rows`.
 * @returns the number of reviews carrying text evidence or a usable percentage grade.
 */
function countGradeFriendlinessEvidence(
  rows: readonly CleanReview[],
  reviews: readonly ReviewAspects[],
): number {
  let total = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    const hasGrade = row.gradeValidity === 'usable' && row.reportedGrade !== undefined;
    const mentions = reviews[index]?.mentions ?? [];
    const hasText = mentions.some((mention) => mention.aspect === 'gradeFriendliness' && mention.formatOnly !== true);
    if (hasText || hasGrade) total += 1;
  }
  return total;
}

/**
 * Collect grade statistics over cleaned rows.
 *
 * Percentage statistics cover `usable` cells **only** — and a usable cell may
 * well be below 60, because a real 55 is evidence about grading difficulty, not
 * an error. Ambiguous cells (GPA-like decimals, implausibly low integers) are
 * counted and kept but never mixed into percentages, and invalid sentinels are
 * counted separately. Nothing is dropped from the underlying rows.
 *
 * @param rows - cleaned rows.
 * @returns counts, percentage statistics, and the histogram.
 */
export function gradeStatistics(rows: readonly CleanReview[]): GradeStatistics {
  const percentage: number[] = [];
  let ambiguousSampleCount = 0;
  let invalidSampleCount = 0;
  let belowPassSampleCount = 0;
  const distribution: Record<string, number> = {};
  for (const row of rows) {
    if (row.gradeValidity === 'usable' && row.reportedGrade !== undefined) {
      percentage.push(row.reportedGrade);
      if (row.reportedGrade < GRADE_PASS_LINE) belowPassSampleCount += 1;
      const decade = gradeDecade(row.reportedGrade);
      distribution[decade] = (distribution[decade] ?? 0) + 1;
    } else if (row.gradeValidity === 'ambiguous') {
      ambiguousSampleCount += 1;
    } else {
      invalidSampleCount += 1;
    }
  }
  const stats: GradeStatistics = {
    validSampleCount: percentage.length,
    ambiguousSampleCount,
    invalidSampleCount,
    percentageDistribution: distribution,
    belowPassSampleCount,
    distribution,
  };
  const average = mean(percentage);
  const middle = median(percentage);
  if (average !== undefined) {
    stats.percentageAverage = Number(average.toFixed(4));
    stats.average = stats.percentageAverage;
  }
  if (middle !== undefined) {
    stats.percentageMedian = Number(middle.toFixed(4));
    stats.median = stats.percentageMedian;
  }
  return stats;
}

/** The four canonical metrics derived from a set of cleaned rows. */
interface MetricBundle {
  gradeFriendliness?: number;
  workloadFriendliness?: number;
  attendanceFriendliness?: number;
  overallScore?: number;
  meanGrade?: number;
  medianGrade?: number;
  evidence: Partial<Record<ReviewMetricKey, MetricEvidence>>;
}

/**
 * Derive the four canonical metrics from cleaned rows.
 *
 * ## The legacy text scorer is retired (Step 25b)
 *
 * These four values used to be computed by `textSignals`' `scoreWorkloadText` /
 * `scoreAttendanceText` / `scoreOverallText`, a Phase-1 keyword scorer that ran a **second**
 * phrase table beside Core's `ASPECT_LEXICON` — with which it shared 61% of its vocabulary.
 *
 * That engine is gone from this path. The values now come from the **same aspect decisions** the
 * ranking layer uses, which removes the duplicate vocabulary *and* makes the legacy scalar fallback in
 * `calculateCourseScore` agree with the decision path instead of quietly disagreeing with it.
 *
 * `gradeFriendliness` was never text-derived; it stays on the grade distribution.
 *
 * @param grades - grade statistics for the same rows.
 * @param analysis - the aspect decisions for the same rows.
 * @returns the metric values and their per-dimension evidence.
 */
function deriveMetrics(grades: GradeStatistics, analysis: AspectAnalysis): MetricBundle {
  const evidence: Partial<Record<ReviewMetricKey, MetricEvidence>> = {};
  const bundle: MetricBundle = { evidence };
  /**
   * The decision for one metric, computed with Core's own `aspectReliability` and `decisionScore` —
   * the same two functions `buildAspectBreakdown` uses — so these compatibility scalars are the
   * ranking numbers rather than a second derivation of them.
   */
  const decisionFor = (metric: ReviewMetricKey): AspectDecision | undefined => {
    const aspect = LEGACY_METRIC_TO_ASPECT[metric];
    if (aspect === undefined) return undefined;
    const score = analysis.scores.find((entry) => entry.aspect === aspect);
    const raw = score?.score;
    if (score === undefined || raw === undefined) return undefined;
    return {
      aspect,
      raw,
      reliability: aspectReliability(score),
      decision: decisionScore(raw, aspectReliability(score)),
      weight: 0,
      evidenceReviewCount: score.evidenceReviewCount,
      mentionCount: score.mentionCount,
      matchedTerms: score.matchedTerms,
    };
  };

  // Grade friendliness is an *outcome* reading of the published distribution, not a text signal.
  const validGrades = grades.validSampleCount;
  const gradeScore = average([
    grades.percentageAverage === undefined
      ? undefined
      : gradeToFriendliness(grades.percentageAverage, WHU_GRADE_CALIBRATION),
    grades.percentageMedian === undefined
      ? undefined
      : gradeToFriendliness(grades.percentageMedian, WHU_GRADE_CALIBRATION),
  ]);
  if (gradeScore !== undefined) {
    bundle.gradeFriendliness = Number(gradeScore.toFixed(4));
    evidence.gradeFriendliness = {
      sampleCount: validGrades,
      note: `百分制平均 ${grades.percentageAverage?.toFixed(1) ?? 'n/a'}、中位 ${grades.percentageMedian?.toFixed(1) ?? 'n/a'}`
        + `（${validGrades} 条可用百分制样本，其中低于及格线 ${grades.belowPassSampleCount} 条，均计入；`
        + `另有 ${grades.ambiguousSampleCount} 条量表不明、${grades.invalidSampleCount} 条无效，未计入百分制统计），`
        + '按分段线性映射到 0-10',
    };
  }

  // The three text-derived metrics, sourced from the aspect decisions. `decision` is the centre
  // estimate shrunk toward neutral by evidence reliability — the same number ranking uses.
  const TEXT_METRICS: readonly ReviewMetricKey[] = [
    'workloadFriendliness', 'attendanceFriendliness', 'overallScore',
  ];
  for (const metric of TEXT_METRICS) {
    const entry = decisionFor(metric);
    if (entry?.decision === undefined) continue;
    const key = metric as 'workloadFriendliness' | 'attendanceFriendliness' | 'overallScore';
    bundle[key] = entry.decision;
    evidence[metric] = {
      sampleCount: entry.evidenceReviewCount,
      note: `由评价文本推断（${entry.mentionCount} 处提及，证据可靠性 ${entry.reliability.toFixed(2)}），`
        + '与排序使用同一份 aspect 决策；这是文本分，不是原始成绩',
      ...(entry.matchedTerms.length === 0 ? {} : { matchedTerms: entry.matchedTerms.slice(0, 8) }),
    };
  }

  if (grades.percentageAverage !== undefined) bundle.meanGrade = grades.percentageAverage;
  if (grades.percentageMedian !== undefined) bundle.medianGrade = grades.percentageMedian;
  return bundle;
}

/** Aggregate accumulator for one `(courseName, teacher)` bucket. */
interface Bucket {
  courseName: string;
  teacher?: string;
  rows: CleanReview[];
}

/** Build the teacher bucket key for one cleaned row. */
function bucketKey(courseName: string, teacher: string | undefined): string {
  return `${courseName}\u0000${teacher === undefined ? '' : normalizeTeacherName(teacher)}`;
}

/**
 * Build one teacher-level {@link CourseReview} from its rows.
 *
 * @param courseName - the course this bucket belongs to.
 * @param teacher - the bucket's teacher, absent for the malformed/missing bucket.
 * @param rows - cleaned rows of this bucket.
 * @param courseReviewCount - total rows the provider returned for the course.
 * @returns the aggregate record.
 */
function buildTeacherReview(
  courseName: string,
  teacher: string | undefined,
  rows: readonly CleanReview[],
  courseReviewCount: number,
): CourseReview {
  const grades = gradeStatistics(rows);
  // The aspect decisions come first now: the metric scalars are derived from them, so that the legacy
  // compatibility values and the ranking path share one source instead of two scorers.
  // `reviews` is kept, not just `mentions`: the per-row extractions are what make the grade-evidence union computable without a second
  // text classifier, and a flattened mention list cannot say which review it came from.
  const { analysis, mentions, reviews } = analyzeReviewRowsDetailed(rows);
  const metrics = deriveMetrics(grades, analysis);
  const review: CourseReview = {
    provider: 'whucourses',
    courseName,
    normalizedName: normalizeCourseName(courseName),
    reviewCount: rows.length,
    courseReviewCount,
    matchedTeacherReviewCount: teacher === undefined ? 0 : rows.length,
    gradedSampleCount: grades.validSampleCount,
    ambiguousGradeSampleCount: grades.ambiguousSampleCount,
    invalidGradeSampleCount: grades.invalidSampleCount,
    belowPassSampleCount: grades.belowPassSampleCount,
    gradeDistribution: grades.percentageDistribution,
    gradeScale: 'percentage',
    aggregateScope: 'teacher',
    sourceUrl: `${WHUCOURSES_ORIGIN}/search?course_name=${encodeURIComponent(courseName)}`,
  };
  if (teacher !== undefined) {
    review.teacher = teacher;
    const teacherKey = normalizeTeacherName(teacher);
    if (teacherKey.length > 0) review.normalizedTeacher = teacherKey;
  }
  const jointTeaching = rows.some((row) => row.teacherValidity === 'valid_multiple');
  if (jointTeaching) {
    const allNames = new Set<string>();
    for (const row of rows) for (const name of row.teacherNames ?? []) allNames.add(name);
    review.teacherNames = [...allNames].sort();
    review.jointTeaching = true;
  }
  if (metrics.meanGrade !== undefined) review.meanGrade = metrics.meanGrade;
  if (metrics.medianGrade !== undefined) review.medianGrade = metrics.medianGrade;
  // Teacher-field hygiene, so confidence can see how much of the column was prose.
  review.malformedTeacherReviewCount = rows.filter((row) => row.teacherValidity === 'malformed').length;
  review.missingTeacherReviewCount = rows.filter((row) => row.teacherValidity === 'missing').length;
  review.multipleTeacherReviewCount = rows.filter((row) => row.teacherValidity === 'valid_multiple').length;
  if (metrics.gradeFriendliness !== undefined) review.gradeFriendliness = metrics.gradeFriendliness;
  if (metrics.workloadFriendliness !== undefined) review.workloadFriendliness = metrics.workloadFriendliness;
  if (metrics.attendanceFriendliness !== undefined) review.attendanceFriendliness = metrics.attendanceFriendliness;
  if (metrics.overallScore !== undefined) review.overallScore = metrics.overallScore;
  if (Object.keys(metrics.evidence).length > 0) review.evidence = metrics.evidence;
  // Phase 2: the aspect breakdown of the same rows, with the grade dimension
  // combining the published distribution and the text evidence. The breakdown was computed above,
  // before the metrics, because the metrics are now derived from it.
  const gradeReviews = analysis.scores.find((entry) => entry.aspect === 'gradeFriendliness')?.evidenceReviewCount;
  const gradeSignal = combineGradeSignals(grades, mentions, {
    /*
     * The TEXT count, which is what this signal describes, and the UNION, which is how much evidence the dimension really has. They
     * differ whenever a review published a grade without saying anything about marking, or vice versa.
     */
    text: gradeReviews ?? 0,
    union: countGradeFriendlinessEvidence(rows, reviews),
  }, WHU_GRADE_CALIBRATION);
  review.aspects = { ...analysis, scores: withGradeSignal(analysis.scores, gradeSignal) };
  // Storage keeps every row; this is only the auditable slice.
  review.sampleRows = rows.slice(0, EVIDENCE_ROWS_IN_AGGREGATE);
  return review;
}
/** How many cleaned rows an aggregate object carries for auditability. */
const EVIDENCE_ROWS_IN_AGGREGATE = 5;

/**
 * Aggregate raw rows into one {@link CourseReview} per teacher.
 *
 * Consumes **every** row: no candidate cap is applied here. A presentation limit
 * belongs in the tool layer, where dropping a row cannot change a count.
 *
 * Rows whose teacher cell is prose land in a single teacher-less bucket per
 * course, so their text still counts at course level without creating a bogus
 * teacher.
 *
 * @param rows - normalized API rows.
 * @param options - optional presentation cap; omit to keep everything.
 * @returns review records, best (most-reviewed) first.
 */
export function aggregateRows(
  rows: readonly RawReviewRow[],
  options: { limit?: number; courseReviewCount?: number; teacherScoped?: boolean } = {},
): CourseReview[] {
  return aggregateCleanRows(rows.map(cleanRow), options);
}

/**
 * Build the teacher buckets from ALREADY-CLEANED rows.
 *
 * Identical output to {@link aggregateRows}; it exists so a caller that has already cleaned the corpus once — because it also
 * needs the whole-course, teaching-class and supplementary roll-ups from the same rows — does not clean it a second time and
 * cannot end up with two parallel versions of the same truth.
 *
 * ## The fan-out is deliberate
 *
 * A co-taught row is pushed into every named teacher's bucket, because it really is evidence about each of them. That makes
 * the buckets OVERLAP: their `reviewCount` values must never be added together, and this is exactly why the teaching-class
 * total is computed from the rows before the fan-out rather than by combining buckets.
 *
 * @param cleaned - cleaned rows.
 * @param options - optional presentation cap; omit to keep everything.
 * @returns review records, best (most-reviewed) first.
 */
export function aggregateCleanRows(
  cleaned: readonly CleanReview[],
  options: { limit?: number; courseReviewCount?: number; teacherScoped?: boolean } = {},
): CourseReview[] {
  const courseTotals = new Map<string, number>();
  for (const row of cleaned) {
    if (row.courseName.length === 0) continue;
    courseTotals.set(row.courseName, (courseTotals.get(row.courseName) ?? 0) + 1);
  }

  const buckets = new Map<string, Bucket>();
  for (const row of cleaned) {
    if (row.courseName.length === 0) continue;
    // Malformed teachers must not become buckets; they share the course's
    // teacher-less bucket instead. A co-taught row contributes to *every* named
    // teacher's bucket, because it really is evidence about each of them.
    const teachers = row.teacherValidity === 'valid' || row.teacherValidity === 'valid_multiple'
      ? row.teacherNames ?? []
      : [];
    if (teachers.length === 0) {
      const key = bucketKey(row.courseName, undefined);
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = { courseName: row.courseName, rows: [] };
        buckets.set(key, bucket);
      }
      bucket.rows.push(row);
      continue;
    }
    for (const teacher of teachers) {
      const key = bucketKey(row.courseName, teacher);
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = { courseName: row.courseName, teacher, rows: [] };
        buckets.set(key, bucket);
      }
      bucket.rows.push(row);
    }
  }

  const reviews: CourseReview[] = [];
  for (const bucket of buckets.values()) {
    // `courseReviewCount` is a course-wide fact. `teacherScoped` says the input
    // was pre-filtered to one teacher (or deliberately to the whole course), so
    // the caller's total is authoritative; otherwise count what is here, which
    // is the whole course for an unfiltered fetch.
    const courseTotal = options.teacherScoped === true && options.courseReviewCount !== undefined
      ? options.courseReviewCount
      : courseTotals.get(bucket.courseName) ?? bucket.rows.length;
    reviews.push(buildTeacherReview(
      bucket.courseName,
      bucket.teacher,
      bucket.rows,
      courseTotal,
    ));
  }

  reviews.sort((left, right) => {
    if (left.reviewCount !== right.reviewCount) return right.reviewCount - left.reviewCount;
    const leftTeacher = left.teacher ?? '';
    const rightTeacher = right.teacher ?? '';
    if (leftTeacher !== rightTeacher) return leftTeacher < rightTeacher ? -1 : 1;
    return left.courseName < right.courseName ? -1 : left.courseName > right.courseName ? 1 : 0;
  });

  if (options.limit === undefined) return reviews;
  return reviews.slice(0, Math.max(0, options.limit));
}

/**
 * Build a {@link CourseLevelReview} from ALREADY-CLEANED rows.
 *
 * ## Why this exists separately from {@link aggregateCourse}
 *
 * Three different aggregates have to be produced from the same corpus — the whole course, the current teaching class, and
 * the course-level supplementary evidence — and each must be computed by running the real statistics over its own row set.
 * They may NOT be derived by combining each other's numbers: `meanGrade`, `medianGrade` and the aspect scores are not
 * mergeable from finished values (a median needs the ordered samples, and the text-derived scores are non-linear), so the
 * only correct construction is "select the rows, then compute the numbers".
 *
 * This function is that second half. It computes everything from the rows it is given, so a caller that has already cleaned
 * a corpus once can produce all three aggregates without cleaning it again or keeping two parallel truths.
 *
 * @param cleaned - cleaned rows to summarise; rows of other courses are ignored.
 * @param courseName - the published course name to summarise.
 * @param scope - which corpus this roll-up describes.
 * @returns the roll-up, or `undefined` when no row belongs to the course.
 */
function summarizeCleanRows(
  cleaned: readonly CleanReview[],
  courseName: string,
  scope: CourseLevelScope,
): CourseLevelReview | undefined {
  const rows = cleaned.filter((row) => row.courseName === courseName);
  if (rows.length === 0) return undefined;

  const grades = gradeStatistics(rows);
  // Same ordering as the teacher path: aspects first, then metrics derived from them.
  // `reviews` is kept here too, so both paths compute the grade-evidence union the same way.
  const { analysis, mentions, reviews } = analyzeReviewRowsDetailed(rows);
  const metrics = deriveMetrics(grades, analysis);
  const byTeacher = new Map<string, { teacher: string; count: number; grades: number }>();
  let malformedTeacherReviewCount = 0;
  let missingTeacherReviewCount = 0;
  let multipleTeacherReviewCount = 0;
  for (const row of rows) {
    if (row.teacherValidity === 'valid' || row.teacherValidity === 'valid_multiple') {
      if (row.teacherValidity === 'valid_multiple') multipleTeacherReviewCount += 1;
      for (const name of row.teacherNames ?? []) {
        const key = normalizeTeacherName(name);
        const entry = byTeacher.get(key) ?? { teacher: name, count: 0, grades: 0 };
        entry.count += 1;
        if (row.gradeValidity === 'usable') entry.grades += 1;
        byTeacher.set(key, entry);
      }
    } else if (row.teacherValidity === 'malformed') {
      malformedTeacherReviewCount += 1;
    } else {
      missingTeacherReviewCount += 1;
    }
  }

  const teacherCandidates: TeacherCandidate[] = [...byTeacher.entries()]
    .map(([normalizedTeacher, entry]) => ({
      teacher: entry.teacher,
      normalizedTeacher,
      reviewCount: entry.count,
      validGradeSampleCount: entry.grades,
    }))
    .sort((left, right) => {
      if (left.reviewCount !== right.reviewCount) return right.reviewCount - left.reviewCount;
      return left.teacher < right.teacher ? -1 : left.teacher > right.teacher ? 1 : 0;
    });

  const review: CourseLevelReview = {
    provider: 'whucourses',
    courseName,
    normalizedName: normalizeCourseName(courseName),
    scope,
    courseReviewCount: rows.length,
    validTeacherReviewCount: teacherCandidates.reduce((total, entry) => total + entry.reviewCount, 0),
    malformedTeacherReviewCount,
    missingTeacherReviewCount,
    multipleTeacherReviewCount,
    teacherCandidates,
    grades,
    sampleRows: rows.slice(0, EVIDENCE_ROWS_IN_AGGREGATE),
    sourceUrl: `${WHUCOURSES_ORIGIN}/search?course_name=${encodeURIComponent(courseName)}`,
  };
  if (metrics.gradeFriendliness !== undefined) review.gradeFriendliness = metrics.gradeFriendliness;
  if (metrics.workloadFriendliness !== undefined) review.workloadFriendliness = metrics.workloadFriendliness;
  if (metrics.attendanceFriendliness !== undefined) review.attendanceFriendliness = metrics.attendanceFriendliness;
  if (metrics.overallScore !== undefined) review.overallScore = metrics.overallScore;
  if (metrics.meanGrade !== undefined) review.meanGrade = metrics.meanGrade;
  if (metrics.medianGrade !== undefined) review.medianGrade = metrics.medianGrade;
  const gradeReviews = analysis.scores.find((entry) => entry.aspect === 'gradeFriendliness')?.evidenceReviewCount;
  review.aspects = {
    ...analysis,
    // Same two counts as the teacher path, through the same helper.
    scores: withGradeSignal(analysis.scores, combineGradeSignals(grades, mentions, {
      text: gradeReviews ?? 0,
      union: countGradeFriendlinessEvidence(rows, reviews),
    }, WHU_GRADE_CALIBRATION)),
  };
  return review;
}

/** Where the rows of a row-set partition belong. */
interface CleanRowPartition {
  /** Rows naming at least one teacher of the current teaching class; the class's own evidence. */
  matched: CleanReview[];
  /** Rows naming only teachers outside the class; someone else's course, not this class's. */
  disjoint: CleanReview[];
  /** Rows with no usable teacher at all; course-level evidence that names nobody. */
  unassigned: CleanReview[];
}

/**
 * Split cleaned rows by their relationship to the CURRENT teaching class's teachers.
 *
 * ## Why the split happens before the teacher fan-out
 *
 * {@link aggregateRows} pushes one co-taught row into every named teacher's bucket, which is right for per-teacher detail but
 * means bucket counts overlap and cannot be added up. Splitting the rows first — while each API row is still a single entry —
 * is what makes the class's own total countable exactly once, with no fingerprint and no de-duplication pass: the unique
 * total is simply the size of `matched`.
 *
 * ## The three sets are mutually exclusive and exhaustive
 *
 * A row either names a usable teacher or it does not.
 *
 * - It does not → `unassigned`. This is decided by the row ALONE, never by the local teacher set: a missing or malformed cell
 *   is unattributable whenever it appears, and letting the local set influence it would dump every valid-teacher row into the
 *   supplementary evidence whenever the page named no teacher — including rows belonging to teachers of other classes.
 * - It does → the class's teacher set either overlaps it or does not. Overlap is `matched` (the class's own evidence);
 *   no overlap is `disjoint`, which covers BOTH a different teacher and the case where this class's teachers are unknown.
 *   `disjoint` is therefore "may or may not be this class's", not "is someone else's", and callers must not read it as
 *   attributed to another person.
 *
 * @param cleaned - cleaned rows.
 * @param courseName - the published course name to keep.
 * @param localTeacherNames - the current teaching class's teachers, normalized; empty when the page named none.
 * @returns the three disjoint row sets.
 */
function partitionCleanRows(
  cleaned: readonly CleanReview[],
  courseName: string,
  localTeacherNames: readonly string[],
): CleanRowPartition {
  const partition: CleanRowPartition = { matched: [], disjoint: [], unassigned: [] };
  for (const row of cleaned) {
    if (row.courseName !== courseName) continue;
    if (row.teacherValidity !== 'valid' && row.teacherValidity !== 'valid_multiple') {
      partition.unassigned.push(row);
      continue;
    }
    if (localTeacherNames.length === 0) {
      partition.disjoint.push(row);
      continue;
    }
    const relation = teacherSetRelation(localTeacherNames, row.teacherNames);
    if (relation === 'agree') partition.matched.push(row);
    else partition.disjoint.push(row);
  }
  return partition;
}

/**
 * Roll **all** rows of one course up into a {@link CourseLevelReview}.
 *
 * This is what a name-only lookup must answer with. `courseReviewCount` is the
 * total corpus size, `teacherCandidates` lists the teachers with their own
 * counts, and no single teacher is chosen on the caller's behalf.
 *
 * The scope is `'course'`: this describes the whole course, so it includes teachers
 * outside the current teaching class. It is background, not the class's own total.
 *
 * @param rows - normalized API rows for one course name (extras are ignored by name).
 * @param courseName - the published course name to roll up.
 * @returns the course-level record, or `undefined` when no row matches.
 */
export function aggregateCourse(
  rows: readonly RawReviewRow[],
  courseName: string,
): CourseLevelReview | undefined {
  return summarizeCleanRows(rows.map(cleanRow), courseName, 'course');
}

/**
 * Project a course-level roll-up into the {@link CourseReview} shape.
 *
 * Re-exported from the provider contract, where it lives, so existing callers and
 * tests that import it from this module keep working. It is not WHUCourses-specific:
 * see {@link import('./types.js').courseLevelAsReview}.
 */
export { courseLevelAsReview } from './types.js';

/** Options for {@link WhuCoursesProvider}. */
export interface WhuCoursesProviderOptions {
  /** Override the origin (tests point this at a local server). */
  origin?: string;
  /** `fetch` implementation; defaults to the global one. */
  fetchImpl?: typeof fetch;
  /**
   * The review cache. REQUIRED, and deliberately not defaulted.
   *
   * ## Why there is no default
   *
   * This module must stay bundleable for a browser, and the only Node coupling it had was constructing a disk-backed
   * {@link TtlCache} when no cache was supplied. That fallback made an environment choice inside a module that is supposed to be
   * environment-agnostic, and it dragged `node:fs/promises`, `node:path` and `Buffer` into the module graph even when caching
   * was switched off — because "disabled" still meant "a TtlCache was constructed".
   *
   * So the cache is now an explicit dependency. A Node caller that wants the persistent default uses
   * `createNodeWhucoursesProvider`; anything else supplies its own implementation. There is intentionally no
   * `CacheLike | undefined` state: the provider always has a cache, and the only question is who chose it.
   */
  cache: CacheLike<RawReviewRow[]>;
  /** Concurrency override. */
  concurrency?: number;
  /** Rate-limit interval override. */
  minIntervalMs?: number;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
}

/** Default per-request timeout. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The whucourses.cn provider.
 */
export class WhuCoursesProvider implements ReviewProvider {
  readonly id = 'whucourses';
  readonly label = 'WHU 课程评价 (whucourses.cn)';
  readonly homepage = WHUCOURSES_ORIGIN;

  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: CacheLike<RawReviewRow[]>;
  private readonly limiter: RequestLimiter;
  private readonly timeoutMs: number;

  /**
   * Requests currently in flight, keyed by their final request URL.
   *
   * ## What it is for
   *
   * Two callers can ask for the same course at the same moment — a batch of visible rows groups per teaching class, so a course
   * taught by two different single teachers produces two lookups, and both may reach the wire before either has written to the
   * cache. A cache only removes repeats that happen AFTER it is populated; it cannot see a request its twin is already making.
   * This map lets the second caller await the first caller's request instead of issuing a duplicate.
   *
   * ## Scope
   *
   * INSTANCE-local, deliberately. It is not static, not module-global, and not shared through `globalThis`: two providers are two
   * callers with their own caches and limits, and coalescing across them would couple their lifetimes for no benefit.
   *
   * ## Why only signal-less requests use it
   *
   * A caller that supplies an `AbortSignal` is asking to be able to cancel. Sharing that caller's request with another would make
   * one caller's cancellation affect the other, and WHICH one that is would depend on arrival order — behaviour no caller could
   * predict. So a signaled request bypasses this map entirely and keeps the independent lifetime it has today; see
   * {@link fetchRows}. The consequence is that a signaled and a signal-less request for the same URL may both go out, which is
   * the honest price of keeping cancellation meaningful.
   *
   * ## Lifetime
   *
   * An entry exists only while its request is running and is removed on success AND on failure, so a failure can never be
   * remembered: the next caller retries for real.
   */
  private readonly pending = new Map<string, Promise<RawReviewRow[] | null>>();

  /*
   * No default parameter value: `cache` is a required dependency, so an omissions must be a compile error rather than a
   * silently constructed default. That is the point of removing the fallback.
   */
  constructor(options: WhuCoursesProviderOptions) {
    this.origin = (options.origin ?? WHUCOURSES_ORIGIN).replace(/\/+$/u, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cache = options.cache;
    this.limiter = new RequestLimiter({
      concurrency: options.concurrency ?? REVIEW_FETCH_CONCURRENCY,
      minIntervalMs: options.minIntervalMs ?? REVIEW_FETCH_MIN_INTERVAL_MS,
    });
  }

  /** Cache statistics, for diagnostics. */
  get cacheStats(): CacheLike<RawReviewRow[]>['stats'] {
    return this.cache.stats;
  }

  /** The site itself is public; availability is really "can we reach it". */
  async isAvailable(): Promise<boolean> {
    return typeof this.fetchImpl === 'function';
  }

  /**
   * Fetch every row the site returns for a course, without aggregating.
   *
   * Exposed so a caller that needs the course-level roll-up and the teacher
   * buckets can compute both from one fetch instead of paying for two.
   *
   * @param query - course name plus optional teacher.
   * @returns the raw rows, or `null` when the API answered with `null`.
   */
  async fetchCourseRows(query: CourseSearchQuery): Promise<RawReviewRow[] | null> {
    // Same provider-level defense as `searchCourse`: the wire filter must name one person, and this entry point may not
    // assume the caller narrowed it.
    const params = this.queryParams(query.courseName.trim(), queryTeacherFilter(query.teacher));
    // No `limiter.run` here: `fetchRows` takes the slot itself, so wrapping it again would consume two slots per request and
    // would charge a rate-limit interval to a request that turned out to be a duplicate.
    return this.fetchRows(params, query.signal);
  }

  /**
   * Build the course-level roll-up for one course name.
   *
   * Always requests the corpus scoped by course name **only** (never by
   * teacher), because a course-level count must not depend on which teacher the
   * caller happens to be interested in.
   *
   * @param courseName - the published course name.
   * @param signal - caller abort signal.
   * @returns the roll-up, or `undefined` when the site has no rows for the name.
   */
  async aggregateForCourse(courseName: string, signal?: AbortSignal): Promise<CourseLevelReview | undefined> {
    const params = new URLSearchParams({ course_name: courseName.trim() });
    const rows = await this.fetchRows(params, signal);
    if (rows === null || rows.length === 0) return undefined;
    // The API does substring matching, so restrict to the exact published name
    // before counting: `高等数学` must not absorb `高等数学A1`.
    return aggregateCourse(rows.filter((row) => row.courseName === courseName.trim()), courseName.trim());
  }

  /**
   * Search the site for review rows matching a course.
   *
   * @param query - course name plus optional teacher.
   * @returns aggregated review records, plus the course-level roll-up when the
   *   teacher filter did not already narrow the request to one person.
   */
  async searchCourse(query: CourseSearchQuery): Promise<ReviewSearchResult> {
    const warnings: string[] = [];
    const courseName = query.courseName.trim();
    if (courseName.length === 0) {
      return { reviews: [], provider: this.id, fromCache: false, warnings: ['课程名称为空，未发起查询'] };
    }

    const teacher = query.teacher?.trim();
    /*
     * PROVIDER-LEVEL DEFENSE. The wire filter must name exactly one person, and this component may not assume the caller got
     * that right: a published cell like `张三、李四` reaches the API as a substring filter over a column holding one teacher per
     * review row, so sending it whole matches nothing and the class silently loses every review.
     *
     * The rule is not re-derived here. `queryTeacherFilter` is the same function the pipeline uses, so the provider and
     * `planQueries` / `lookupReviews` cannot disagree about what a teacher cell means — a second rule is how the two entry
     * points drifted apart before.
     *
     * A multi-teacher cell omits the filter rather than narrowing to the first name: the product rule is explicitly NOT
     * first-teacher-only, and quietly querying one person while claiming to answer for a class would be worse than asking for
     * the whole course and partitioning it locally.
     */
    const teacherFilter = queryTeacherFilter(query.teacher);
    const teacherScoped = teacherFilter !== undefined && teacherFilter.length > 0;
    const params = this.queryParams(courseName, teacherFilter);
    // Two cache entries per course: the teacher-scoped rows and the whole-course
    // corpus. The second is what makes "course total" answerable without asking
    // one teacher's data to stand in for the course.
    const cacheKey = `whucourses/search/${params.toString()}`;
    const corpusKey = `whucourses/corpus/${encodeURIComponent(courseName)}`;
    const cached = await this.cache.get(cacheKey);
    let rows: RawReviewRow[] | null;
    let fromCache = false;
    if (cached !== undefined) {
      rows = cached;
      fromCache = true;
    } else {
      rows = await this.fetchRows(params, query.signal);
      if (rows === null) {
        warnings.push(`whucourses 未找到「${courseName}」${teacher === undefined ? '' : `/${teacher}`} 的评价记录（接口返回 null）`);
        await this.cache.set(cacheKey, []);
        return { reviews: [], provider: this.id, fromCache: false, warnings };
      }
      await this.cache.set(cacheKey, rows);
    }

    /*
     * Clean the corpus ONCE. The teacher buckets, the current teaching class's own total and the supplementary evidence are
     * all derived from these same rows, so cleaning inside each path would run it three times and leave three parallel
     * versions of the same truth.
     */
    const cleaned = rows.map(cleanRow);
    const scopedReviews = aggregateCleanRows(cleaned, {
      ...limitOption(query.limit),
      ...(teacherScoped ? { teacherScoped: true, courseReviewCount: 0 } : {}),
    });

    const result: ReviewSearchResult = {
      reviews: scopedReviews,
      provider: this.id,
      fromCache,
      warnings,
    };

    // Nothing for this course name at all: there is no course total to look up,
    // so do not spend a second request confirming it.
    if (rows.length === 0) {
      warnings.push(`whucourses 没有「${courseName}」的任何评价记录`);
      return result;
    }

    /*
     * Both query kinds expose the course-level roll-up, always computed over the whole course rather than over one teacher's
     * rows, so a course total can never depend on which teacher was asked about.
     *
     * When no `instructor` filter was sent, THIS response already IS the whole course: `params` held only `course_name`, so
     * asking for the corpus again would repeat a byte-identical URL and return the same rows. Reusing them is not an
     * approximation — it is the same data — and it removes a pure duplicate request from every co-taught, missing-teacher and
     * unusable-cell lookup, which are exactly the cases that send no filter.
     *
     * A teacher-scoped response is genuinely different data, so the corpus is still fetched for it.
     */
    /*
     * One entry per HTTP request this call makes, so the health a caller publishes matches the requests that were actually attempted. A
     * teacher-scoped search is two requests: the teacher-filtered rows and the whole-course corpus.
     */
    const requestOutcomes: ReviewSourceQueryOutcome[] = [];
    const requestFailureKinds: ReviewSourceFailureKind[] = [];
    const corpus = teacherScoped
      ? await (async (): Promise<RawReviewRow[] | null> => {
        try {
          const fetched = await this.courseCorpus(courseName, corpusKey, query.signal);
          requestOutcomes.push(fetched === null ? 'empty' : 'rows');
          return fetched;
        } catch (error) {
          /*
           * FAILURE ISOLATION, not a relaxed match: the corpus is background context for the course, so its failure must not destroy the
           * teacher's own evidence, which was already fetched successfully. Without this the whole search threw and `defaultLookup` recorded
           * `unavailable`, discarding real data the user had paid for.
           *
           * The course-level and class-level roll-ups all derive from this corpus, so they stay ABSENT rather than being approximated from
           * the teacher's bucket: inventing them would report one teacher's rows as the whole course's.
           */
          requestOutcomes.push('unavailable');
          requestFailureKinds.push(classifyFetchFailure(error));
          warnings.push(`whucourses 课程整体评价获取失败：${(error as Error).message}`);
          return null;
        }
      })()
      : (rows.length === 0 ? null : rows);
    /*
     * The teacher-filtered request is recorded here rather than inside the branch above, so BOTH paths count it: an unfiltered search still made
     * one request, and a health record claiming zero queries would say nothing happened.
     */
    requestOutcomes.unshift(rows.length === 0 ? 'empty' : 'rows');
    // Every request this call attempted is reported, so a caller publishes the truth rather than one outcome per call.
    result.reviewSource = healthFromOutcomes(requestOutcomes, requestFailureKinds);
    if (corpus !== null) {
      const corpusCleaned = corpus.map(cleanRow);
      const courseLevel = summarizeCleanRows(corpusCleaned, courseName, 'course');
      if (courseLevel !== undefined) {
        result.courseLevel = courseLevel;
        // Now that the real course total is known, publish it on the buckets so
        // `matchedTeacherReviewCount` and `courseReviewCount` cannot be confused.
        for (const review of scopedReviews) review.courseReviewCount = courseLevel.courseReviewCount;
      }

      /*
       * Split the FULL corpus by its relationship to this class's teachers, then compute each aggregate from its own rows.
       *
       * Both new aggregates come from the corpus rather than from `cleaned`, so that a teacher-scoped fetch cannot understate
       * them: the class's related set must not depend on which teacher the caller happened to ask about.
       *
       * Neither is derived from the teacher buckets. Those buckets overlap by design — a co-taught row sits in every named
       * teacher's bucket — so their counts cannot be added, and a median cannot be recovered from a finished median.
       */
      const localTeacherNames = query.localTeacherNames ?? [];
      const partition = partitionCleanRows(corpusCleaned, courseName, localTeacherNames);
      if (localTeacherNames.length > 0) {
        const teachingClassLevel = summarizeCleanRows(partition.matched, courseName, 'teachingClass');
        // Absent when the class's teachers have no related rows. It never means "this class has no reviews".
        if (teachingClassLevel !== undefined) result.teachingClassLevel = teachingClassLevel;
      }
      const courseSupplementary = summarizeCleanRows(partition.unassigned, courseName, 'supplementary');
      if (courseSupplementary !== undefined) result.courseSupplementary = courseSupplementary;

      /*
       * The excerpt array, projected here because this is where the authoritative partition exists.
       *
       * Deliberately NOT `courseLevel.sampleRows`: that aggregate is a mixed slice of the whole course — measured, its first rows
       * can be a 张三 row, a 李四 row, a row naming the teacher field as prose and a row naming nobody — so selecting from it
       * would reintroduce exactly the provenance ambiguity the partition removes. `partition` is already scoped; these three
       * arrays are the scopes.
       *
       * No extra request is made: the corpus was read for the aggregates that are already computed above.
       */
      result.reviewExcerpts = selectReviewExcerpts(partition);
    }
    return result;
  }

  /**
   * Fetch (or reuse) the whole-course corpus for one course name.
   *
   * Kept separate from the teacher-scoped rows on purpose: it is the only source
   * of a course total, and mixing the two would let a teacher filter change it.
   *
   * @param courseName - the published course name.
   * @param corpusKey - cache key for the corpus.
   * @param signal - caller abort signal.
   * @returns the corpus rows, or `null` when the site has none.
   */
  private async courseCorpus(
    courseName: string,
    corpusKey: string,
    signal: AbortSignal | undefined,
  ): Promise<RawReviewRow[] | null> {
    const cached = await this.cache.get(corpusKey);
    if (cached !== undefined) {
      return cached.length === 0 ? null : cached;
    }
    const params = new URLSearchParams({ course_name: courseName });
    const rows = await this.fetchRows(params, signal);
    if (rows === null) {
      await this.cache.set(corpusKey, []);
      return null;
    }
    const scoped = rows.filter((row) => row.courseName === courseName);
    await this.cache.set(corpusKey, scoped);
    return scoped.length === 0 ? null : scoped;
  }

  /**
   * Assemble the request parameters from an already-normalized course name and teacher filter.
   *
   * This is a pure assembler and deliberately NOT the place where the teacher is vetted: the cache key is built from exactly
   * these parameters, so a guard applied here would produce one key while the request carried another. The vetting happens
   * once in {@link searchCourse}, before anything is derived from the parameters.
   *
   * Both filters are case-insensitive substrings server-side and AND-ed, which is exactly the disambiguation we want:
   * `instructor` narrows the corpus to one person, which is both cheaper and the request the site itself makes.
   *
   * @param courseName - the trimmed course name.
   * @param teacherFilter - a single teacher's name, or `undefined` to send no filter.
   * @returns the query parameters.
   */
  private queryParams(courseName: string, teacherFilter: string | undefined): URLSearchParams {
    const params = new URLSearchParams({ course_name: courseName });
    if (teacherFilter !== undefined && teacherFilter.length > 0) params.set('instructor', teacherFilter);
    return params;
  }

  /**
   * Fetch and normalize rows from `/api/search`.
   *
   * @param params - query string parameters.
   * @param signal - caller abort signal.
   * @returns normalized rows, or `null` when the API answered with `null`.
   */
  /**
   * Fetch and normalize rows from `/api/search`, coalescing identical concurrent requests.
   *
   * ## Where the coalescing lives, and what it deliberately does NOT cover
   *
   * This is the exact HTTP layer, so the key is the FINAL request URL. Everything that makes two requests the same or different
   * is in it already: the origin, the path, and the query parameters — including `instructor`. A teacher-scoped request and a
   * whole-course request are therefore never merged, which matters because they are genuinely different data.
   *
   * It does NOT cover the work built on top of it. Each caller still runs its own `localTeacherNames` partition, so two callers
   * that share one request still get their OWN `teachingClassLevel` and `courseSupplementary`. Sharing the transport must never
   * become sharing the semantics: two teaching classes of one course ask the identical question of the site and must still be
   * answered separately about which reviews belong to which class.
   *
   * It also does not dedupe `cache.set`. Two callers that share one request each write the result to their own cache key
   * afterwards; that is a duplicate write of an identical value, and out of scope here.
   *
   * ## Signal rule
   *
   * A request WITHOUT a signal participates. A request WITH one bypasses this map completely — it neither reads nor writes an
   * entry, and takes its own limiter slot and its own `requestJson` call. That preserves today's cancellation behaviour exactly
   * and removes any dependence on which caller happened to arrive first.
   *
   * ## Cleanup
   *
   * The cleanup promise is the one STORED and the one RETURNED, so no `.finally()` result is discarded and no rejected cleanup
   * branch is left unobserved. The delete is identity-checked, so a slower predecessor can never remove a newcomer's entry.
   *
   * @param params - query string parameters.
   * @param signal - caller abort signal. Its PRESENCE disables coalescing.
   * @returns normalized rows, or `null` when the API answered `null`.
   */
  private async fetchRows(params: URLSearchParams, signal: AbortSignal | undefined): Promise<RawReviewRow[] | null> {
    const url = `${this.origin}/api/search?${params.toString()}`;

    // A signaled caller keeps its own request lifecycle. It must not join someone else's, or a cancellation would leak sideways.
    if (signal !== undefined) {
      return this.requestRows(url, signal);
    }

    const existing = this.pending.get(url);
    if (existing !== undefined) return existing;

    /*
     * The map is written SYNCHRONOUSLY, before the first await, so a second caller arriving in the same tick finds the entry
     * rather than starting a rival request. That is also why no `limiter.run` happens above this line: a duplicate must never take
     * a limiter slot or consume a rate-limit interval.
     */
    const tracked = this.requestRows(url, signal).finally(() => {
      // Identity-checked: only the entry this promise owns is removed.
      if (this.pending.get(url) === tracked) this.pending.delete(url);
    });
    this.pending.set(url, tracked);
    return tracked;
  }

  /**
   * Perform one request: take a limiter slot, fetch, normalize.
   *
   * `pending` is never touched here, so the coalescing decision stays in one place.
   *
   * @param url - the finished request URL.
   * @param signal - caller abort signal, forwarded as-is.
   */
  private async requestRows(url: string, signal: AbortSignal | undefined): Promise<RawReviewRow[] | null> {
    const payload = await this.limiter.run(() => this.requestJson(url, signal));
    // The API answers `null` (not `[]`) when nothing matches. This is the single
    // most important guard against a crash on a common path.
    if (payload === null) return null;
    if (!Array.isArray(payload)) {
      throw new ReviewProviderError(this.id, 'unexpected-shape', `期望数组响应，实际收到 ${typeof payload}`);
    }
    return payload
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
      .map((item) => normalizeRow(item));
  }

  /**
   * Perform one JSON GET with timeout and abort propagation.
   *
   * ## A cancel that arrived before the request
   *
   * A caller may hand over a signal that is ALREADY aborted — it cancelled while the lookup was still being assembled. An
   * `abort` listener cannot fire for an event that has already happened, so registering one and stopping there let the request
   * go out anyway: a cancelled lookup still cost the review site a real request.
   *
   * So the listener is registered FIRST and the signal is inspected IMMEDIATELY AFTER, which is the race-safe order. Inspecting
   * first and registering second would leave a window where an abort lands in between and is never seen. A signal-less request
   * skips both steps entirely and behaves exactly as before.
   *
   * The early throw also means the pre-aborted path never creates a timer, which is why the timer's creation sits after it.
   *
   * @param url - the finished request URL.
   * @param signal - caller abort signal, or `undefined`.
   * @returns the parsed JSON body, or `null` for an empty body.
   */
  private async requestJson(url: string, signal: AbortSignal | undefined): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const controller = new AbortController();
      if (signal !== undefined) {
        onAbort = (): void => controller.abort(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        /*
         * The race-safe order: register FIRST, inspect IMMEDIATELY AFTER. Inspecting first and registering second would leave a
         * window where an abort lands in between and is never observed.
         *
         * This throw travels to the catch below, so the rejection is the same `'network-error'` the transport boundary already
         * produces — no new error code, and nothing new for a caller to handle.
         */
        if (signal.aborted) {
          throw new Error(`请求已被取消：${String(signal.reason)}`);
        }
      }
      timer = setTimeout(() => controller.abort(new Error('timeout')), this.timeoutMs);
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ReviewProviderError(
          this.id,
          'http-error',
          `whucourses 返回 HTTP ${response.status} ${response.statusText}`,
          response.status,
        );
      }
      const text = await response.text();
      if (text.trim().length === 0) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch (error) {
        throw new ReviewProviderError(this.id, 'invalid-json', `响应不是合法 JSON：${(error as Error).message}`);
      }
    } catch (error) {
      if (error instanceof ReviewProviderError) throw error;
      const message = (error as Error).message;
      throw new ReviewProviderError(this.id, 'network-error', `无法访问 whucourses：${message}`);
    } finally {
      // Safe when the pre-aborted path returned before creating it.
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Release the limiter's timers (none are held) and drop memory cache. */
  async dispose(): Promise<void> {
    await this.cache.clear();
  }
}

/** Translate a query limit into an aggregate option, if present. */
function limitOption(limit: number | undefined): { limit?: number } {
  if (limit === undefined) return {};
  return { limit: Math.max(1, Math.trunc(limit)) };
}
