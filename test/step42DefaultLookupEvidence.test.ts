/**
 * PART 16I-G-R3 — `defaultLookup` preserves structured evidence from ONE provider, and withholds it from several.
 *
 * ## The rule this file locks
 *
 * `ReviewSearchResult` carries three aggregates beside its rows: `courseLevel`, `teachingClassLevel` and `courseSupplementary`.
 * `calculateReviewConfidence` reads the first two, so dropping them silently degrades every recommendation to the bucket-only
 * fallback. This test file pins both halves of the rule:
 *
 * - ONE provider: the aggregates describe exactly the rows returned, so they pass through.
 * - SEVERAL providers: `reviews` is concatenated across sources, so publishing any single provider's aggregate would attach a
 *   one-source count to a multi-source corpus. `dataHygiene` divides by `courseLevel.courseReviewCount`, so that mismatch is a
 *   ratio whose numerator and denominator come from different rows. The aggregates are therefore ABSENT — not merged, not first,
 *   not last, and no canonical provider is assumed.
 *
 * These tests call `defaultLookup` directly, which is what makes them independent of whether any later stage happens to attach the
 * values to a `MatchResult`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultLookup } from '@course-copilot/recommendation';
import type { CourseLevelReview, CourseReview } from '@course-copilot/core/course';
import type { ReviewProvider, ReviewSearchResult } from '@course-copilot/provider';
import { courseLevelAsReview } from '@course-copilot/provider';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A minimal review row, enough for the merge assertions. */
function row(teacher: string, grade: number): CourseReview {
  return {
    provider: 'fake',
    courseName: 'COURSE',
    normalizedName: 'COURSE',
    teacher,
    normalizedTeacher: teacher,
    reviewCount: 1,
    gradedSampleCount: 1,
    reportedGrade: grade,
  } as unknown as CourseReview;
}

/** A distinguishable aggregate per scope, so a mixed-up field is visible rather than silently accepted. */
function level(scope: string, count: number): CourseLevelReview {
  return { scope, courseReviewCount: count } as unknown as CourseLevelReview;
}

interface FakeOptions {
  readonly id: string;
  readonly reviews: CourseReview[];
  readonly courseLevel?: CourseLevelReview;
  readonly teachingClassLevel?: CourseLevelReview;
  readonly courseSupplementary?: CourseLevelReview;
  readonly fromCache?: boolean;
  readonly warnings?: string[];
  readonly fail?: string;
}

/** A provider returning a fixed answer, so the merge rule is the only thing under test. */
function fake(options: FakeOptions): ReviewProvider {
  return {
    id: options.id,
    label: options.id,
    homepage: 'https://example.invalid',
    isAvailable: async () => true,
    searchCourse: async (): Promise<ReviewSearchResult> => {
      if (options.fail !== undefined) throw new Error(options.fail);
      return {
        reviews: options.reviews,
        provider: options.id,
        fromCache: options.fromCache ?? false,
        warnings: options.warnings ?? [],
        ...(options.courseLevel === undefined ? {} : { courseLevel: options.courseLevel }),
        ...(options.teachingClassLevel === undefined ? {} : { teachingClassLevel: options.teachingClassLevel }),
        ...(options.courseSupplementary === undefined ? {} : { courseSupplementary: options.courseSupplementary }),
      };
    },
  };
}

const QUERY = { courseName: 'COURSE' };

describe('16I-G-R3 single provider: structured evidence passes through unchanged', () => {
  it('preserves all three aggregates, by identity', async () => {
    const courseLevel = level('course', 9);
    const teachingClassLevel = level('teachingClass', 3);
    const courseSupplementary = level('supplementary', 4);
    const lookup = defaultLookup([fake({ id: 'a', reviews: [row('T', 90)], courseLevel, teachingClassLevel, courseSupplementary })], 25);

    const result = await lookup(QUERY);

    // Identity, not equality: the value must be the provider's own object, not a copy that could drift.
    expect(result.courseLevel).toBe(courseLevel);
    expect(result.teachingClassLevel).toBe(teachingClassLevel);
    expect(result.courseSupplementary).toBe(courseSupplementary);
    // And the existing per-query behaviour is untouched.
    expect(result.reviews).toHaveLength(1);
    expect(result.provider).toBe('a');
    expect(result.fromCache).toBe(false);
  });

  it('omits each aggregate the provider did not produce, rather than inventing one', async () => {
    const withOnlyCourse = defaultLookup([fake({ id: 'a', reviews: [row('T', 90)], courseLevel: level('course', 9) })], 25);
    const result = await withOnlyCourse(QUERY);
    expect(result.courseLevel).toBeDefined();
    expect(result.teachingClassLevel).toBeUndefined();
    expect(result.courseSupplementary).toBeUndefined();
    // Absent, not present-and-undefined: the keys must not be enumerated.
    expect(Object.keys(result).includes('teachingClassLevel')).toBe(false);
    expect(Object.keys(result).includes('courseSupplementary')).toBe(false);
  });

  it('passes through the provider\'s own rows, cache flag and warnings unchanged', async () => {
    const lookup = defaultLookup([fake({ id: 'a', reviews: [row('T1', 90), row('T2', 80)], fromCache: true, warnings: ['w'] })], 25);
    const result = await lookup(QUERY);
    expect(result.reviews.map((r) => r.teacher)).toEqual(['T1', 'T2']);
    expect(result.fromCache).toBe(true);
    expect(result.warnings).toEqual(['w']);
  });
});

describe('16I-G-R3 several providers: rows merge, structured evidence is withheld', () => {
  it('concatenates reviews but publishes NO aggregate from either source', async () => {
    /*
     * The safety property. Both providers supply complete aggregates; neither may be published, because the corpus is now the
     * UNION of two sources and a one-source count cannot describe it.
     */
    const providerA = fake({
      id: 'a',
      reviews: [row('A1', 90), row('A2', 85)],
      courseLevel: level('course', 9),
      teachingClassLevel: level('teachingClass', 3),
      courseSupplementary: level('supplementary', 4),
    });
    const providerB = fake({
      id: 'b',
      reviews: [row('B1', 70)],
      courseLevel: level('course', 100),
      teachingClassLevel: level('teachingClass', 50),
      courseSupplementary: level('supplementary', 40),
    });

    const result = await defaultLookup([providerA, providerB], 25)(QUERY);

    // Rows and provenance still merge exactly as before.
    expect(result.reviews.map((r) => r.teacher)).toEqual(['A1', 'A2', 'B1']);
    expect(result.provider).toBe('a+b');
    // Not first, not last, not merged, not summed — absent.
    expect(result.courseLevel).toBeUndefined();
    expect(result.teachingClassLevel).toBeUndefined();
    expect(result.courseSupplementary).toBeUndefined();
    expect(Object.keys(result).includes('courseLevel')).toBe(false);
    expect(Object.keys(result).includes('teachingClassLevel')).toBe(false);
    expect(Object.keys(result).includes('courseSupplementary')).toBe(false);
  });

  it('withholds aggregates even when only ONE of the two providers supplies them', async () => {
    // The tempting case for a "first non-undefined wins" rule, and the one it would get wrong: the surviving aggregate would be a
    // count over provider A's rows while the corpus also contains provider B's.
    const providerA = fake({ id: 'a', reviews: [row('A1', 90)], courseLevel: level('course', 9), teachingClassLevel: level('teachingClass', 3) });
    const providerB = fake({ id: 'b', reviews: [row('B1', 70)] });

    const result = await defaultLookup([providerA, providerB], 25)(QUERY);
    expect(result.reviews).toHaveLength(2);
    expect(result.courseLevel).toBeUndefined();
    expect(result.teachingClassLevel).toBeUndefined();
  });

  it('withholds them in either provider order, so the rule is not accidental', async () => {
    const a = fake({ id: 'a', reviews: [row('A1', 90)], courseLevel: level('course', 9) });
    const b = fake({ id: 'b', reviews: [row('B1', 70)], courseLevel: level('course', 100) });
    for (const providers of [[a, b], [b, a]]) {
      const result = await defaultLookup(providers, 25)(QUERY);
      expect(result.courseLevel).toBeUndefined();
      expect(result.reviews).toHaveLength(2);
    }
  });

  it('an empty provider list is not a single source', async () => {
    // `[]` must not be treated as "one provider that produced nothing": there is no source at all.
    const result = await defaultLookup([], 25)(QUERY);
    expect(result.reviews).toEqual([]);
    expect(result.courseLevel).toBeUndefined();
    expect(result.teachingClassLevel).toBeUndefined();
  });

  it('a failing provider contributes a warning and does not resurrect the rule as single-source', async () => {
    const ok = fake({ id: 'a', reviews: [row('A1', 90)], courseLevel: level('course', 9) });
    const broken = fake({ id: 'b', reviews: [], fail: 'network down' });
    const result = await defaultLookup([ok, broken], 25)(QUERY);
    expect(result.warnings.some((w) => w.includes('network down'))).toBe(true);
    // Two providers were registered, so the corpus is still multi-source and no aggregate may be published.
    expect(result.courseLevel).toBeUndefined();
  });
});

describe('16I-G-R3 the scope of this change', () => {
  const enginePath = 'packages/recommendation/src/recommend.ts';

  it('changed defaultLookup only, inside the recommendation package', () => {
    /*
     * A source-level freeze. `lookupReviews` has its own, separate gap — it never lifts `courseSupplementary` to the result — and
     * that is deliberately NOT repaired here, because the recommendation path does not consume supplementary and touching a second
     * entry point would widen a fix whose whole value is that it is narrow.
     */
    const source = readFileSync(join(repoRoot, enginePath), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

    // defaultLookup reads all three fields.
    for (const field of ['result.courseLevel', 'result.teachingClassLevel', 'result.courseSupplementary']) {
      expect(code.includes(field), field).toBe(true);
    }
    // The single-source guard is explicit.
    expect(code.includes('providers.length === 1')).toBe(true);
    /*
     * No cross-provider guess may exist. The patterns name the GUESSES specifically: reading a provider by position, or picking a
     * canonical one. An assertion against the `??` operator would be wrong here — the implementation legitimately uses a nullish
     * check inside its own optional spread to keep the key ABSENT rather than present-and-undefined.
     */
    for (const forbidden of ['[0].courseLevel', '[0].teachingClassLevel', 'providers[0]', 'find((provider', 'canonical']) {
      expect(code.includes(forbidden), forbidden).toBe(false);
    }
    /*
     * And the three assignments sit INSIDE the `providers.length === 1` branch, so the rule is structural rather than a comment.
     * Slicing from the guard to the end of the loop body is what makes that checkable.
     */
    const guardIndex = code.indexOf('if (providers.length === 1)');
    const loopEnd = code.indexOf('return {', guardIndex);
    const guarded = code.slice(guardIndex, loopEnd);
    for (const field of ['courseLevel = result.courseLevel', 'teachingClassLevel = result.teachingClassLevel', 'courseSupplementary = result.courseSupplementary']) {
      expect(guarded.includes(field), `inside the single-source guard: ${field}`).toBe(true);
    }
    /*
     * `lookupReviews` must be untouched by this step — and "untouched" has to mean the whole region, not just its writes.
     *
     * The first version of this check only forbade `result.courseSupplementary =`, which is what the step would have added.
     * Measured: a compile-valid mutation that merely READS `found.courseSupplementary` inside this function slipped past it, and
     * a read is still a change — it widens what the second entry point knows about. The region is now asserted to mention the
     * supplementary aggregate at all, which is the honest statement of the scope.
     */
    const lookupStart = code.indexOf('export async function lookupReviews');
    const lookupEnd = code.indexOf('export function syntheticCourse');
    expect(lookupStart).toBeGreaterThan(0);
    expect(lookupEnd).toBeGreaterThan(lookupStart);
    const lookupSection = code.slice(lookupStart, lookupEnd);
    // The two fields this path legitimately lifts are still there, so the region really is the function under audit.
    expect(lookupSection.includes('result.courseLevel =')).toBe(true);
    expect(lookupSection.includes('result.teachingClassLevel =')).toBe(true);
    // And the supplementary aggregate appears NOWHERE in it — not published, not read, not aliased.
    expect(lookupSection.includes('courseSupplementary'), 'lookupReviews changed outside R3 scope').toBe(false);
  });

  it('left the provider and the algorithm untouched', () => {
    // The provider still produces all three; the engine is the only side that changed.
    const providerSource = readFileSync(join(repoRoot, 'packages/provider/src/whucourses.ts'), 'utf8');
    expect(providerSource.includes('result.courseLevel = courseLevel;')).toBe(true);
    expect(providerSource.includes('result.teachingClassLevel = teachingClassLevel;')).toBe(true);
    expect(providerSource.includes('result.courseSupplementary = courseSupplementary;')).toBe(true);
    // `courseLevelAsReview` is re-exported by the provider, which the fake above relies on for a real aggregate value.
    expect(typeof courseLevelAsReview).toBe('function');
  });
});
