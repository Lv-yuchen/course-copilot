/**
 * PRE-RELEASE-UX-A16 — the excerpt array reaches both result entries, and changes nothing else.
 *
 * ## What is being proved
 *
 * The engine carries the provider's bounded, already-scoped excerpt array into `Recommendation.reviewExcerpts` and
 * `RatedButNotRecommendedEntry.reviewExcerpts`, publishes `[]` rather than `undefined` so a renderer has no maybe to interpret, and
 * — the part that matters most — computes everything else EXACTLY as it did before. An excerpt is presentation data, so adding one
 * must not move a rank, a score, a confidence or a grade aggregate.
 *
 * ## How "changes nothing else" is measured
 *
 * By running the SAME evidence twice, once with excerpts and once without, and requiring the results to agree on every field except
 * the excerpts. A before/after comparison against a stored expectation would only prove the expectation was updated.
 *
 * @module
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { recommendCourses } from '@course-copilot/recommendation';
import type { RatedButNotRecommendedEntry, Recommendation, ReviewExcerpt } from '@course-copilot/core/course';

const NAME = '数据结构';
const OTHER = '大学物理';
const ZHANG = '张三';

const POLICY = {
  defaultPreferences: { gradeFriendliness: 0.5, workloadFriendliness: 0.3, attendanceFriendliness: 0.15, overallScore: 0.05 },
  defaultTopN: 5, maxTopN: 50, candidateLimit: 25,
} as never;

/** The aspect scores the engine needs in order to have something to rank on. */
const ASPECTS = {
  scores: ['gradeFriendliness', 'workloadFriendliness', 'attendanceFriendliness', 'overallScore'].map((aspect) => ({
    aspect, score: 8, evidenceReviewCount: 2, mentionCount: 2,
    positiveReviewCount: 2, negativeReviewCount: 0, mixedReviewCount: 0,
    positiveMentions: 2, negativeMentions: 0, sampleCount: 2, matchedTerms: [], note: 'fixture',
  })),
  positiveMentions: 8, negativeMentions: 0, mixedReviewCount: 0, coveredReviewCount: 2, reviewCount: 2, examFormats: {},
};

const GRADES = {
  validSampleCount: 2, ambiguousSampleCount: 0, invalidSampleCount: 0, belowPassSampleCount: 0,
  percentageDistribution: { '90': 2 }, distribution: { '90': 2 },
};

/** A teacher bucket in the provider's `CourseReview` shape. */
function teacherReview(courseName: string): Record<string, unknown> {
  return {
    provider: 'stub', courseName, normalizedName: courseName,
    reviewCount: 2, courseReviewCount: 2, matchedTeacherReviewCount: 2,
    reviewedCount: 2, coveredReviewCount: 2, gradedSampleCount: 2,
    meanGrade: 90, medianGrade: 90, gradeDistribution: { '90': 2 },
    aspects: ASPECTS,
  };
}

/** A roll-up in the provider's `CourseLevelReview` shape. */
function levelReview(courseName: string, scope: string): Record<string, unknown> {
  return {
    provider: 'stub', courseName, normalizedName: courseName, scope,
    courseReviewCount: 2, validTeacherReviewCount: 2,
    malformedTeacherReviewCount: 0, missingTeacherReviewCount: 0, multipleTeacherReviewCount: 0,
    teacherCandidates: [], aspects: ASPECTS, grades: GRADES,
    meanGrade: 90, medianGrade: 90,
  };
}

/** The two excerpts a scripted provider offers, in the shipped DTO shape. */
const EXCERPTS: ReviewExcerpt[] = [
  { text: '张三的课很稳', scope: 'current_class', teacherNames: [ZHANG], teacherValidity: 'valid' },
  { text: '王五的班给分高', scope: 'course_reference', teacherNames: ['王五'], teacherValidity: 'valid' },
];

/** A provider response, optionally carrying excerpts. */
function responseFor(courseName: string, excerpts?: ReviewExcerpt[]): Record<string, unknown> {
  return {
    reviews: [teacherReview(courseName)],
    provider: 'stub',
    fromCache: false,
    warnings: [],
    courseLevel: levelReview(courseName, 'course'),
    teachingClassLevel: levelReview(courseName, 'teachingClass'),
    ...(excerpts === undefined ? {} : { reviewExcerpts: excerpts }),
  };
}

/** Recommend a pair with `topN = 1`, so one entry is recommended and the other rated from the same evidence. */
async function pair(withExcerpts: boolean): Promise<{ recommended: Record<string, unknown>; rated: Record<string, unknown> }> {
  const make = (courseName: string): Record<string, unknown> => ({ source: 'whu', courseName, normalizedName: courseName, availability: 'unknown', teacher: ZHANG });
  const result = await recommendCourses(
    [make(NAME) as never, make(OTHER) as never],
    {},
    {
      providers: [{
        searchCourse: async (query: { courseName: string }) => responseFor(query.courseName, withExcerpts ? EXCERPTS : undefined),
      } as never],
      policy: { ...(POLICY as object), defaultTopN: 1 } as never,
    },
  );
  const recommended = result.recommendations[0] as never as Record<string, unknown> | undefined;
  const rated = result.ratedButNotRecommended[0] as never as Record<string, unknown> | undefined;
  if (recommended === undefined || rated === undefined) throw new Error('pair incomplete');
  return { recommended, rated };
}

describe('PRE-RELEASE-UX-A16 both result entries carry the excerpts', () => {
  it('a recommended entry publishes the provider array verbatim', async () => {
    const { recommended } = await pair(true);
    expect(recommended.reviewExcerpts).toEqual(EXCERPTS);
    /*
     * Verbatim, including the scope names the provider chose. The engine does not re-scope, re-order or re-label: were it to re-derive
     * `current_class`, this array would be the second answer to a question the partition already answered.
     */
    expect((recommended.reviewExcerpts as ReviewExcerpt[]).map((excerpt) => excerpt.scope)).toEqual(['current_class', 'course_reference']);
  });

  it('a rated entry carries the same array, not a reduced one', async () => {
    const { rated } = await pair(true);
    expect(rated.reviewExcerpts).toEqual(EXCERPTS);
  });

  it('publishes an empty array rather than undefined when the provider offers none', async () => {
    /*
     * `[]` is a real answer and `undefined` is a question mark. A renderer must not have to decide what a missing field means, and a
     * provider that does not produce excerpts — an injected fake, an older build — must not make the result shape optional.
     */
    const { recommended, rated } = await pair(false);
    expect(Object.hasOwn(recommended, 'reviewExcerpts')).toBe(true);
    expect(recommended.reviewExcerpts).toEqual([]);
    expect(Object.hasOwn(rated, 'reviewExcerpts')).toBe(true);
    expect(rated.reviewExcerpts).toEqual([]);
  });

  it('equivalent evidence produces excerpt arrays of the same shape on both paths', async () => {
    /*
     * The two entries describe different COURSES and are built by different code paths, so their top-level key sets legitimately differ —
     * a recommended entry carries aspects and weights a rated one does not. What must NOT differ is the excerpt DTO: a renderer that can
     * read one path's excerpts can read the other's, with the same four fields and the same scope vocabulary.
     */
    const { recommended, rated } = await pair(true);
    const shapes = [recommended, rated].map((entry) =>
      (entry.reviewExcerpts as ReviewExcerpt[]).map((excerpt) => Object.keys(excerpt).sort()));
    expect(shapes[0]).toEqual(shapes[1]);
    expect(shapes[0]).toEqual([['scope', 'teacherNames', 'teacherValidity', 'text'], ['scope', 'teacherNames', 'teacherValidity', 'text']]);
    // Both paths publish the same scope vocabulary, drawn from the provider's partition rather than invented per path.
    const scopes = [recommended, rated].map((entry) => (entry.reviewExcerpts as ReviewExcerpt[]).map((excerpt) => excerpt.scope));
    expect(scopes[0]).toEqual(scopes[1]);
    expect(scopes[0]).toEqual(['current_class', 'course_reference']);
  });
});

describe('PRE-RELEASE-UX-A16 the fields are REQUIRED, which only the type can say', () => {
  it('both entries declare reviewExcerpts as a required array, not a maybe', () => {
    /*
     * A mutation proved this needs saying here. Making the field optional on `RatedButNotRecommendedEntry` compiles, changes no runtime behaviour — the engine
     * still assigns a real array — and so left every behavioural case green. "Required" is a TYPE contract, and only a type assertion can hold it.
     *
     * Asserted through `expectTypeOf`, so the ROOT TYPECHECK is the gate: loosening either field to `ReviewExcerpt[] | undefined` makes these lines fail to
     * compile, which is the correct outcome rather than a test that noticed.
     */
    expectTypeOf<Recommendation['reviewExcerpts']>().toEqualTypeOf<ReviewExcerpt[]>();
    expectTypeOf<RatedButNotRecommendedEntry['reviewExcerpts']>().toEqualTypeOf<ReviewExcerpt[]>();
    // And `undefined` is NOT assignable, which is the half a `toMatchTypeOf` would let through.
    expectTypeOf<undefined>().not.toMatchTypeOf<Recommendation['reviewExcerpts']>();
    expectTypeOf<undefined>().not.toMatchTypeOf<RatedButNotRecommendedEntry['reviewExcerpts']>();
  });
});

describe('PRE-RELEASE-UX-A16 the excerpts change nothing else', () => {
  it('leaves membership, rank, score, confidence and grade aggregates identical', async () => {
    /*
     * The same evidence, run twice. Every field that takes part in a decision must be equal; only the excerpts may differ. This is the
     * measurement that makes "presentation only" a fact rather than an intention.
     */
    const withIt = await pair(true);
    const without = await pair(false);
    for (const key of ['rank', 'score', 'riskAdjustedScore', 'confidence', 'effectiveWeights', 'reasons', 'reviewContext', 'gradeAggregates', 'topAspects', 'missingDimensions']) {
      expect(withIt.recommended[key], `recommended.${key}`).toEqual(without.recommended[key]);
      expect(withIt.rated[key], `rated.${key}`).toEqual(without.rated[key]);
    }
    // And the only difference there is, is the excerpts.
    expect(withIt.recommended.reviewExcerpts).not.toEqual(without.recommended.reviewExcerpts);
    expect(without.recommended.reviewExcerpts).toEqual([]);
  });

  it('does not change which course is recommended', async () => {
    const withIt = await pair(true);
    const without = await pair(false);
    expect((withIt.recommended.course as { courseName: string }).courseName).toBe((without.recommended.course as { courseName: string }).courseName);
    expect((withIt.rated.course as { courseName: string }).courseName).toBe((without.rated.course as { courseName: string }).courseName);
  });

  it('does not add excerpts to insufficient-evidence entries', async () => {
    /*
     * A course with no trusted review data was never scored, so there is no evidence to quote and no presentation to build. Adding the
     * field there would be a claim about a course the engine declined to judge.
     */
    const result = await recommendCourses(
      [{ source: 'whu', courseName: NAME, normalizedName: NAME, availability: 'unknown', teacher: ZHANG } as never],
      {},
      { providers: [{ searchCourse: async () => ({ reviews: [], provider: 'stub', fromCache: false, warnings: [] }) } as never], policy: POLICY },
    );
    expect(result.insufficientData.length).toBe(1);
    expect(Object.hasOwn(result.insufficientData[0] as object, 'reviewExcerpts')).toBe(false);
    // The array exists on the RESULT only where a scored entry does, so no excerpt reached a course the engine would not rank.
    expect(result.recommendations).toEqual([]);
    expect(result.ratedButNotRecommended).toEqual([]);
  });

  it('carries excerpts through a capping provider unchanged in count when already at the cap', async () => {
    // The provider is the authority on the cap; the engine must not shrink or grow a compliant array.
    const atCap: ReviewExcerpt[] = [1, 2, 3].map((index) => ({
      text: `第${index}条`, scope: 'current_class', teacherNames: [ZHANG], teacherValidity: 'valid',
    }));
    const { recommended } = await pair(true);
    expect(recommended.reviewExcerpts).toHaveLength(EXCERPTS.length);
    const result = await recommendCourses(
      [{ source: 'whu', courseName: NAME, normalizedName: NAME, availability: 'unknown', teacher: ZHANG } as never],
      {},
      { providers: [{ searchCourse: async () => responseFor(NAME, atCap) } as never], policy: POLICY },
    );
    expect(result.recommendations[0]?.reviewExcerpts).toHaveLength(3);
    expect(result.recommendations[0]?.reviewExcerpts).toEqual(atCap);
  });
});
