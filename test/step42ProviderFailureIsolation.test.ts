/**
 * PART 16J-PREUI-D2-R1 — failure isolation for the two requests a teacher-scoped search makes.
 *
 * ## The bug these lock
 *
 * `WhuCoursesProvider.searchCourse` fetched the teacher's rows, then awaited the whole-course corpus. The corpus roll-ups are background context,
 * but a corpus failure threw out of the whole call — so the caller recorded `unavailable` and everything, including data already fetched, was
 * reported as never obtained.
 *
 * ## What is asserted, and what is deliberately NOT
 *
 * The isolation invariant is asserted directly: with the corpus request failing, `searchCourse` RESOLVES, reports `partial`, and does not
 * attribute the failure to the teacher's own request.
 *
 * The teacher BUCKET's row count is not asserted. In this environment that bucket came back empty even on the fully successful path, which is a
 * separate question about local teacher-key matching — one this step neither caused nor fixes. Asserting around it would hide it, so it is
 * reported instead.
 */
import { describe, it, expect } from 'vitest';
import { WhuCoursesProvider, WHUCOURSES_FIELDS } from '@course-copilot/provider/whucourses';
import type { ReviewSourceHealth } from '@course-copilot/core/course';

const NAME = '\u9ad8\u7b49\u6570\u5b66';
const A = '\u5468\u5955\u534e';

const NO_CACHE = {
  get: async () => undefined, set: async () => {}, delete: async () => {}, clear: async () => {},
  stats: () => ({ hits: 0, misses: 0, size: 0, enabled: false }),
} as never;

/**
 * RAW API-keyed rows, exactly as the site returns them over the wire.
 *
 * This shape matters more than it looks: `fetchRows` runs every served object through `normalizeRow` itself, so a fixture that pre-normalizes would
 * be normalized a second time — and the second pass finds none of the published field names, yielding empty course names and `missing` teacher
 * validity. That produced reviews = 0 on the fully successful path and very nearly read as a provider bug.
 */
function rawRows(): unknown[] {
  return ['90', '95'].map((grade) => ({
    [WHUCOURSES_FIELDS.courseName]: NAME,
    [WHUCOURSES_FIELDS.teacher]: A,
    [WHUCOURSES_FIELDS.grade]: grade,
    [WHUCOURSES_FIELDS.content]: '\u8001\u5e08\u8bb2\u5f97\u5f88\u597d',
    [WHUCOURSES_FIELDS.attendance]: '',
    [WHUCOURSES_FIELDS.assessment]: '',
  }));
}

type Failure = 'network' | 'http' | 'malformed';

/** A provider whose teacher request succeeds and whose corpus request behaves as asked. */
function withCorpus(corpus: 'rows' | Failure): { provider: InstanceType<typeof WhuCoursesProvider>; urls: string[] } {
  const urls: string[] = [];
  const rows = rawRows();
  const provider = new WhuCoursesProvider({
    cache: NO_CACHE,
    fetchImpl: (async (url: unknown) => {
      const target = String(url);
      urls.push(target);
      if (!target.includes('instructor=')) {
        if (corpus === 'network') throw Object.assign(new Error('network down'), { name: 'ReviewProviderError', code: 'network-error', provider: 'whucourses' });
        if (corpus === 'http') return new Response('boom', { status: 503 });
        if (corpus === 'malformed') return new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch,
  });
  return { provider, urls };
}

/** A provider whose corpus succeeds and whose teacher request behaves as asked. */
function withTeacher(teacher: Failure): { provider: InstanceType<typeof WhuCoursesProvider>; urls: string[] } {
  const urls: string[] = [];
  const rows = rawRows();
  const provider = new WhuCoursesProvider({
    cache: NO_CACHE,
    fetchImpl: (async (url: unknown) => {
      const target = String(url);
      urls.push(target);
      if (target.includes('instructor=')) {
        if (teacher === 'network') throw Object.assign(new Error('network down'), { name: 'ReviewProviderError', code: 'network-error', provider: 'whucourses' });
        if (teacher === 'http') return new Response('boom', { status: 503 });
        return new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch,
  });
  return { provider, urls };
}

const query = { courseName: NAME, teacher: A, localTeacherNames: [A] } as never;

describe('16J-PREUI-D2-R1 a teacher-scoped search is two requests', () => {
  it('A. both succeed: healthy with two queries, and the teacher bucket is populated', async () => {
    const { provider, urls } = withCorpus('rows');
    const found = await provider.searchCourse(query);
    expect(urls.length).toBe(2);
    expect(found.reviewSource).toEqual({ status: 'healthy', queries: 2, rows: 2, empty: 0, unavailable: 0 });
    /*
     * The end-to-end proof that a matching single-teacher row survives into `reviews`: this is what the fixture shape was hiding before, and what
     * makes the corpus-failure assertions below meaningful rather than merely "the call did not throw".
     */
    expect(found.reviews.length).toBe(1);
    expect(found.reviews[0]?.teacher).toBe(A);
    expect(found.reviews[0]?.reviewCount).toBe(2);
  });

  it('the filtered request is the teacher one', async () => {
    const { provider, urls } = withCorpus('rows');
    await provider.searchCourse(query);
    expect(urls[0]).toContain('instructor=');
    expect(urls[1]).not.toContain('instructor=');
  });
});

describe('16J-PREUI-D2-R1 a corpus failure no longer destroys the call', () => {
  for (const kind of ['network', 'http', 'malformed'] as const) {
    it(`B/C/D. corpus ${kind} failure: the call RESOLVES and reports partial`, async () => {
      const { provider } = withCorpus(kind);
      // Before the fix this rejected, which is what discarded the teacher's already-fetched rows.
      const found = await provider.searchCourse(query);
      const health = found.reviewSource as ReviewSourceHealth;
      expect(health.status, kind).toBe('partial');
      expect(health.queries, kind).toBe(2);
      expect(health.unavailable, kind).toBe(1);
      // The failure is attributed to the corpus request, not to the teacher's.
      expect(health.rows, kind).toBe(1);
      expect(health.failureKinds, kind).toHaveLength(1);
    });
  }

  it('the corpus failure is reported as a warning as well as a fact', async () => {
    const { provider } = withCorpus('network');
    const found = await provider.searchCourse(query);
    expect(found.warnings.some((warning) => warning.includes('\u8bfe\u7a0b\u6574\u4f53'))).toBe(true);
  });

  it('corpus-derived roll-ups stay ABSENT rather than being approximated from the teacher bucket', async () => {
    /*
     * `courseLevel` and `teachingClassLevel` describe the whole course and the class's related set. Neither is knowable from one teacher's rows,
     * so reporting the bucket as the course total is exactly the misattribution these fields exist to prevent.
     */
    const { provider } = withCorpus('network');
    const found = await provider.searchCourse(query);
    expect(found.courseLevel).toBeUndefined();
    expect(found.teachingClassLevel).toBeUndefined();
    expect(found.courseSupplementary).toBeUndefined();
  });
});

describe('16J-PREUI-D2-R1 the teacher request failing is still a failure', () => {
  it('E. a teacher failure rejects, so a corpus is never passed off as the teacher\'s evidence', async () => {
    const { provider, urls } = withTeacher('network');
    await expect(provider.searchCourse(query)).rejects.toThrow();
    // Only the first request was attempted; the corpus was never reached, so the call has nothing to report.
    expect(urls.length).toBe(1);
  });

  it('E2. HTTP and malformed teacher failures reject for the same reason', async () => {
    for (const kind of ['http', 'malformed'] as const) {
      const { provider } = withTeacher(kind);
      await expect(provider.searchCourse(query), kind).rejects.toThrow();
    }
  });
});

describe('16J-PREUI-D2-R1 health accounting counts each request once', () => {
  it('H. an unfiltered search reuses its own response instead of fetching twice', async () => {
    /*
     * With no `instructor` filter the response already IS the whole course, so a second request would be a byte-identical duplicate. That path
     * reports one request, and the count must say so rather than assuming two.
     */
    const { provider, urls } = withCorpus('rows');
    const found = await provider.searchCourse({ courseName: NAME } as never);
    expect(urls.length).toBe(1);
    expect(found.reviewSource).toEqual({ status: 'healthy', queries: 1, rows: 1, empty: 0, unavailable: 0 });
  });
});
