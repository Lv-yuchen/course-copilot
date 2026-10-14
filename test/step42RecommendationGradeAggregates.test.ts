/**
 * PART 16J-PREUI-D1 — scoped grade aggregates on recommendations.
 *
 * ## What is being locked
 *
 * The provider already computes course-level and teaching-class grade roll-ups, and they already travel as far as `MatchResult`. They were
 * dropped at the `Recommendation` projection, so a caller had no way to show a student-reported average at all. This step only projects
 * them: no grade is recomputed, and nothing here touches `score`, `confidence` or the ranking.
 *
 * ## Why the three scopes are reported side by side
 *
 * The same course yields different, equally true numbers depending on which rows are counted. The caller picks by teaching-class structure:
 * a single-teacher class shows that teacher's own figures, a co-taught class shows the rows related to its teacher set, and the whole-course
 * roll-up is background only — it must never stand in for a class, because that would fold other teachers' cohorts into it.
 */
import { describe, it, expect } from 'vitest';
import { recommendCourses } from '@course-copilot/recommendation';
import type { GradeAggregate } from '@course-copilot/core/course';

const NAME = '\u9ad8\u7b49\u6570\u5b66';
const A = '\u5f20\u8001\u5e08';
const B = '\u674e\u8001\u5e08';
const JOINT = `${A}\u3001${B}`;
/*
 * The set carries the MATCHER's keys, not the display strings: `teacherNamesOfCourse` normalizes and deduplicates, so `张老师` becomes `张`. The
 * raw cell stays on `course.teacher` for display, which is asserted separately.
 */
const NORMALIZED_A = '\u5f20';
const NORMALIZED_B = '\u674e';

const POLICY = {
  defaultPreferences: { gradeFriendliness: 0.5, workloadFriendliness: 0.3, attendanceFriendliness: 0.15, overallScore: 0.05 },
  defaultTopN: 5, maxTopN: 50, candidateLimit: 25,
} as never;

/** A grade histogram plus count, in the provider's own shape. */
function grades(mean: number | undefined, median: number | undefined, count: number, distribution: Record<string, number>): Record<string, unknown> {
  return {
    ...(mean === undefined ? {} : { meanGrade: mean }),
    ...(median === undefined ? {} : { medianGrade: median }),
    grades: {
      validSampleCount: count, ambiguousSampleCount: 0, invalidSampleCount: 0,
      percentageDistribution: distribution, belowPassSampleCount: 0, distribution,
    },
  };
}

/**
 * The aspect scores the engine needs to have something to rank on.
 *
 * The grade aggregates are what this suite is about, but a candidate with no scoreable aspect is filed as `insufficientData` before any
 * recommendation is built — so the fixture has to carry a real aspect list. What the scores ARE does not matter here; that they exist does.
 */
const ASPECTS = {
  scores: ['gradeFriendliness', 'workloadFriendliness', 'attendanceFriendliness', 'overallScore'].map((aspect) => ({
    aspect, score: 8, evidenceReviewCount: 2, mentionCount: 2,
    positiveReviewCount: 2, negativeReviewCount: 0, mixedReviewCount: 0,
    positiveMentions: 2, negativeMentions: 0, sampleCount: 2, matchedTerms: [], note: 'fixture',
  })),
  positiveMentions: 8, negativeMentions: 0, mixedReviewCount: 0, coveredReviewCount: 2, reviewCount: 2, examFormats: {},
};

/** A teacher bucket in the provider's `CourseReview` shape. */
function teacherReview(mean: number | undefined, median: number | undefined, count: number, distribution: Record<string, number>): Record<string, unknown> {
  return {
    provider: 'stub', courseName: NAME, normalizedName: NAME,
    reviewCount: count, courseReviewCount: count, matchedTeacherReviewCount: count,
    reviewedCount: count, coveredReviewCount: count,
    gradedSampleCount: count,
    ...(mean === undefined ? {} : { meanGrade: mean }),
    ...(median === undefined ? {} : { medianGrade: median }),
    gradeDistribution: distribution,
    aspects: ASPECTS,
  };
}

/** A roll-up in the provider's `CourseLevelReview` shape. */
function levelReview(scope: string, mean: number | undefined, median: number | undefined, count: number, distribution: Record<string, number>): Record<string, unknown> {
  return {
    provider: 'stub', courseName: NAME, normalizedName: NAME, scope,
    courseReviewCount: count, validTeacherReviewCount: count,
    malformedTeacherReviewCount: 0, missingTeacherReviewCount: 0, multipleTeacherReviewCount: 0,
    teacherCandidates: [],
    aspects: ASPECTS,
    ...grades(mean, median, count, distribution),
  };
}

/** A provider that answers with a scripted `ReviewSearchResult`. */
function scriptedProvider(response: Record<string, unknown>): { searchCourse: () => Promise<Record<string, unknown>> } {
  return { searchCourse: async () => response };
}

/** Recommend one teaching class against a scripted provider response. */
async function recommendOne(teacher: string | undefined, response: Record<string, unknown>): Promise<Record<string, unknown>> {
  const course: Record<string, unknown> = { source: 'whu', courseName: NAME, normalizedName: NAME, availability: 'unknown' };
  if (teacher !== undefined) course.teacher = teacher;
  const result = await recommendCourses([course as never], {}, { providers: [scriptedProvider(response) as never], policy: POLICY });
  const rec = result.recommendations[0] as never as Record<string, unknown> | undefined;
  if (rec === undefined) throw new Error(`no recommendation; insufficient=${JSON.stringify((result.insufficientData[0] as Record<string, unknown> | undefined)?.reason)}`);
  return rec;
}

const aggregatesOf = (rec: Record<string, unknown>): Record<string, unknown> => rec.gradeAggregates as Record<string, unknown>;

/**
 * Recommend a pair of courses with `topN = 1`, so exactly one is recommended and the other is RATED, from identical evidence.
 *
 * This is what makes the A11 contract testable: the two paths see the same provider response shape and the same teacher cell, so any difference between their
 * aggregates would be a difference in the projection rather than in the evidence.
 *
 * @param first - the teacher cell for the first course.
 * @param second - the teacher cell for the second course.
 * @param responseFor - the scripted response for a given course name.
 * @returns the recommended entry and the rated entry.
 */
async function recommendPair(
  first: string | undefined,
  second: string | undefined,
  responseFor: (courseName: string) => Record<string, unknown>,
): Promise<{ recommended: Record<string, unknown>; rated: Record<string, unknown> }> {
  const secondName = '\u5927\u5b66\u7269\u7406';
  const make = (courseName: string, teacher: string | undefined): Record<string, unknown> => {
    const course: Record<string, unknown> = { source: 'whu', courseName, normalizedName: courseName, availability: 'unknown' };
    if (teacher !== undefined) course.teacher = teacher;
    return course;
  };
  const result = await recommendCourses(
    [make(NAME, first) as never, make(secondName, second) as never],
    {},
    {
      providers: [{ searchCourse: async (query: { courseName: string }) => responseFor(query.courseName) } as never],
      policy: { ...(POLICY as object), defaultTopN: 1 } as never,
    },
  );
  const recommended = result.recommendations[0] as never as Record<string, unknown> | undefined;
  const rated = result.ratedButNotRecommended[0] as never as Record<string, unknown> | undefined;
  if (recommended === undefined || rated === undefined) throw new Error(`pair incomplete: rec=${recommended !== undefined} rated=${rated !== undefined}`);
  return { recommended, rated };
}

/** The same evidence for whichever course name is asked about. */
const sameEvidence = (teacher: number, course: number, count: number, name: string): Record<string, unknown> => ({
  reviews: [{ ...teacherReview(teacher, teacher, count, { '90': count }), courseName: name, normalizedName: name }],
  provider: 'stub', fromCache: false, warnings: [],
  courseLevel: { ...levelReview('course', course, course, count, { '80': count }), courseName: name, normalizedName: name },
});

describe('16J-PREUI-D1 a single-teacher class publishes the teacher aggregate', () => {
  it('A. names has one entry, teacher/teachingClass/course are all present', async () => {
    const rec = await recommendOne(A, {
      reviews: [teacherReview(90, 90, 2, { '90': 2 })],
      provider: 'stub', fromCache: false, warnings: [],
      courseLevel: levelReview('course', 80, 80, 4, { '90': 2, '60': 2 }),
      teachingClassLevel: levelReview('teachingClass', 90, 90, 2, { '90': 2 }),
    });
    const aggregates = aggregatesOf(rec);
    expect((aggregates.teacherSet as { names: string[] }).names).toEqual([NORMALIZED_A]);
    expect((aggregates.teacher as GradeAggregate).meanGrade).toBe(90);
    expect((aggregates.teacher as GradeAggregate).gradedSampleCount).toBe(2);
    expect((aggregates.teachingClass as GradeAggregate).meanGrade).toBe(90);
    expect((aggregates.course as GradeAggregate).meanGrade).toBe(80);
  });
});

describe('16J-PREUI-D1 a co-taught class publishes the class aggregate, never one teacher bucket', () => {
  it('B. the frozen three-teacher fixture: teachingClass and course differ, and C is excluded', async () => {
    /*
     * A=90,100 / B=60,70 / C=20,30 / A+B joint=80. The class is A、B, so its related rows are 90,100,60,70,80 (5 samples, mean 80) while
     * the whole course is all seven rows (mean 64.2857). C's grades must not appear in the class aggregate.
     */
    const rec = await recommendOne(JOINT, {
      reviews: [teacherReview(70, 70, 3, { '90': 1, '60': 1, '80': 1 })],
      provider: 'stub', fromCache: false, warnings: [],
      courseLevel: levelReview('course', 64.2857, 70, 7, { '20': 1, '30': 1, '60': 1, '70': 1, '80': 1, '90': 1, '100': 1 }),
      teachingClassLevel: levelReview('teachingClass', 80, 80, 5, { '60': 1, '70': 1, '80': 1, '90': 1, '100': 1 }),
    });
    const aggregates = aggregatesOf(rec);
    // The set is stated so a caller never re-parses the teacher cell.
    expect((aggregates.teacherSet as { names: string[] }).names).toEqual([NORMALIZED_A, NORMALIZED_B]);
    // One co-teacher's bucket must NOT be published as "the teacher aggregate".
    expect(aggregates.teacher).toBeUndefined();
    const teachingClass = aggregates.teachingClass as GradeAggregate;
    const course = aggregates.course as GradeAggregate;
    expect(teachingClass.meanGrade).toBe(80);
    expect(teachingClass.medianGrade).toBe(80);
    expect(teachingClass.gradedSampleCount).toBe(5);
    expect(course.meanGrade).toBe(64.2857);
    expect(course.medianGrade).toBe(70);
    expect(course.gradedSampleCount).toBe(7);
    // The distinction is the whole point of publishing both.
    expect(teachingClass.meanGrade).not.toBe(course.meanGrade);
    // C's decades are absent from the class histogram and present in the course's.
    expect(Object.keys(teachingClass.gradeDistribution)).not.toContain('20');
    expect(Object.keys(course.gradeDistribution)).toContain('20');
  });

  it('C. a co-taught class is detected from the raw cell alone, with no extra validity field', async () => {
    const rec = await recommendOne(JOINT, {
      reviews: [teacherReview(70, 70, 3, {})],
      provider: 'stub', fromCache: false, warnings: [],
      courseLevel: levelReview('course', 64.2857, 70, 7, {}),
    });
    const aggregates = aggregatesOf(rec);
    expect((aggregates.teacherSet as { names: string[] }).names).toEqual([NORMALIZED_A, NORMALIZED_B]);
    expect(aggregates.teacher).toBeUndefined();
    // No extra flag was invented: the array length is the signal.
    expect(Object.keys(aggregates).sort()).toEqual(['course', 'teacherSet']);
  });
});

describe('16J-PREUI-D1 an unknown teacher gets no candidate-specific grade', () => {
  it('D. names is empty, teacher and teachingClass are absent, course may remain', async () => {
    const rec = await recommendOne(undefined, {
      reviews: [teacherReview(70, 70, 3, {})],
      provider: 'stub', fromCache: false, warnings: [],
      courseLevel: levelReview('course', 64.2857, 70, 7, {}),
    });
    const aggregates = aggregatesOf(rec);
    expect((aggregates.teacherSet as { names: string[] }).names).toEqual([]);
    expect(aggregates.teacher).toBeUndefined();
    expect(aggregates.teachingClass).toBeUndefined();
    // The course roll-up is still a fact about the course, so it is reported — as a reference, not as this class's grade.
    expect((aggregates.course as GradeAggregate).meanGrade).toBe(64.2857);
    // And it was not copied into the candidate-specific slots.
    expect(aggregates.teacher).not.toEqual(aggregates.course);
  });
});

describe('16J-PREUI-D1 absent means absent', () => {
  it('E/F. no usable samples: count is 0 and the mean/median keys are missing, never 0 or null', async () => {
    const rec = await recommendOne(A, {
      reviews: [teacherReview(undefined, undefined, 0, {})],
      provider: 'stub', fromCache: false, warnings: [],
      courseLevel: levelReview('course', undefined, undefined, 0, {}),
    });
    const aggregates = aggregatesOf(rec);
    for (const key of ['teacher', 'course'] as const) {
      const aggregate = aggregates[key] as GradeAggregate | undefined;
      expect(aggregate, key).toBeDefined();
      expect(aggregate?.gradedSampleCount, key).toBe(0);
      // The keys are ABSENT: a course with no published grades has no average, and 0 would read as "everyone failed".
      expect(Object.hasOwn(aggregate as object, 'meanGrade'), key).toBe(false);
      expect(Object.hasOwn(aggregate as object, 'medianGrade'), key).toBe(false);
      expect(aggregate?.meanGrade, key).toBeUndefined();
      expect(JSON.stringify(aggregate), key).not.toContain('null');
    }
  });

  it('F2. a mean without a median keeps the one it has', async () => {
    const rec = await recommendOne(A, {
      reviews: [teacherReview(88, undefined, 3, { '80': 3 })],
      provider: 'stub', fromCache: false, warnings: [],
      courseLevel: levelReview('course', undefined, 70, 3, {}),
    });
    const aggregates = aggregatesOf(rec);
    const teacher = aggregates.teacher as GradeAggregate;
    expect(teacher.meanGrade).toBe(88);
    expect(Object.hasOwn(teacher, 'medianGrade')).toBe(false);
    const course = aggregates.course as GradeAggregate;
    expect(Object.hasOwn(course, 'meanGrade')).toBe(false);
    expect(course.medianGrade).toBe(70);
  });
});

describe('16J-PREUI-D1 projection is presentation-only', () => {
  it('G. score, riskAdjustedScore, confidence and rank are untouched by the aggregates', async () => {
    const response = {
      reviews: [teacherReview(90, 90, 2, { '90': 2 })],
      provider: 'stub', fromCache: false, warnings: [],
      courseLevel: levelReview('course', 80, 80, 4, {}),
      teachingClassLevel: levelReview('teachingClass', 90, 90, 2, {}),
    };
    const rec = await recommendOne(A, response);
    /*
     * The same run with the aggregates made unavailable must produce byte-identical ranking fields. `null` is used deliberately: the
     * projection must tolerate a provider that published no roll-ups at all, which is the pre-existing shape.
     */
    const bare = await recommendOne(A, { reviews: [teacherReview(90, 90, 2, { '90': 2 })], provider: 'stub', fromCache: false, warnings: [] });
    const pick = (value: Record<string, unknown>): unknown => ({
      score: value.score, riskAdjustedScore: value.riskAdjustedScore, rank: value.rank,
      confidence: value.confidence, reasons: value.reasons, topAspects: value.topAspects,
    });
    expect(pick(rec)).toEqual(pick(bare));
    // The bare run simply has fewer scopes, not different numbers.
    expect(aggregatesOf(rec).course).toBeDefined();
    expect(aggregatesOf(bare).course).toBeUndefined();
    expect((aggregatesOf(bare).teacher as GradeAggregate).meanGrade).toBe(90);
  });

  it('H. survives a JSON round trip with nothing lost', async () => {
    const rec = await recommendOne(JOINT, {
      reviews: [teacherReview(70, 70, 3, {})],
      provider: 'stub', fromCache: false, warnings: [],
      courseLevel: levelReview('course', 64.2857, 70, 7, { '20': 1, '90': 1 }),
      teachingClassLevel: levelReview('teachingClass', 80, 80, 5, { '60': 1, '90': 1 }),
    });
    const before = aggregatesOf(rec);
    const after = JSON.parse(JSON.stringify(before)) as Record<string, unknown>;
    expect(after).toEqual(before);
    // Plain JSON shapes only: no Map, Set, Date, class instance, function or symbol.
    const serialized = JSON.stringify(before);
    expect(serialized).not.toContain('undefined');
    for (const value of Object.values(before)) {
      expect(['object']).toContain(typeof value);
    }
    expect((after.teacherSet as { names: string[] }).names).toEqual([NORMALIZED_A, NORMALIZED_B]);
  });

  it('I. the raw teacher cell is still on course.teacher, untouched', async () => {
    const rec = await recommendOne(JOINT, {
      reviews: [teacherReview(70, 70, 3, {})],
      provider: 'stub', fromCache: false, warnings: [],
      courseLevel: levelReview('course', 64.2857, 70, 7, {}),
    });
    // The display string keeps the separator exactly as the page published it, while the set carries the parsed names.
    expect((rec.course as Record<string, unknown>).teacher).toBe(JOINT);
    expect((aggregatesOf(rec).teacherSet as { names: string[] }).names).toEqual([NORMALIZED_A, NORMALIZED_B]);
    expect((aggregatesOf(rec).teacherSet as { names: string[] }).names).not.toContain(JOINT);
  });
});

describe('16J-PREUI-D1 the other list carries the same aggregates since A11', () => {
  it('J. ratedButNotRecommended is NOT a Recommendation, and since A11 DOES carry grade aggregates', async () => {
    /*
     * UPDATED IN PRE-RELEASE-UX-A11, which completes a deferral this case used to record.
     *
     * It previously asserted that a rated entry carried `course`, `rank`, `score`, `reviewContext` and `sectionHydration` ONLY, and the reason recorded was honest:
     * adding `gradeAggregates` would be a second projection to keep in step, and the step that added the first one deliberately did not widen that contract. A11
     * widens it — a reader could see a self-reported average on a recommended card and not on a rated one, which made the figure look like a property of being
     * recommended rather than a property of the course.
     *
     * The "second projection" worry is answered rather than ignored: both paths call ONE `describeGradeAggregates` from the same lookup result, so there are not two
     * projections to keep in step, and this case now proves the two entries agree for the SAME evidence.
     */
    const rec = await recommendOne(A, {
      reviews: [teacherReview(90, 90, 2, {})],
      provider: 'stub', fromCache: false, warnings: [],
      courseLevel: levelReview('course', 80, 80, 4, {}),
    });
    // The recommended entry has them; the type is what differs, and that is asserted by the compiler plus this shape check.
    expect(Object.keys(aggregatesOf(rec)).length).toBeGreaterThan(0);
    /*
     * Two courses that both score, with `topN = 1`: exactly one is recommended and the other lands in `ratedButNotRecommended`, so both paths are exercised on
     * identical evidence.
     */
    const scored = (courseName: string): Record<string, unknown> => ({
      reviews: [{ ...teacherReview(90, 90, 2, {}), courseName, normalizedName: courseName }],
      provider: 'stub', fromCache: false, warnings: [],
      courseLevel: { ...levelReview('course', 80, 80, 4, {}), courseName, normalizedName: courseName },
    });
    const result = await recommendCourses(
      [
        { source: 'whu', courseName: NAME, normalizedName: NAME, availability: 'unknown', teacher: A } as never,
        { source: 'whu', courseName: '\u5927\u5b66\u7269\u7406', normalizedName: '\u5927\u5b66\u7269\u7406', availability: 'unknown', teacher: A } as never,
      ],
      {},
      {
        providers: [{
          searchCourse: async (query: { courseName: string }) => scored(query.courseName),
        } as never],
        policy: { ...(POLICY as object), defaultTopN: 1 } as never,
      },
    );
    expect(result.recommendations).toHaveLength(1);
    expect(result.ratedButNotRecommended.length).toBeGreaterThan(0);
    for (const entry of result.ratedButNotRecommended) {
      // Present, and the SAME canonical shape the recommendation path publishes — not a flattened second number.
      expect(Object.hasOwn(entry as object, 'gradeAggregates')).toBe(true);
      /*
       * UPDATED IN PRE-RELEASE-UX-A16: `reviewExcerpts` joined the shape. The exact key set is kept rather than loosened, because
       * this case exists to prove a rated entry carries the SAME presentation fields a recommended one does and nothing else.
       */
      expect(Object.keys(entry).sort()).toEqual(['course', 'gradeAggregates', 'rank', 'reviewContext', 'reviewExcerpts', 'score', 'sectionHydration']);
      const aggregates = (entry as unknown as { gradeAggregates: Record<string, unknown> }).gradeAggregates;
      expect((aggregates.teacherSet as { names: string[] }).names).toEqual([NORMALIZED_A]);
      // A single-teacher class gets its teacher aggregate, exactly as the recommended path does.
      expect((aggregates.teacher as { meanGrade?: number }).meanGrade).toBe(90);
      // And the whole-course figure stays separate, as a reference.
      expect((aggregates.course as { meanGrade?: number }).meanGrade).toBe(80);
    }
  });
});

/*
 * ============================================================================================================================
 * PRE-RELEASE-UX-A11 — the same aggregates on the RATED list
 * ============================================================================================================================
 *
 * The recommended path already published these figures. A rated course did not, which made a self-reported average look like a property of being recommended
 * rather than a property of the course. These cases assert that both lists are described by ONE projection, and that widening the rated entry changed nothing
 * about why any course is where it is.
 */
describe('PRE-RELEASE-UX-A11 a rated course is described by the SAME aggregation as a recommended one', () => {
  it('A. equivalent evidence yields equivalent aggregates on both lists', async () => {
    const { recommended, rated } = await recommendPair(A, A, (name) => sameEvidence(90, 80, 4, name));
    const recommendedAggregates = aggregatesOf(recommended);
    const ratedAggregates = aggregatesOf(rated);

    /*
     * Compared field by field rather than by JSON equality, because the two entries describe DIFFERENT courses: `sameEvidence` deliberately gives each the same
     * numbers, so every grade figure must match while the teacher sets are compared by content.
     */
    expect((ratedAggregates.teacherSet as { names: string[] }).names).toEqual((recommendedAggregates.teacherSet as { names: string[] }).names);
    expect((ratedAggregates.teacher as GradeAggregate).meanGrade).toBe((recommendedAggregates.teacher as GradeAggregate).meanGrade);
    expect((ratedAggregates.teacher as GradeAggregate).gradedSampleCount).toBe((recommendedAggregates.teacher as GradeAggregate).gradedSampleCount);
    expect((ratedAggregates.course as GradeAggregate).meanGrade).toBe((recommendedAggregates.course as GradeAggregate).meanGrade);
    // The KEY SETS match too, so neither list publishes a scope the other omits.
    expect(Object.keys(ratedAggregates).sort()).toEqual(Object.keys(recommendedAggregates).sort());
  });

  it('B. a single-teacher rated course keeps the teacher aggregate', async () => {
    const { rated } = await recommendPair(A, A, (name) => sameEvidence(88, 70, 3, name));
    const aggregates = aggregatesOf(rated);
    expect((aggregates.teacherSet as { names: string[] }).names).toEqual([NORMALIZED_A]);
    expect((aggregates.teacher as GradeAggregate).meanGrade).toBe(88);
    expect((aggregates.teacher as GradeAggregate).gradedSampleCount).toBe(3);
  });

  it('C. a co-taught rated course keeps the teaching-class aggregate and still publishes no single teacher', async () => {
    const { rated } = await recommendPair(JOINT, JOINT, (name) => ({
      reviews: [{ ...teacherReview(70, 70, 3, { '90': 1, '60': 1, '80': 1 }), courseName: name, normalizedName: name }],
      provider: 'stub', fromCache: false, warnings: [],
      courseLevel: { ...levelReview('course', 64.2857, 70, 7, { '20': 1, '30': 1, '60': 1, '70': 1, '80': 1, '90': 1, '100': 1 }), courseName: name, normalizedName: name },
      teachingClassLevel: { ...levelReview('teachingClass', 80, 80, 5, { '60': 1, '70': 1, '80': 1, '90': 1, '100': 1 }), courseName: name, normalizedName: name },
    }));
    const aggregates = aggregatesOf(rated);
    expect((aggregates.teacherSet as { names: string[] }).names).toEqual([NORMALIZED_A, NORMALIZED_B]);
    // One co-teacher's bucket must not be published as "the teacher aggregate" on this list either.
    expect(aggregates.teacher).toBeUndefined();
    expect((aggregates.teachingClass as GradeAggregate).meanGrade).toBe(80);
    expect((aggregates.teachingClass as GradeAggregate).gradedSampleCount).toBe(5);
  });

  it('D. the whole-course aggregate stays a SEPARATE reference on the rated list', async () => {
    // 5 class samples at 80 versus 7 course samples at 64.2857: the two must not be merged, and course must not stand in for the class.
    const { rated } = await recommendPair(JOINT, JOINT, (name) => ({
      reviews: [{ ...teacherReview(70, 70, 3, { '90': 1, '60': 1, '80': 1 }), courseName: name, normalizedName: name }],
      provider: 'stub', fromCache: false, warnings: [],
      courseLevel: { ...levelReview('course', 64.2857, 70, 7, { '20': 1, '30': 1, '60': 1, '70': 1, '80': 1, '90': 1, '100': 1 }), courseName: name, normalizedName: name },
      teachingClassLevel: { ...levelReview('teachingClass', 80, 80, 5, { '60': 1, '70': 1, '80': 1, '90': 1, '100': 1 }), courseName: name, normalizedName: name },
    }));
    const aggregates = aggregatesOf(rated);
    const teachingClass = aggregates.teachingClass as GradeAggregate;
    const course = aggregates.course as GradeAggregate;
    expect(teachingClass.meanGrade).toBe(80);
    expect(course.meanGrade).toBe(64.2857);
    expect(teachingClass.meanGrade).not.toBe(course.meanGrade);
    expect(teachingClass.gradedSampleCount).toBe(5);
    expect(course.gradedSampleCount).toBe(7);
  });

  it('E. zero usable samples on the rated list does NOT become mean 0', async () => {
    const { rated } = await recommendPair(A, A, (name) => ({
      reviews: [{ ...teacherReview(undefined, undefined, 0, {}), courseName: name, normalizedName: name }],
      provider: 'stub', fromCache: false, warnings: [],
      courseLevel: { ...levelReview('course', undefined, undefined, 0, {}), courseName: name, normalizedName: name },
    }));
    const aggregates = aggregatesOf(rated);
    for (const key of ['teacher', 'course'] as const) {
      const aggregate = aggregates[key] as GradeAggregate | undefined;
      expect(aggregate, key).toBeDefined();
      expect(aggregate?.gradedSampleCount, key).toBe(0);
      // ABSENT, not 0 and not null: a course with no published grades has no average, and 0 would read as "everyone failed".
      expect(Object.hasOwn(aggregate as object, 'meanGrade'), key).toBe(false);
      expect(aggregate?.meanGrade, key).toBeUndefined();
      expect(JSON.stringify(aggregate), key).not.toContain('null');
    }
  });

  it('F. a rated course whose teacher the page never published gets NO candidate-specific aggregate', async () => {
    const { rated } = await recommendPair(undefined, undefined, (name) => sameEvidence(90, 80, 4, name));
    const aggregates = aggregatesOf(rated);
    expect((aggregates.teacherSet as { names: string[] }).names).toEqual([]);
    // No teacher named, so there is no candidate-specific figure — never the course roll-up standing in for one.
    expect(aggregates.teacher).toBeUndefined();
    expect(aggregates.teachingClass).toBeUndefined();
    // The course figure remains, and remains a reference.
    expect((aggregates.course as GradeAggregate).meanGrade).toBe(80);
  });

  it('G. the widening changed no rank, no score and no membership', async () => {
    /*
     * The property that makes this slice safe. Because `gradeAggregates` is written AFTER an entry has been placed, it cannot influence placement — and this
     * asserts that by comparing two runs that differ only in whether the provider published any grades at all. The SAME courses must rank the same way.
     */
    const withGrades = await recommendPair(A, A, (name) => sameEvidence(90, 80, 4, name));
    const withoutGrades = await recommendPair(A, A, (name) => ({
      reviews: [{ ...teacherReview(undefined, undefined, 0, {}), courseName: name, normalizedName: name }],
      provider: 'stub', fromCache: false, warnings: [],
      courseLevel: { ...levelReview('course', undefined, undefined, 0, {}), courseName: name, normalizedName: name },
    }));

    expect((withGrades.recommended as { rank: number }).rank).toBe((withoutGrades.recommended as { rank: number }).rank);
    expect((withGrades.rated as { rank: number }).rank).toBe((withoutGrades.rated as { rank: number }).rank);
    expect((withGrades.recommended as { score: number }).score).toBe((withoutGrades.recommended as { score: number }).score);
    expect((withGrades.rated as { score: number }).score).toBe((withoutGrades.rated as { score: number }).score);
    // And the same course is on the same list in both runs.
    expect((withGrades.recommended as { course: { courseName: string } }).course.courseName)
      .toBe((withoutGrades.recommended as { course: { courseName: string } }).course.courseName);
    expect((withGrades.rated as { course: { courseName: string } }).course.courseName)
      .toBe((withoutGrades.rated as { course: { courseName: string } }).course.courseName);
  });
});
