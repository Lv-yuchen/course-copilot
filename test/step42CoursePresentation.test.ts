/**
 * PART 16J-PREUI-E4-C2-B3-B1 — the frozen course-card presentation contract.
 *
 * ## What this proves
 *
 * Three result kinds with three different canonical shapes must stay three different presentations. The assertions therefore concentrate on the places where a
 * single unified card would have to invent something: a default confidence, an empty evidence list, a zero score, a synthesised overall evidence level, a
 * candidate-specific grade average for a course whose teacher the page never published — and, above all, the page's own teacher text, which is opaque and must
 * survive verbatim.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COURSE_STATUS_TEXT,
  GRADE_DISCLAIMER,
  TEACHER_NOT_PUBLISHED_TEXT,
  teacherText,
  toInsufficientCoursePresentation,
  toRatedCoursePresentation,
  toRecommendedCoursePresentation,
} from '../apps/extension/src/sidepanel/course-presentation.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mapperPath = join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'course-presentation.ts');
const mapperSource = readFileSync(mapperPath, 'utf8');
const mapperCode = mapperSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

/** A canonical course, with the given overrides. */
function course(overrides: Record<string, unknown> = {}): never {
  return {
    source: 'whu',
    courseName: '(2024-2025-1)-MATH101-01 高等数学',
    normalizedName: '高等数学',
    teacher: '周奕华',
    credits: 2,
    remainingSeats: 12,
    availability: 'available',
    ...overrides,
  } as never;
}

/** A canonical review context. */
function reviewContext(overrides: Record<string, unknown> = {}): never {
  return {
    scope: 'teacher',
    reviewCount: 17,
    teacherSpecified: true,
    teacher: '周奕华',
    teacherMatchConfidence: 0.9,
    aggregationNote: '这些数字描述该教师。',
    ...overrides,
  } as never;
}

/** A canonical section hydration. */
function sectionHydration(overrides: Record<string, unknown> = {}): never {
  return {
    status: 'full',
    available: ['teacher', 'schedule', 'location'],
    missing: ['department', 'capacity'],
    rawHydrated: true,
    ...overrides,
  } as never;
}

/**
 * A canonical rated-but-not-recommended entry.
 *
 * PRE-RELEASE-UX-A11 gave this entry `gradeAggregates`, and the rated mapper now reads them, so a fixture without the field fails rather than rendering nothing.
 * One helper keeps every rated fixture in this file honest about the shape the engine actually publishes.
 */
function ratedEntry(overrides: Record<string, unknown> = {}): never {
  return {
    course: course(),
    rank: 2,
    score: 6.1,
    reviewContext: reviewContext(),
    sectionHydration: sectionHydration(),
    gradeAggregates: { teacherSet: { names: ['周奕华'] }, teacher: grade(88.5, 12), course: grade(85.1, 254) },
    reviewExcerpts: [],
    ...overrides,
  } as never;
}

/** A canonical grade aggregate. */
function grade(meanGrade: number | undefined, gradedSampleCount: number): never {
  return { meanGrade, medianGrade: meanGrade, gradedSampleCount, gradeDistribution: {} } as never;
}

/** A canonical recommendation. */
function recommendation(overrides: Record<string, unknown> = {}): never {
  return {
    rank: 1,
    course: course(),
    reviewContext: reviewContext(),
    sectionHydration: sectionHydration(),
    gradeAggregates: {
      teacherSet: { names: ['周奕华'] },
      teacher: grade(88.5, 12),
      course: grade(85.1, 254),
    },
    reviewSource: { status: 'healthy', queries: 1, rows: 4, empty: 0, unavailable: 0 },
    reviewExcerpts: [],
    recommendationStatus: 'recommended',
    score: 8.42,
    confidence: { value: 0.71, tier: 'high', components: {}, missing: [] },
    reasons: ['给分友好'],
    warnings: [],
    match: { method: 'name_teacher', confidence: 0.95, trusted: true },
    aspects: { aspects: [], decisionScore: 8.42, appliedWeights: {}, missingDimensions: [], notes: [] },
    missingDimensions: [],
    topAspects: ['gradeFriendliness'],
    components: [],
    appliedWeights: {},
    redistributed: [],
    riskAdjustedScore: 7.6,
    effectiveWeights: {},
    defaultWeights: {},
    effectiveWeightNotes: [],
    evidenceStrength: [
      { aspect: 'gradeFriendliness', level: 'strong', reviewsWithEvidence: 14, corpusReviews: 17, coverage: 0.82, agreement: 0.9, note: '样本量与覆盖面都足够' },
      { aspect: 'attendanceFriendliness', level: 'limited', reviewsWithEvidence: 3, corpusReviews: 17, coverage: 0.18, agreement: 0.6, note: '样本或覆盖面偏少' },
    ],
    ...overrides,
  } as never;
}

describe('16J-PREUI-E4-C2-B3-B1 A and B. the page’s teacher text is opaque', () => {
  it('A. a multi-teacher string is returned byte-for-byte', () => {
    /*
     * The single most likely thing to get wrong. On the real page a co-taught course publishes several names in ONE field, so the `string` type says nothing about
     * how many teachers there are — and any transformation destroys text the user can check against the page.
     */
    const view = toRecommendedCoursePresentation(recommendation({ course: course({ teacher: '周奕华、刘兴海' }) }));
    // Narrowed once, so the assertions below read as the string comparisons they are.
    const teacher: string = view.teacher ?? '';
    expect(teacher).toBe('周奕华、刘兴海');
    // Not split, not truncated to the first name, not reordered.
    expect(teacher).not.toBe('周奕华');
    expect(teacher).not.toBe('刘兴海');
    expect(teacher).toContain('、');
    expect(teacher.split('、')).toHaveLength(2);
  });

  it('A2. the raw helper agrees, for every result kind', () => {
    expect(teacherText(course({ teacher: '甲、乙、丙' }) as never)).toBe('甲、乙、丙');
    // A comma-separated page spelling is equally opaque: the separator is page text, not a delimiter we own.
    expect(teacherText(course({ teacher: 'A, B' }) as never)).toBe('A, B');
  });

  it('B. a missing teacher says the page has not published one', () => {
    for (const missing of [undefined, null, '']) {
      const view = toRecommendedCoursePresentation(recommendation({ course: course({ teacher: missing }) }));
      expect(view.teacher, String(missing)).toBeNull();
      expect(view.teacherFallback).toBe(TEACHER_NOT_PUBLISHED_TEXT);
      // Never worded as an assertion that the course has none.
      expect(view.teacherFallback).not.toContain('无老师');
      expect(view.teacherFallback).not.toContain('没有教师');
      expect(view.teacherFallback).toContain('未提供');
    }
  });

  it('B2. the corpus teacher names never replace the page text', () => {
    /*
     * The review site indexes its own teacher set, which can legitimately differ from what the selection page published. Using it as the card's teacher would
     * show the user a name the page does not contain.
     */
    const view = toRecommendedCoursePresentation(recommendation({
      course: course({ teacher: undefined }),
      gradeAggregates: { teacherSet: { names: ['周奕华', '刘兴海'] }, teacher: grade(88.5, 12) },
    }));
    expect(view.teacher).toBeNull();
    expect(view.grade.teacherSetNames).toEqual(['周奕华', '刘兴海']);
    // Two separate fields, and the display one is empty.
    expect(view.teacher).not.toBe(view.grade.teacherSetNames.join('、'));
  });

  it('X. the teacher set survives as reference data with its own name', () => {
    const view = toRecommendedCoursePresentation(recommendation());
    expect(view.grade.teacherSetNames).toEqual(['周奕华']);
    // A copy, so a consumer cannot mutate the canonical array through the presentation.
    expect(view.grade.teacherSetNames).not.toBe((recommendation() as unknown as { gradeAggregates: { teacherSet: { names: string[] } } }).gradeAggregates.teacherSet.names);
  });
});

describe('16J-PREUI-E4-C2-B3-B1 C to F. score, confidence and evidence stay separate facts', () => {
  it('C. score and confidence are two independent fields', () => {
    const view = toRecommendedCoursePresentation(recommendation({ score: 8.42 }));
    expect(view.score).toBe(8.42);
    expect(view.confidence).toEqual({ value: 0.71, tier: 'high', tierText: '高' });
    // No combined field exists at all.
    for (const forbidden of ['combinedScore', 'scoreWithConfidence', 'adjustedScore', 'finalScore']) {
      expect(Object.hasOwn(view, forbidden), forbidden).toBe(false);
    }
  });

  it('C2. the risk-adjusted score is NOT exposed', () => {
    /*
     * The canonical field exists (`riskAdjustedScore: 7.6` in the fixture) and is deliberately not carried: presenting the shrunk number as the score would tell a
     * reader a well-evidenced mediocre course beats a thinly-evidenced excellent one.
     */
    const view = toRecommendedCoursePresentation(recommendation());
    expect(Object.hasOwn(view, 'riskAdjustedScore')).toBe(false);
    expect(JSON.stringify(view).includes('7.6')).toBe(false);
    expect(mapperCode.includes('riskAdjustedScore')).toBe(false);
  });

  it('C3. confidence is never recomputed from the score', () => {
    // Two courses with the SAME score and different canonical tiers must keep those tiers.
    const high = toRecommendedCoursePresentation(recommendation({ confidence: { value: 0.9, tier: 'high', components: {}, missing: [] } }));
    const low = toRecommendedCoursePresentation(recommendation({ confidence: { value: 0.1, tier: 'low', components: {}, missing: [] } }));
    expect(high.score).toBe(low.score);
    expect(high.confidence?.tierText).toBe('高');
    expect(low.confidence?.tierText).toBe('低');
  });

  it('D. every canonical tier maps to its own Chinese word', () => {
    const tierText = (tier: string): string | undefined => toRecommendedCoursePresentation(
      recommendation({ confidence: { value: 0.5, tier, components: {}, missing: [] } }),
    ).confidence?.tierText;
    expect(tierText('high')).toBe('高');
    expect(tierText('medium')).toBe('中');
    expect(tierText('low')).toBe('低');
    expect(new Set([tierText('high'), tierText('medium'), tierText('low')]).size).toBe(3);
  });

  it('E. every evidence level maps to its own Chinese word', () => {
    const levelText = (level: string): string => toRecommendedCoursePresentation(
      recommendation({ evidenceStrength: [{ aspect: 'gradeFriendliness', level, reviewsWithEvidence: 1, corpusReviews: 2, coverage: 0.5, agreement: 0.5, note: '' }] }),
    ).evidenceStrength[0]?.levelText ?? '';
    expect(levelText('strong')).toBe('充分');
    expect(levelText('moderate')).toBe('中等');
    expect(levelText('limited')).toBe('偏少');
    expect(levelText('none')).toBe('无');
  });

  it('F. evidence stays PER ASPECT, with no overall level synthesised', () => {
    const view = toRecommendedCoursePresentation(recommendation());
    expect(view.evidenceStrength.map((entry) => entry.aspect)).toEqual(['gradeFriendliness', 'attendanceFriendliness']);
    expect(view.evidenceStrength.map((entry) => entry.levelText)).toEqual(['充分', '偏少']);
    // Two different tiers are reported beside each other; nothing averages or minimises them.
    expect(Object.hasOwn(view, 'evidenceLevel')).toBe(false);
    expect(Object.hasOwn(view, 'overallEvidence')).toBe(false);
    expect(Object.hasOwn(view, 'evidenceSummary')).toBe(false);
    for (const synthesised of ['Math.min', 'Math.max', 'reduce(']) {
      expect(mapperCode.includes(synthesised), synthesised).toBe(false);
    }
    // Each entry keeps the canonical numbers behind its tier.
    expect(view.evidenceStrength[0]).toMatchObject({ reviewsWithEvidence: 14, corpusReviews: 17, note: '样本量与覆盖面都足够' });
  });
});

describe('16J-PREUI-E4-C2-B3-B1 G to K. page facts are carried, never defaulted', () => {
  it('G. credits are preserved', () => {
    expect(toRecommendedCoursePresentation(recommendation({ course: course({ credits: 2 }) })).credits).toBe(2);
    expect(toRecommendedCoursePresentation(recommendation({ course: course({ credits: 3.5 }) })).credits).toBe(3.5);
  });

  it('H. missing credits stay missing — never 0', () => {
    for (const missing of [undefined, null]) {
      const view = toRecommendedCoursePresentation(recommendation({ course: course({ credits: missing }) }));
      expect(view.credits, String(missing)).toBeNull();
      expect(view.credits, String(missing)).not.toBe(0);
    }
  });

  it('I. remainingSeats = 0 is a REAL value and survives as 0', () => {
    /*
     * The classic bug this guards against is `if (!remainingSeats)` treating a full course as an unknown one. `0` and "unknown" are different facts: one is a
     * course the user cannot get into, the other is a page that did not say.
     */
    const view = toRecommendedCoursePresentation(recommendation({ course: course({ remainingSeats: 0 }) }));
    expect(view.remainingSeats).toBe(0);
    expect(view.remainingSeats).not.toBeNull();
    expect(mapperCode).not.toContain('!remainingSeats');
    expect(mapperCode).not.toContain('!course.remainingSeats');
  });

  it('J. a missing seat count is null, and no competition is inferred', () => {
    const view = toRecommendedCoursePresentation(recommendation({ course: course({ remainingSeats: undefined }) }));
    expect(view.remainingSeats).toBeNull();
    for (const inferred of ['竞争', '概率', '录取', '选中']) {
      expect(JSON.stringify(view).includes(inferred), inferred).toBe(false);
    }
  });

  it('K. availability is carried as its own fact and never touches the score', () => {
    const available = toRecommendedCoursePresentation(recommendation({ course: course({ availability: 'available', remainingSeats: 200 }), score: 8.42 }));
    const full = toRecommendedCoursePresentation(recommendation({ course: course({ availability: 'full', remainingSeats: 0 }), score: 8.42 }));
    const unknown = toRecommendedCoursePresentation(recommendation({ course: course({ availability: 'unknown', remainingSeats: undefined }), score: 8.42 }));
    // The same score whatever the admission status: availability is not a ranking input.
    expect(available.score).toBe(8.42);
    expect(full.score).toBe(8.42);
    expect(unknown.score).toBe(8.42);
    expect([available.availability, full.availability, unknown.availability]).toEqual(['available', 'full', 'unknown']);
    // And a large seat count did not inflate anything.
    expect(available.score).toBe(full.score);
    expect(mapperCode.includes('availability *')).toBe(false);
  });
});

describe('16J-PREUI-E4-C2-B3-B1 L to Q. the grade figures follow the frozen scope rule', () => {
  it('L. a single-teacher candidate uses the TEACHER aggregate', () => {
    const view = toRecommendedCoursePresentation(recommendation({
      gradeAggregates: { teacherSet: { names: ['周奕华'] }, teacher: grade(88.5, 12), course: grade(85.1, 254) },
    }));
    expect(view.grade.primaryScope).toBe('teacher');
    expect(view.grade.primaryGrade?.meanGrade).toBe(88.5);
    // The course-wide figure is still available, clearly named as the whole-course one.
    expect(view.grade.courseGrade?.meanGrade).toBe(85.1);
    expect(view.grade.primaryGrade?.meanGrade).not.toBe(view.grade.courseGrade?.meanGrade);
  });

  it('M. a co-taught candidate uses the TEACHING-CLASS aggregate', () => {
    const view = toRecommendedCoursePresentation(recommendation({
      gradeAggregates: { teacherSet: { names: ['周奕华', '刘兴海'] }, teachingClass: grade(86.0, 30), course: grade(85.1, 254) },
    }));
    expect(view.grade.primaryScope).toBe('teachingClass');
    expect(view.grade.primaryGrade?.meanGrade).toBe(86.0);
  });

  it('N. a candidate with no published teacher gets NO candidate-specific average', () => {
    /*
     * With no teacher the class cannot be identified, so the whole-course average — which includes teachers outside this class — must not be presented as this
     * candidate's figure. `null` is the honest answer.
     */
    const view = toRecommendedCoursePresentation(recommendation({
      gradeAggregates: { teacherSet: { names: [] }, course: grade(85.1, 254) },
    }));
    expect(view.grade.primaryScope).toBeNull();
    expect(view.grade.primaryGrade).toBeNull();
    expect(view.grade.courseGrade?.meanGrade).toBe(85.1);
  });

  it('O. the course aggregate is reference only and is never promoted', () => {
    // Even when it is the ONLY aggregate, it does not become the primary figure.
    const view = toRecommendedCoursePresentation(recommendation({
      gradeAggregates: { teacherSet: { names: [] }, course: grade(85.1, 254) },
    }));
    expect(view.grade.primaryGrade).toBeNull();
    expect(view.grade.courseGrade).not.toBeNull();
  });

  it('P. the grade disclaimer is a fixed part of the model', () => {
    const view = toRecommendedCoursePresentation(recommendation());
    expect(view.grade.disclaimer).toBe(GRADE_DISCLAIMER);
    expect(GRADE_DISCLAIMER).toContain('不是武汉大学官方课程平均成绩');
    // Present whether or not a figure resolved, so a renderer cannot obtain a figure without the sentence.
    const noGrade = toRecommendedCoursePresentation(recommendation({ gradeAggregates: { teacherSet: { names: [] } } }));
    expect(noGrade.grade.disclaimer).toBe(GRADE_DISCLAIMER);
  });

  it('Q. a zero-sample aggregate never yields a mean', () => {
    /*
     * `gradedSampleCount: 0` means there is no average to show, and a renderer given `meanGrade: 0` would print "0 分" for a course that simply has no graded
     * reports. The figure is carried through as the canonical type states it — absent — and the sample count travels beside it so a renderer can tell.
     */
    const view = toRecommendedCoursePresentation(recommendation({
      gradeAggregates: { teacherSet: { names: ['周奕华'] }, teacher: grade(undefined, 0) },
    }));
    expect(view.grade.primaryGrade?.meanGrade).toBeUndefined();
    expect(view.grade.primaryGrade?.gradedSampleCount).toBe(0);
    // Nothing in the mapper invents a number.
    expect(mapperCode.includes('?? 0')).toBe(false);
    expect(mapperCode.includes('|| 0')).toBe(false);
  });
});

describe('16J-PREUI-E4-C2-B3-B1 R to W. the other two kinds do not borrow fields they lack', () => {
  it('R. a rated entry has no confidence, and none is fabricated', () => {
    const view = toRatedCoursePresentation(ratedEntry({ rank: 6, score: 5.9 }));
    expect(Object.hasOwn(view, 'confidence')).toBe(false);
    expect(view.score).toBe(5.9);
    expect(view.rank).toBe(6);
  });

  it('S. a rated entry has no evidence tiers, and DOES now carry grade aggregates', () => {
    /*
     * UPDATED IN PRE-RELEASE-UX-A11. The old assertion was `Object.hasOwn(view, 'grade') === false`, which was true while the canonical entry had no
     * `gradeAggregates` at all. A11 deliberately reverses that half — a rated course has the same self-reported grades a recommended one does — so the requirement
     * is now the opposite for grades and unchanged for evidence.
     *
     * What the reversal must NOT do is invent anything: the aggregates come from the entry, so an entry without them yields a presentation whose primary grade is
     * `null` rather than a fabricated figure.
     */
    const view = toRatedCoursePresentation(ratedEntry({ rank: 6, score: 5.9 }));
    // Evidence tiers are still absent: the canonical entry has none, and an empty array would read as "no evidence was found".
    expect(Object.hasOwn(view, 'evidenceStrength')).toBe(false);
    // Grades are present, from the entry's own aggregates, chosen by the same scope rule the recommended path uses.
    expect(Object.hasOwn(view, 'grade')).toBe(true);
    expect(view.grade.primaryScope).toBe('teacher');
    expect(view.grade.primaryGrade?.meanGrade).toBe(88.5);
    expect(JSON.stringify(view).includes('evidenceStrength')).toBe(false);

    // And an entry the provider produced no grades for is described as having none, not as having a zero.
    const withoutGrades = toRatedCoursePresentation(ratedEntry({ gradeAggregates: { teacherSet: { names: ['周奕华'] } } }));
    expect(withoutGrades.grade.primaryGrade).toBeNull();
    expect(withoutGrades.grade.courseGrade).toBeNull();
    expect(withoutGrades.grade.disclaimer).toBe(GRADE_DISCLAIMER);
  });

  it('T. a rated entry is not described as insufficient or as bad', () => {
    const view = toRatedCoursePresentation(ratedEntry({ rank: 6, score: 5.9 }));
    expect(view.statusText).toBe(COURSE_STATUS_TEXT.rated);
    expect(view.statusText).toBe('有评价，但未进入推荐结果');
    for (const forbidden of ['证据不足', '不推荐', '差', '低质量']) {
      expect(view.statusText.includes(forbidden), forbidden).toBe(false);
    }
    expect(view.statusText).not.toBe(COURSE_STATUS_TEXT.insufficient);
  });

  it('U. an insufficient entry has no score, and none is fabricated', () => {
    const view = toInsufficientCoursePresentation({
      course: course(), reason: '未找到可信评价匹配', match: { method: 'unmatched', confidence: 0 },
      reviewSource: { status: 'healthy', queries: 1, rows: 0, empty: 1, unavailable: 0 },
    } as never);
    expect(Object.hasOwn(view, 'score')).toBe(false);
    expect(JSON.stringify(view).includes('"score"')).toBe(false);
  });

  it('V. the insufficiency wording is an evidence problem, never a verdict', () => {
    const view = toInsufficientCoursePresentation({
      course: course(), reason: '未找到可信评价匹配', match: { method: 'unmatched', confidence: 0 },
      reviewSource: { status: 'healthy', queries: 1, rows: 0, empty: 1, unavailable: 0 },
    } as never);
    expect(view.statusText).toBe(COURSE_STATUS_TEXT.insufficient);
    expect(view.statusText).toContain('证据不足');
    for (const forbidden of ['不推荐', '课程不好', '低分', '质量差']) {
      expect(view.statusText.includes(forbidden), forbidden).toBe(false);
    }
    // The engine's own reason is carried verbatim beside it.
    expect(view.reason).toBe('未找到可信评价匹配');
  });

  it('W. match confidence is named as a MATCH fact, never as a recommendation confidence', () => {
    /*
     * This course was never scored, so there is no recommendation confidence to report. Carrying the matcher's number under a `match` name keeps the two from
     * being confused; a card that labelled it "置信度" would be describing a property the run does not have.
     */
    const view = toInsufficientCoursePresentation({
      course: course(), reason: '未找到可信评价匹配', match: { method: 'fuzzy_name', confidence: 0.42 },
      reviewSource: { status: 'healthy', queries: 1, rows: 0, empty: 1, unavailable: 0 },
    } as never);
    expect(view.match).toEqual({ method: 'fuzzy_name', confidence: 0.42 });
    expect(Object.hasOwn(view, 'confidence')).toBe(false);
    // And the canonical review-source status travels unchanged.
    expect(view.reviewSource.status).toBe('healthy');
  });

  it('the three kinds are structurally distinguishable, and say so', () => {
    const recommended = toRecommendedCoursePresentation(recommendation());
    const rated = toRatedCoursePresentation(ratedEntry());
    const insufficient = toInsufficientCoursePresentation({ course: course(), reason: 'r', match: { method: 'unmatched', confidence: 0 }, reviewSource: { status: 'unavailable', queries: 1, rows: 0, empty: 0, unavailable: 1 } } as never);
    expect([recommended.kind, rated.kind, insufficient.kind]).toEqual(['recommended', 'ratedButNotRecommended', 'insufficientData']);
    expect(new Set([recommended.kind, rated.kind, insufficient.kind]).size).toBe(3);
  });
});

describe('PRE-RELEASE-UX-A11 the rated model carries the same grade figures the recommended one does', () => {
  it('A. both kinds choose their primary grade by the SAME scope rule', () => {
    /*
     * A single-teacher class is described by its teacher aggregate and a co-taught one by its teaching-class aggregate — for a rated entry exactly as for a
     * recommended one. The rule lives in ONE function, so this compares the two kinds' answers rather than re-stating the rule.
     *
     * The aggregates are given DISTINCT numbers on purpose. An earlier version used the same figure for the teaching-class and teacher scopes, which meant a
     * projection that swapped the two would still have passed; each scope now carries its own value so a swap is a mismatch.
     */
    const single = { teacherSet: { names: ['周奕华'] }, teacher: grade(88.5, 12), course: grade(85.1, 254) };
    const joint = { teacherSet: { names: ['周奕华', '刘兴海'] }, teacher: grade(88.5, 12), teachingClass: grade(86.0, 30), course: grade(85.1, 254) };

    const ratedSingle = toRatedCoursePresentation(ratedEntry({ gradeAggregates: single }));
    const recommendedSingle = toRecommendedCoursePresentation(recommendation({ gradeAggregates: single }));
    expect(ratedSingle.grade.primaryScope).toBe('teacher');
    expect(ratedSingle.grade.primaryScope).toBe(recommendedSingle.grade.primaryScope);
    expect(ratedSingle.grade.primaryGrade?.meanGrade).toBe(88.5);
    expect(ratedSingle.grade.primaryGrade?.meanGrade).toBe(recommendedSingle.grade.primaryGrade?.meanGrade);

    /*
     * The co-taught case carries a `teacher` aggregate TOO, which is what a swapped projection would pick. The class figure is 86.0 and the teacher's is 88.5, so
     * choosing the wrong scope is a wrong number rather than a coincidentally equal one.
     */
    const ratedJoint = toRatedCoursePresentation(ratedEntry({ gradeAggregates: joint }));
    const recommendedJoint = toRecommendedCoursePresentation(recommendation({ gradeAggregates: joint }));
    expect(ratedJoint.grade.primaryScope).toBe('teachingClass');
    expect(ratedJoint.grade.primaryScope).toBe(recommendedJoint.grade.primaryScope);
    expect(ratedJoint.grade.primaryGrade?.meanGrade).toBe(86.0);
    expect(ratedJoint.grade.primaryGrade?.meanGrade).not.toBe(88.5);
    expect(ratedJoint.grade.primaryGrade?.gradedSampleCount).toBe(30);
  });

  it('B. the rated model exposes the sample count and the scope, as the recommended model does', () => {
    const view = toRatedCoursePresentation(ratedEntry({
      gradeAggregates: { teacherSet: { names: ['周奕华'] }, teacher: grade(88.5, 12), course: grade(85.1, 254) },
    }));
    // The sample count travels with the figure, so a reader can tell "12 reports" from "1 report".
    expect(view.grade.primaryGrade?.gradedSampleCount).toBe(12);
    // The scope is named, not inferred by the renderer.
    expect(view.grade.primaryScope).toBe('teacher');
    // The corpus's teacher names are carried for reference.
    expect(view.grade.teacherSetNames).toEqual(['周奕华']);
  });

  it('C. the whole-course figure stays a SEPARATE reference on the rated model', () => {
    const view = toRatedCoursePresentation(ratedEntry({
      gradeAggregates: { teacherSet: { names: ['周奕华', '刘兴海'] }, teachingClass: grade(86.0, 30), course: grade(85.1, 254) },
    }));
    expect(view.grade.primaryScope).toBe('teachingClass');
    expect(view.grade.courseGrade?.meanGrade).toBe(85.1);
    // Never the same figure: a course roll-up counted other teachers' cohorts.
    expect(view.grade.courseGrade?.meanGrade).not.toBe(view.grade.primaryGrade?.meanGrade);
    expect(view.grade.primaryGrade?.gradedSampleCount).toBe(30);
    expect(view.grade.courseGrade?.gradedSampleCount).toBe(254);
  });

  it('D. a missing aggregate is null, and a real mean of 0 survives', () => {
    /*
     * Two ways this could be lost, asserted separately. A missing aggregate must be `null` rather than a fabricated number; and a legitimate mean of `0` must
     * survive the mapper, which a truthiness test such as `mean || null` would silently destroy.
     */
    const missing = toRatedCoursePresentation(ratedEntry({ gradeAggregates: { teacherSet: { names: ['周奕华'] } } }));
    expect(missing.grade.primaryGrade).toBeNull();
    expect(missing.grade.courseGrade).toBeNull();
    // The disclaimer still accompanies the model, because a future card that renders a figure must carry it.
    expect(missing.grade.disclaimer).toBe(GRADE_DISCLAIMER);

    const zeroMean = toRatedCoursePresentation(ratedEntry({
      gradeAggregates: { teacherSet: { names: ['周奕华'] }, teacher: grade(0, 3) },
    }));
    expect(zeroMean.grade.primaryGrade?.meanGrade).toBe(0);
    expect(zeroMean.grade.primaryGrade?.meanGrade).not.toBeUndefined();
  });

  it('E. the rated model invents no confidence and no evidence tiers', () => {
    // The widening was for grades only. Nothing else may appear on the model.
    const view = toRatedCoursePresentation(ratedEntry());
    expect(Object.hasOwn(view, 'confidence')).toBe(false);
    expect(Object.hasOwn(view, 'evidenceStrength')).toBe(false);
    expect(view.statusText).toBe(COURSE_STATUS_TEXT.rated);
  });

  it('F. the frozen disclaimer is unchanged', () => {
    // A11 does not move or reword it; consolidation is the next slice's business.
    expect(GRADE_DISCLAIMER).toBe('学生评价中的自报成绩统计，不是武汉大学官方课程平均成绩');
    expect(GRADE_DISCLAIMER).toContain('学生评价');
    expect(GRADE_DISCLAIMER).toContain('不是武汉大学官方课程平均成绩');
    expect(toRatedCoursePresentation(ratedEntry()).grade.disclaimer).toBe(GRADE_DISCLAIMER);
  });
});

describe('16J-PREUI-E4-C2-B3-B1 the mapper is a pure function', () => {
  it('Y. it touches no DOM, no chrome API, no network and no engine', () => {
    for (const forbidden of ['document', 'window', 'chrome', 'sendMessage', 'fetch', 'XMLHttpRequest', 'MutationObserver', 'querySelector', 'localStorage']) {
      expect(mapperCode.includes(forbidden), forbidden).toBe(false);
    }
    // And it does not reach for the ranking engine or the provider.
    for (const forbidden of ['recommendExtensionCourses', 'recommendation-runtime', 'ReviewProvider', 'requestVisibleRecommendations']) {
      expect(mapperCode.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('Y2. every mapper returns a new object and never mutates its input', () => {
    const source = recommendation() as unknown as { reasons: string[]; gradeAggregates: { teacherSet: { names: string[] } } };
    const reasonsBefore = [...source.reasons];
    const namesBefore = [...source.gradeAggregates.teacherSet.names];
    const view = toRecommendedCoursePresentation(source as never);
    // Arrays are copied, so a consumer mutating a presentation cannot corrupt the canonical result.
    view.reasons.push('added');
    view.grade.teacherSetNames.push('added');
    expect(source.reasons).toEqual(reasonsBefore);
    expect(source.gradeAggregates.teacherSet.names).toEqual(namesBefore);
  });

  it('the mapper is still not consumed by the summary shell, and its own module is untouched', () => {
    /*
     * UPDATED IN 16J-PREUI-E4-C2-B3-B2. This used to assert that nothing in the panel imported the model, which held while no card was rendered. The card renderer
     * consumes it now — that is the next step — so the requirement becomes the one that still separates the two layers: the SUMMARY shell must not read courses at
     * all, and the model must still be a pure mapping with no transport.
     */
    const resultSource = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'recommendation-result.ts'), 'utf8');
    expect(resultSource.includes('course-presentation')).toBe(false);
    // The model itself is unchanged in kind: it maps, and it neither renders nor sends.
    expect(mapperCode.includes('createElement')).toBe(false);
    expect(mapperCode.includes('innerHTML')).toBe(false);
  });

  it('the mapper reads only canonical fields that exist', () => {
    /*
     * A field that does not exist on the canonical types would be a compile error, and this suite type-checks. What is asserted here is the narrower thing a type
     * cannot express: the mapper reads page facts from `course` and analysis facts from the recommendation, and never invents a page fact from analysis data.
     */
    const courseReads = [...mapperCode.matchAll(/course\.(\w+)/gu)].map((match) => match[1]);
    // UPDATED IN PRE-RELEASE-UX-A6: `selectedThisRound` joined the set, because the mapper now transports that second seat fact too. The list stays EXACT.
    expect([...new Set(courseReads)].sort()).toEqual(['availability', 'courseCode', 'courseName', 'credits', 'remainingSeats', 'selectedThisRound', 'teacher']);
  });
});
