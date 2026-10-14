/**
 * Course <-> review matching.
 *
 * Binding a course name to review data is the highest-risk step in the pipeline:
 * review sites have no course code, many courses share a name across teachers,
 * and a wrong binding is worse than no binding. The matcher therefore:
 *
 * - tries the strongest identifiers first (course code, then code + teacher),
 * - falls back through name + teacher, exact name, then fuzzy name,
 * - applies an explicit penalty whenever the two sides disagree about the
 *   teacher, which is strong evidence they are different courses,
 * - refuses anything below {@link REVIEW_MATCH_THRESHOLD} and reports
 *   `method: 'unmatched'` plus a note instead of attaching wrong data.
 *
 * @module @course-copilot/core/matching/courseMatcher
 */

import { REVIEW_MATCH_THRESHOLD } from '../config.js';
import { courseAliases, qualifiersConflict } from '../alias.js';
import { normalizeCourseName, normalizeTeacherName, teacherNameSet, teacherSetRelation } from '../normalize.js';
import { fuzzyNameScore } from '../similarity.js';
import type {
  CourseReview,
  MatchMethod,
  MatchResult,
  NormalizedCourse,
  ProviderId,
} from '../types/course.js';

/** A review record indexed for lookup. */
interface IndexedReview {
  review: CourseReview;
  nameKey: string;
  /** Alias keys derived from the name by removing a volume/part qualifier. */
  aliasKeys: readonly string[];
  teacherKey: string;
  codeKey: string;
}

/** Signature of the matching entry point, so callers can inject a fake. */
export type CourseMatcher = (
  course: NormalizedCourse,
  candidates: readonly CourseReview[],
) => MatchResult;

/**
 * Base confidence per method, before teacher corroboration.
 *
 * The ladder is a contract, asserted in tests: every exact method outranks both
 * alias methods, and both alias methods outrank every fuzzy method. An alias is a
 * genuine weakening of evidence — `高等数学（上）` matched to `高等数学` is plausible
 * but not certain — so it may not borrow the exact match's confidence.
 */
/**
 * Base confidence per method, before teacher corroboration.
 *
 * The ladder is a contract, asserted in tests: `exact > alias > fuzzy`, and
 * `*_teacher > *` within each tier.
 *
 * **Only the exact methods clear {@link REVIEW_MATCH_THRESHOLD}.** Both alias
 * tiers and both fuzzy tiers sit below it on purpose, so they are *surfaced* with
 * their method and confidence rather than silently bound: `高等数学（上）` may well be
 * `高等数学`, but "may well be" is not a licence to attribute one course's reviews
 * to another without the user confirming. Teacher agreement still raises an alias
 * well above the same alias without it — it just does not cross the line.
 */
const BASE_CONFIDENCE: Record<Exclude<MatchMethod, 'unmatched'>, number> = {
  course_code: 0.95,
  course_code_teacher: 1,
  name_teacher: 0.94,
  exact_name: 0.78,
  alias_name_teacher: 0.68,
  alias_name: 0.6,
  fuzzy_name_teacher: 0.56,
  fuzzy_name: 0.4,
};

/** Fuzzy name similarity below which a candidate is not worth considering. */
const FUZZY_FLOOR = 0.55;

/**
 * Normalize a course code for comparison.
 *
 * @param code - raw code from either side.
 * @returns an uppercase, separator-free key, or an empty string.
 */
export function normalizeCourseCode(code: string | undefined): string {
  if (code === undefined) return '';
  return code.normalize('NFKC').toUpperCase().replace(/[\s\-_./\\()[\]]+/gu, '');
}

/** Build the lookup keys for one review record. */
function indexReview(review: CourseReview): IndexedReview {
  const nameKey = review.normalizedName.length > 0
    ? review.normalizedName
    : normalizeCourseName(review.courseName);
  return {
    review,
    // Fall back to normalizing the raw name so a provider that forgot to fill in
    // `normalizedName` cannot silently make every candidate unmatchable. The
    // normalizer is idempotent, so a correct value passes through unchanged.
    nameKey,
    // Aliases come from the raw name, because the qualifier is what gets removed.
    aliasKeys: courseAliases(review.courseName).aliases.map((alias) => alias.key),
    teacherKey: review.normalizedTeacher ?? normalizeTeacherName(review.teacher),
    codeKey: normalizeCourseCode(review.courseCode),
  };
}

/** Teacher relationship between a course and a review. */
type TeacherRelation = 'agree' | 'disagree' | 'unknown';

/**
 * The teacher names a review record offers, normalized and de-duplicated.
 *
 * `teacherNames` is preferred because it is the complete list a co-taught row named, while `teacher` is set only when the row
 * named exactly one person — so reading `teacher` alone silently discards every co-taught row's identity, which is what made
 * joint teaching unmatchable. `teacher` and `normalizedTeacher` are the fallbacks for providers that fill in only those.
 *
 * @param candidate - the indexed review.
 * @returns distinct normalized teacher names; empty when the row names nobody.
 */
function reviewTeacherNames(candidate: IndexedReview): string[] {
  const names = teacherNameSet(candidate.review.teacherNames);
  if (names.length > 0) return names;
  return teacherNameSet(candidate.review.teacher ?? candidate.review.normalizedTeacher);
}

/**
 * Classify the teacher relationship as SET OVERLAP, not name equality.
 *
 * ## The rule
 *
 * Agreement is `WHU teachers ∩ review teachers ≠ ∅`. Demanding equal sets would reject every co-taught class, because the
 * selection page and a review site routinely list different subsets — and the previous behaviour, which normalized the whole
 * cell and therefore kept only the FIRST name, could never match a class co-taught by 张三 and 李四 against the review row
 * naming 李四.
 *
 * ## What is deliberately NOT used
 *
 * Only structured teacher fields are consulted. Review commentary is never searched for a name: a row reading
 * *"不是张三老师上的"* contains a teacher's name while asserting the opposite, so matching on text would bind data to the
 * wrong person.
 *
 * @param course - the normalized course.
 * @param candidate - the indexed review.
 * @returns the relation; `'unknown'` when either side names nobody.
 */
function teacherRelation(course: NormalizedCourse, candidate: IndexedReview): TeacherRelation {
  const relation = teacherSetRelation(course.teacher, reviewTeacherNames(candidate));
  return relation;
}

/**
 * Apply the teacher adjustment to a base confidence.
 *
 * Agreement adds a bounded bonus, disagreement applies a hard penalty and a
 * ceiling, because the same course name taught by a different teacher is a
 * different experience and often a different course altogether.
 *
 * @param base - method base confidence.
 * @param relation - teacher relationship.
 * @returns the adjusted confidence in `[0, 1]`.
 */
function applyTeacherAdjustment(base: number, relation: TeacherRelation): number {
  switch (relation) {
    case 'agree':
      return Math.min(1, base + 0.03);
    case 'disagree':
      return Math.min(0.5, base * 0.55);
    case 'unknown':
      return base;
  }
}

/** A scored candidate produced by one matching strategy. */
interface CandidateMatch {
  indexed: IndexedReview;
  method: Exclude<MatchMethod, 'unmatched'>;
  confidence: number;
  similarity: number;
}

/**
 * Score every candidate that could plausibly represent the course.
 *
 * @param course - normalized course from the selection page.
 * @param indexed - indexed review candidates.
 * @returns candidates that produced at least one strategy hit, unsorted.
 */
function candidatesFor(course: NormalizedCourse, indexed: readonly IndexedReview[]): CandidateMatch[] {
  const courseCode = normalizeCourseCode(course.courseCode);
  const out: CandidateMatch[] = [];

  for (const candidate of indexed) {
    const relation = teacherRelation(course, candidate);
    let best: CandidateMatch | undefined;

    const consider = (
      method: Exclude<MatchMethod, 'unmatched'>,
      confidence: number,
      similarity: number,
    ): void => {
      const proposal: CandidateMatch = { indexed: candidate, method, confidence, similarity };
      if (best === undefined || proposal.confidence > best.confidence) best = proposal;
    };

    // 1/2. Course code identifiers.
    if (courseCode.length > 0 && candidate.codeKey.length > 0 && courseCode === candidate.codeKey) {
      if (relation === 'agree') consider('course_code_teacher', applyTeacherAdjustment(BASE_CONFIDENCE.course_code_teacher, relation), 1);
      else if (relation === 'disagree') {
        // Same code but a different teacher: still the strongest identifier we
        // have, but the binding must not be trusted blindly.
        consider('course_code', applyTeacherAdjustment(BASE_CONFIDENCE.course_code, relation), 1);
      } else consider('course_code', BASE_CONFIDENCE.course_code, 1);
    }

    // 3/4. Name similarity, corroborated by the teacher when we have one.
    const nameSimilarity = similarityBetween(course, candidate);
    if (nameSimilarity >= 1) {
      if (relation === 'agree') consider('name_teacher', applyTeacherAdjustment(BASE_CONFIDENCE.name_teacher, relation), 1);
      else if (relation === 'disagree') consider('exact_name', applyTeacherAdjustment(BASE_CONFIDENCE.exact_name, relation), 1);
      else consider('exact_name', BASE_CONFIDENCE.exact_name, 1);
    } else if (aliasSimilarityBetween(course, candidate) >= 1) {
      // 5/6. The course name carries a qualifier the review site dropped (or vice
      // versa). This is a *weaker* claim than an exact name, so it gets its own
      // method and a lower base confidence — it must never masquerade as exact.
      if (relation === 'agree') consider('alias_name_teacher', applyTeacherAdjustment(BASE_CONFIDENCE.alias_name_teacher, relation), 1);
      else if (relation === 'disagree') consider('alias_name', applyTeacherAdjustment(BASE_CONFIDENCE.alias_name, relation), 1);
      else consider('alias_name', BASE_CONFIDENCE.alias_name, 1);
    } else if (nameSimilarity >= FUZZY_FLOOR && !qualifiersConflict(course.courseName, candidate.review.courseName)) {
      const base = BASE_CONFIDENCE.fuzzy_name + (BASE_CONFIDENCE.fuzzy_name_teacher - BASE_CONFIDENCE.fuzzy_name) * (nameSimilarity - FUZZY_FLOOR) / (1 - FUZZY_FLOOR);
      if (relation === 'agree') consider('fuzzy_name_teacher', applyTeacherAdjustment(base, relation), nameSimilarity);
      else if (relation === 'disagree') consider('fuzzy_name', applyTeacherAdjustment(base, relation), nameSimilarity);
      else consider('fuzzy_name', base, nameSimilarity);
    }

    if (best !== undefined) out.push(best);
  }
  return out;
}

/**
 * Name similarity between a course and a review candidate.
 *
 * Uses both the course's normalized key and its raw normalized name so a
 * code-prefixed page name still compares against the review site's bare name.
 *
 * @param course - normalized course.
 * @param candidate - indexed review.
 * @returns `0..1`; `1` means an exact key match.
 */
function similarityBetween(course: NormalizedCourse, candidate: IndexedReview): number {
  // Normalizing as a fallback keeps the matcher correct even for a course object
  // assembled by hand (the tool layer does this for `course_lookup_reviews`).
  const courseKey = course.normalizedName.length > 0
    ? course.normalizedName
    : normalizeCourseName(course.courseName);
  if (courseKey.length > 0 && courseKey === candidate.nameKey) return 1;
  return fuzzyNameScore(courseKey, candidate.nameKey);
}

/**
 * Alias similarity between a course and a review candidate.
 *
 * `1` means the course's alias key equals the candidate's exact name, or the
 * candidate's alias key equals the course's exact name. Either direction counts,
 * because a review site may drop a qualifier the page has, or add one the page
 * omits.
 *
 * @param course - normalized course.
 * @param candidate - indexed review.
 * @returns `1` on an alias hit, else `0`.
 */
function aliasSimilarityBetween(course: NormalizedCourse, candidate: IndexedReview): number {
  const courseKey = course.normalizedName.length > 0
    ? course.normalizedName
    : normalizeCourseName(course.courseName);
  if (courseKey.length === 0) return 0;
  const courseAliasKeys = courseAliases(course.courseName).aliases.map((alias) => alias.key);
  if (courseAliasKeys.includes(candidate.nameKey)) return 1;
  if (candidate.aliasKeys.includes(courseKey)) return 1;
  return 0;
}

/**
 * Match one course against a provider's review candidates.
 *
 * @param course - normalized course from the selection page.
 * @param candidates - review records from one provider.
 * @returns the best match, or an `unmatched` result carrying a note.
 */
export const matchCourse: CourseMatcher = (course, candidates) => {
  if (candidates.length === 0) {
    return {
      course,
      confidence: 0,
      method: 'unmatched',
      note: '评价站点没有返回任何候选记录',
    };
  }

  const indexed = candidates.map(indexReview);
  const scored = candidatesFor(course, indexed);
  if (scored.length === 0) {
    return {
      course,
      confidence: 0,
      method: 'unmatched',
      note: `评价站点返回了 ${candidates.length} 条候选，但没有一条达到匹配下限`,
    };
  }

  scored.sort((left, right) => {
    if (left.confidence !== right.confidence) return right.confidence - left.confidence;
    if (left.similarity !== right.similarity) return right.similarity - left.similarity;
    const leftCount = left.indexed.review.reviewCount;
    const rightCount = right.indexed.review.reviewCount;
    if (leftCount !== rightCount) return rightCount - leftCount;
    const leftName = left.indexed.review.courseName;
    const rightName = right.indexed.review.courseName;
    if (leftName !== rightName) return leftName < rightName ? -1 : 1;
    const leftTeacher = left.indexed.review.teacher ?? '';
    const rightTeacher = right.indexed.review.teacher ?? '';
    return leftTeacher < rightTeacher ? -1 : leftTeacher > rightTeacher ? 1 : 0;
  });

  const winner = scored[0];
  if (winner === undefined) {
    return { course, confidence: 0, method: 'unmatched', note: '匹配阶段没有产生候选' };
  }

  const trusted = winner.confidence >= REVIEW_MATCH_THRESHOLD;
  const alternatives = scored
    .slice(1, 4)
    .map((entry) => entry.indexed.review);

  const result: MatchResult = {
    course,
    confidence: Number(winner.confidence.toFixed(4)),
    method: winner.method,
    aliasUsed: winner.method.startsWith('alias_'),
  };
  if (trusted) result.review = winner.indexed.review;
  if (alternatives.length > 0) result.alternatives = alternatives;
  if (!trusted) {
    result.note = winner.method.startsWith('alias_')
      ? `课程名通过 alias 近似匹配（方法 ${winner.method}，置信度 ${winner.confidence.toFixed(2)}）低于阈值`
        + ` ${REVIEW_MATCH_THRESHOLD}；这可能是同一门课的不同写法，但未经确认不会绑定评价数据`
      : `匹配置信度 ${winner.confidence.toFixed(2)} 低于阈值 ${REVIEW_MATCH_THRESHOLD}，评价匹配不确定，未绑定数据`;
  } else if (teacherRelation(course, winner.indexed) === 'unknown') {
    result.note = '课程或评价缺少教师信息，匹配仅依据课程名称';
  }
  return result;
};

/**
 * Match a list of courses against one provider's candidates.
 *
 * @param courses - normalized courses.
 * @param candidates - review records.
 * @param matcher - matching strategy to use; defaults to {@link matchCourse}.
 * @returns one result per course, in input order.
 */
export function matchCourses(
  courses: readonly NormalizedCourse[],
  candidates: readonly CourseReview[],
  matcher: CourseMatcher = matchCourse,
): MatchResult[] {
  return courses.map((course) => matcher(course, candidates));
}

/** Describe the provider(s) a set of matched reviews came from. */
export function matchedProviders(matches: readonly MatchResult[]): ProviderId[] {
  const providers = new Set<ProviderId>();
  for (const match of matches) {
    if (match.review !== undefined) providers.add(match.review.provider);
  }
  return [...providers].sort();
}
