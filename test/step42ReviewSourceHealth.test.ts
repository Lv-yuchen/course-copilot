/**
 * PART 16J-PREUI-D2 — review-source health.
 *
 * ## The statement this exists to prevent
 *
 * "No reviews found" and "the review site could not be reached" used to produce an identical result object. Telling a user the first when the
 * second happened is a false claim about the world, so the outcome of every review query is now recorded as a structured fact.
 *
 * These tests pin the distinction, the roll-up rules, that a partial failure does not discard data that DID arrive, and that nothing about
 * scoring moved.
 */
import { describe, it, expect } from 'vitest';
import { recommendCourses, defaultLookup, lookupReviews } from '@course-copilot/recommendation';
import type { ReviewSourceHealth } from '@course-copilot/core/course';

const NAME = '\u9ad8\u7b49\u6570\u5b66';
const A = '\u5f20\u8001\u5e08';

const POLICY = {
  defaultPreferences: { gradeFriendliness: 0.5, workloadFriendliness: 0.3, attendanceFriendliness: 0.15, overallScore: 0.05 },
  defaultTopN: 5, maxTopN: 50, candidateLimit: 25,
} as never;

const ASPECTS = {
  scores: ['gradeFriendliness', 'workloadFriendliness', 'attendanceFriendliness', 'overallScore'].map((aspect) => ({
    aspect, score: 8, evidenceReviewCount: 2, mentionCount: 2,
    positiveReviewCount: 2, negativeReviewCount: 0, mixedReviewCount: 0,
    positiveMentions: 2, negativeMentions: 0, sampleCount: 2, matchedTerms: [], note: 'fixture',
  })),
  positiveMentions: 8, negativeMentions: 0, mixedReviewCount: 0, coveredReviewCount: 2, reviewCount: 2, examFormats: {},
};

function bucket(courseName = NAME): Record<string, unknown> {
  return {
    provider: 'stub', courseName, normalizedName: courseName,
    reviewCount: 2, courseReviewCount: 2, matchedTeacherReviewCount: 2,
    gradedSampleCount: 2, meanGrade: 90,
    aspects: ASPECTS,
  };
}

/** A provider that throws a real `ReviewProviderError`-shaped failure. */
function failingProvider(code: string, status?: number): Record<string, unknown> {
  const error = Object.assign(new Error(`${code} detail`), { name: 'ReviewProviderError', code, provider: 'failing', ...(status === undefined ? {} : { status }) });
  return { id: 'failing', label: 'failing', homepage: 'https://example.invalid', isAvailable: async () => true, searchCourse: async () => { throw error; } };
}

function okProvider(id = 'stub'): Record<string, unknown> {
  return {
    id, label: id, homepage: 'https://example.invalid', isAvailable: async () => true,
    searchCourse: async () => ({ reviews: [bucket()], provider: id, fromCache: false, warnings: [] }),
  };
}

/** A provider that succeeds but publishes nothing, the legitimate no-data answer. */
function emptyProvider(id = 'empty'): Record<string, unknown> {
  return {
    id, label: id, homepage: 'https://example.invalid', isAvailable: async () => true,
    searchCourse: async () => ({ reviews: [], provider: id, fromCache: false, warnings: [] }),
  };
}

const COURSE = { source: 'whu' as const, courseName: NAME, normalizedName: NAME, availability: 'unknown' as const, teacher: A };

async function run(providers: unknown[], courses = [COURSE]): Promise<Record<string, unknown>> {
  return recommendCourses(courses as never, {}, { providers: providers as never, policy: POLICY }) as never as Promise<Record<string, unknown>>;
}

const healthOf = (record: unknown): ReviewSourceHealth => (record as Record<string, unknown>).reviewSource as ReviewSourceHealth;

describe('16J-PREUI-D2 health on a single successful source', () => {
  it('A. rows: healthy, one row-producing query', async () => {
    const result = await run([okProvider()]);
    expect(healthOf(result)).toEqual({ status: 'healthy', queries: 1, rows: 1, empty: 0, unavailable: 0 });
    expect(healthOf((result.recommendations as unknown[])[0])).toEqual({ status: 'healthy', queries: 1, rows: 1, empty: 0, unavailable: 0 });
  });

  it('B. empty is a SUCCESS: healthy with empty counted, never unavailable', async () => {
    const result = await run([emptyProvider()]);
    const health = healthOf(result);
    expect(health).toEqual({ status: 'healthy', queries: 1, rows: 0, empty: 1, unavailable: 0 });
    expect(health.status).not.toBe('unavailable');
    // And the course is reported as having no trusted data, with the health saying it is not a failure.
    const insufficient = (result.insufficientData as Array<Record<string, unknown>>)[0];
    expect(insufficient).toBeDefined();
    expect(healthOf(insufficient)).toEqual(health);
  });
});

describe('16J-PREUI-D2 no-data and failure are structurally different', () => {
  it('C. network failure: unavailable with kind network', async () => {
    const result = await run([failingProvider('network-error')]);
    expect(healthOf(result)).toEqual({ status: 'unavailable', queries: 1, rows: 0, empty: 0, unavailable: 1, failureKinds: ['network'] });
  });

  it('D. HTTP failure: unavailable with kind http', async () => {
    const result = await run([failingProvider('http-error', 503)]);
    expect(healthOf(result)).toEqual({ status: 'unavailable', queries: 1, rows: 0, empty: 0, unavailable: 1, failureKinds: ['http'] });
  });

  it('E. malformed payload: unavailable with kind malformed', async () => {
    for (const code of ['invalid-json', 'unexpected-shape']) {
      const result = await run([failingProvider(code)]);
      expect(healthOf(result), code).toEqual({ status: 'unavailable', queries: 1, rows: 0, empty: 0, unavailable: 1, failureKinds: ['malformed'] });
    }
  });

  it('F. the no-data result and the failure result are NOT equal in their health', async () => {
    const noData = await run([emptyProvider()]);
    const failure = await run([failingProvider('network-error')]);
    expect(healthOf(noData)).not.toEqual(healthOf(failure));
    expect(healthOf(noData).status).toBe('healthy');
    expect(healthOf(failure).status).toBe('unavailable');
    // The distinction is branchable without reading any text.
    expect(healthOf(noData).empty).toBe(1);
    expect(healthOf(failure).unavailable).toBe(1);
  });
});

describe('16J-PREUI-D2 partial failure keeps what arrived', () => {
  it('G. one source fails, the other succeeds: data preserved and status partial', async () => {
    const result = await run([failingProvider('network-error'), okProvider('second')]);
    // The successful provider's candidates still produced a recommendation.
    expect((result.recommendations as unknown[]).length).toBe(1);
    expect(healthOf(result)).toEqual({ status: 'partial', queries: 2, rows: 1, empty: 0, unavailable: 1, failureKinds: ['network'] });
    // The failure did not clear the data that arrived.
    const rec = (result.recommendations as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect((rec.course as Record<string, unknown>).courseName).toBe(NAME);
    expect(healthOf(rec).status).toBe('partial');
  });

  it('G2. a successful empty source beside a failure is still partial, not unavailable', async () => {
    const result = await run([failingProvider('http-error', 500), emptyProvider()]);
    expect(healthOf(result)).toEqual({ status: 'partial', queries: 2, rows: 0, empty: 1, unavailable: 1, failureKinds: ['http'] });
    // Nothing succeeded in the sense of returning rows, but a query DID complete, so the source is not wholly unreachable.
    expect(healthOf(result).status).not.toBe('unavailable');
  });

  it('G3. every source failing is unavailable, not partial', async () => {
    const result = await run([failingProvider('network-error'), failingProvider('network-error')]);
    expect(healthOf(result)).toEqual({ status: 'unavailable', queries: 2, rows: 0, empty: 0, unavailable: 2, failureKinds: ['network'] });
  });

  it('G4. a roll-up query failing on its own is partial while the bucket query succeeded', async () => {
    /*
     * `aggregateForCourse` is a SEPARATE request, so it is a separate chance to fail. When it fails the teacher's own rows must still be used —
     * that is the in-provider partial case, and it is reported rather than swallowed.
     *
     * Driven through `lookupReviews`, because that is the path that makes the extra roll-up request; `recommendCourses` relies on the lookup it
     * is given to report its own health, which the previous tests cover.
     */
    const rollUpError = Object.assign(new Error('roll-up failed'), { name: 'ReviewProviderError', code: 'http-error', provider: 'rollup', status: 500 });
    const provider = {
      id: 'rollup', label: 'rollup', homepage: 'https://example.invalid', isAvailable: async () => true,
      searchCourse: async () => ({ reviews: [bucket()], provider: 'rollup', fromCache: false, warnings: [] }),
      aggregateForCourse: async () => { throw rollUpError; },
    };
    const lookup = await lookupReviews({ courseName: NAME, teacher: A }, { providers: [provider as never], policy: POLICY } as never);
    const health = lookup.reviewSource as ReviewSourceHealth;
    expect(health.status).toBe('partial');
    expect(health.unavailable).toBe(1);
    expect(health.rows).toBe(1);
    // The successful bucket data was still used to build a match.
    expect(lookup.matches.length).toBeGreaterThan(0);
  });
});

describe('16J-PREUI-D2 run-level roll-up', () => {
  it('H. 8 healthy courses and 2 unavailable ones reports partial with correct totals', async () => {
    const courses = Array.from({ length: 10 }, (_, index) => ({
      source: 'whu' as const, courseName: `\u8bfe\u7a0b${index}`, normalizedName: `\u8bfe\u7a0b${index}`,
      availability: 'unknown' as const, teacher: A,
    }));
    // The provider answers for the first eight names and fails for the last two.
    const provider = {
      id: 'mixed', label: 'mixed', homepage: 'https://example.invalid', isAvailable: async () => true,
      searchCourse: async (query: { courseName: string }) => {
        if (query.courseName === '\u8bfe\u7a0b8' || query.courseName === '\u8bfe\u7a0b9') {
          throw Object.assign(new Error('down'), { name: 'ReviewProviderError', code: 'network-error', provider: 'mixed' });
        }
        return { reviews: [bucket(query.courseName)], provider: 'mixed', fromCache: false, warnings: [] };
      },
    };
    // 	opN must be at least 10 or the cut hides courses that were ranked, which is not what this test is about.
    const result = await recommendCourses(courses as never, {}, { providers: [provider as never], policy: { ...(POLICY as object), defaultTopN: 10 } as never }) as never as Record<string, unknown>;
    expect(healthOf(result)).toEqual({ status: 'partial', queries: 10, rows: 8, empty: 0, unavailable: 2, failureKinds: ['network'] });
    // The eight that answered are still ranked.
    expect((result.recommendations as unknown[]).length).toBe(8);
    // And each failed course reports its own unavailable health.
    for (const entry of result.insufficientData as Array<Record<string, unknown>>) {
      expect(healthOf(entry).unavailable).toBe(1);
    }
  });

  it('H2. all successful is healthy, and a course with no query is not blamed', async () => {
    const healthy = await run([okProvider()]);
    expect(healthOf(healthy).status).toBe('healthy');
    /*
     * A run whose courses all failed eligibility issues no query at all. That is the absence of evidence, not evidence that the source is down,
     * so it must not report `unavailable`.
     */
    const noQueries = await recommendCourses(
      [{ source: 'whu', courseName: NAME, normalizedName: NAME, availability: 'full' } as never],
      {},
      { providers: [okProvider() as never], policy: POLICY },
    );
    expect((noQueries as unknown as Record<string, unknown>).reviewSource).toEqual({ status: 'healthy', queries: 0, rows: 0, empty: 0, unavailable: 0 });
  });
});

describe('16J-PREUI-D2 the public result stays safe to publish', () => {
  it('I. no error object, stack, URL or provider message leaks into the result', async () => {
    const result = await run([failingProvider('network-error')]);
    const serialized = JSON.stringify(result);
    for (const forbidden of ['stack', 'at Object', 'http://', 'https://', 'Error:', 'network-error detail', 'token', 'cookie']) {
      expect(serialized.includes(forbidden), forbidden).toBe(false);
    }
    // The only thing said about the failure is the coarse kind.
    expect(healthOf(result).failureKinds).toEqual(['network']);
  });

  it('J. JSON round trip preserves the health exactly', async () => {
    const result = await run([failingProvider('http-error', 503), okProvider('second')]);
    const before = healthOf(result);
    const after = JSON.parse(JSON.stringify(before)) as ReviewSourceHealth;
    expect(after).toEqual(before);
    expect(after.status).toBe('partial');
  });
});

describe('16J-PREUI-D2 scoring did not move', () => {
  it('K. score, riskAdjustedScore, confidence and rank are identical with and without a failing sibling', async () => {
    const solo = await run([okProvider('second')]);
    const withFailure = await run([failingProvider('network-error'), okProvider('second')]);
    const pick = (value: Record<string, unknown>): unknown => {
      const rec = (value.recommendations as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
      return { score: rec.score, riskAdjustedScore: rec.riskAdjustedScore, confidence: rec.confidence, rank: rec.rank, reasons: rec.reasons };
    };
    expect(pick(withFailure)).toEqual(pick(solo));
    // Only the health differs.
    expect(healthOf(withFailure)).not.toEqual(healthOf(solo));
  });

  it('L. lookupReviews reports per-course health, and defaultLookup records one outcome per provider query', async () => {
    const single = await defaultLookup([okProvider() as never], 25)({ courseName: NAME } as never);
    expect(single.reviewSource).toEqual({ status: 'healthy', queries: 1, rows: 1, empty: 0, unavailable: 0 });
    const mixed = await defaultLookup([failingProvider('malformed') as never, emptyProvider() as never], 25)({ courseName: NAME } as never);
    expect(mixed.reviewSource).toEqual({ status: 'partial', queries: 2, rows: 0, empty: 1, unavailable: 1, failureKinds: ['malformed'] });
  });
});
