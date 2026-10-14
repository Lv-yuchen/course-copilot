/**
 * PART 16J-PREUI-E1 — honest page-read status.
 *
 * ## The statement this exists to prevent
 *
 * Six different realities used to arrive as the same `[]`: an unsupported tab, a tab with no content script, a reply that could not be read, a page
 * that lists no courses, and rows that could not be mapped. A caller that only sees "no rows" cannot tell a user which of those happened, and
 * "this page has no courses" is a claim about the world that the extension was not entitled to make in four of the six cases.
 *
 * These tests pin each state apart, and pin that none of it reaches the ranking.
 */
import { describe, it, expect } from 'vitest';
import { requestVisibleRows } from '../apps/extension/src/background/visible-rows.js';
import { requestVisibleCourses } from '../apps/extension/src/background/visible-courses.js';
import { requestVisibleRecommendations } from '../apps/extension/src/background/visible-recommendations.js';
import type { CourseReview } from '@course-copilot/core/course';
// `AspectKey` lives with the aspect contracts rather than in `course.ts`, and is imported from its own home.
import { ASPECT_KEYS, EXAM_FORMATS } from '@course-copilot/core/aspects';
import type { CourseSearchQuery, ReviewProvider } from '@course-copilot/provider';

const NAME = '\u9ad8\u7b49\u6570\u5b66';
const TEACHER = '\u5468\u5955\u534e';

/** A provider that answers with one well-shaped review for any query, so the engine always has something to score. */
function spyProvider(): { provider: ReviewProvider; searches: CourseSearchQuery[] } {
  const searches: CourseSearchQuery[] = [];
  const provider: ReviewProvider = {
    id: 'spy', label: 'spy', homepage: 'https://example.invalid', isAvailable: async () => true,
    searchCourse: async (query: CourseSearchQuery) => {
      searches.push({ ...query });
      /*
       * A genuinely well-shaped `CourseReview`. A cast around a half-built object would let the engine throw deep inside itself, and the failure
       * would look like a composition defect rather than a fixture the real type had already rejected.
       */
      const aspects: readonly string[] = ['gradeFriendliness', 'workloadFriendliness', 'attendanceFriendliness', 'overallScore'];
      const review: CourseReview = {
        provider: 'spy',
        courseName: query.courseName,
        normalizedName: query.courseName,
        teacher: TEACHER,
        normalizedTeacher: TEACHER,
        reviewCount: 2,
        courseReviewCount: 2,
        matchedTeacherReviewCount: 2,
        gradedSampleCount: 2,
        meanGrade: 90,
        aspects: {
          scores: aspects.map((aspect) => ({
            aspect: aspect as (typeof ASPECT_KEYS)[number], score: 8, evidenceReviewCount: 2, mentionCount: 2,
            positiveReviewCount: 2, negativeReviewCount: 0, mixedReviewCount: 0,
            positiveMentions: 2, negativeMentions: 0, sampleCount: 2, matchedTerms: [], note: 'fixture',
          })),
          positiveMentions: 8, negativeMentions: 0, mixedReviewCount: 0,
          coveredReviewCount: 2, reviewCount: 2,
          // Built from the canonical list so a new format cannot silently leave this fixture incomplete.
          examFormats: Object.fromEntries(EXAM_FORMATS.map((format) => [format, 0])) as Record<(typeof EXAM_FORMATS)[number], number>,
        },
      };
      return { reviews: [review], provider: 'spy', fromCache: false, warnings: [] };
    },
  };
  return { provider, searches };
}

/** Install a chrome stub whose single `sendMessage` behaves as asked, and restore it afterwards. */
async function withChrome<T>(outcome: { reply?: unknown; reject?: unknown }, run: () => Promise<T>): Promise<T> {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals.chrome;
  /*
   * A reply that claims a supported page must carry a load state, because since 16J-PREUI-E4-B2-R2 the load state is present exactly when that page's course
   * list exists: a supported reply without one means the course structure could not be read, and the transport reports `malformed`. These cases are about the
   * envelope, so the fixtures supply what a readable page sends; the missing-container semantics have their own suite.
   */
  const READABLE_LOAD_STATE = { morePresent: true, moreVisible: true, endSignPresent: true, endSignVisible: false, completeness: 'partial' };
  const reply = typeof outcome.reply === 'object' && outcome.reply !== null
    && (outcome.reply as { supported?: unknown }).supported === true
    && (outcome.reply as { loadState?: unknown }).loadState === undefined
    ? { ...(outcome.reply as object), loadState: READABLE_LOAD_STATE }
    : outcome.reply;
  globals.chrome = {
    tabs: {
      sendMessage: () => (outcome.reject !== undefined ? Promise.reject(outcome.reject) : Promise.resolve(reply)),
    },
    runtime: { sendMessage: () => Promise.resolve(), onMessage: { addListener: () => {} } },
    sidePanel: { setPanelBehavior: () => Promise.resolve() },
  };
  try {
    return await run();
  } finally {
    globals.chrome = previous;
  }
}

const ONE_ROW = [{ courseName: NAME, teacher: '\u5468\u5955\u534e' }];

describe('16J-PREUI-E1 the ask itself is reported, not flattened', () => {
  it('A. unsupported page: the script answered, and said this is not its page', async () => {
    const snapshot = await withChrome({ reply: { supported: false, rows: [] } }, () => requestVisibleRows(1));
    expect(snapshot).toEqual({ read: 'ok', supported: false, rows: [] });
  });

  it('B. supported with zero rows: a different fact from A', async () => {
    const snapshot = await withChrome({ reply: { supported: true, rows: [] } }, () => requestVisibleRows(1));
    expect(snapshot).toMatchObject({ read: 'ok', supported: true, rows: [] });
    // Both are `ok`, so the page verdict is what separates them — and it is reported, not inferred.
    const unsupported = await withChrome({ reply: { supported: false, rows: [] } }, () => requestVisibleRows(1));
    expect(snapshot).not.toEqual(unsupported);
  });

  it('C. rejected sendMessage is unavailable, not an empty page', async () => {
    const snapshot = await withChrome({ reject: new Error('no content script') }, () => requestVisibleRows(1));
    expect(snapshot).toEqual({ read: 'unavailable', rows: [] });
    // No page verdict is asserted, because nothing answered: `supported: false` would be a script opinion that does not exist.
    expect(Object.hasOwn(snapshot, 'supported')).toBe(false);
  });

  it('C2. an unusable tab id is unavailable without sending anything', async () => {
    for (const bad of [undefined, null, '3', 7.5, Number.NaN]) {
      const snapshot = await withChrome({ reply: { supported: true, rows: ONE_ROW } }, () => requestVisibleRows(bad));
      expect(snapshot.read, String(bad)).toBe('unavailable');
      expect(snapshot.rows, String(bad)).toEqual([]);
    }
  });

  it('D. a malformed reply is its own state, distinct from unavailable', async () => {
    for (const reply of [null, 'text', 42, {}, { rows: [] }, { supported: 'yes', rows: [] }, { supported: true, rows: 'no' }]) {
      const snapshot = await withChrome({ reply }, () => requestVisibleRows(1));
      expect(snapshot.read, JSON.stringify(reply)).toBe('malformed');
      expect(snapshot.rows, JSON.stringify(reply)).toEqual([]);
    }
    // The two failure states are not interchangeable.
    expect('malformed').not.toBe('unavailable');
  });

  it('E. a supported page with one row reports it', async () => {
    const snapshot = await withChrome({ reply: { supported: true, rows: ONE_ROW } }, () => requestVisibleRows(1));
    expect(snapshot.read).toBe('ok');
    expect(snapshot.supported).toBe(true);
    expect(snapshot.rows).toHaveLength(1);
  });
});

describe('16J-PREUI-E1 rows and courses are counted separately', () => {
  it('F. a row that cannot be mapped is visible as rowCount > courseCount', async () => {
    // A row with a blank name is refused by the adapter, so it exists as a ROW and not as a COURSE.
    const snapshot = await withChrome({ reply: { supported: true, rows: [{ courseName: '   ' }] } }, () => requestVisibleCourses(1));
    expect(snapshot.read).toBe('ok');
    expect(snapshot.supported).toBe(true);
    expect(snapshot.rowCount).toBe(1);
    expect(snapshot.courseCount).toBe(0);
    expect(snapshot.courses).toEqual([]);
    /*
     * This is the case that used to be indistinguishable from an empty page: one unreadable row and no rows at all both produced `[]`. The two
     * counts are what keep them apart.
     */
    const empty = await withChrome({ reply: { supported: true, rows: [] } }, () => requestVisibleCourses(1));
    expect(snapshot.rowCount).not.toBe(empty.rowCount);
    expect(snapshot.courseCount).toBe(empty.courseCount);
  });

  it('E2. a mappable row reports one of each', async () => {
    const snapshot = await withChrome({ reply: { supported: true, rows: ONE_ROW } }, () => requestVisibleCourses(1));
    expect(snapshot.rowCount).toBe(1);
    expect(snapshot.courseCount).toBe(1);
    expect(snapshot.courses[0]?.courseName).toBe(NAME);
  });

  it('a failed read reports zero counts without pretending a page verdict', async () => {
    const snapshot = await withChrome({ reject: new Error('gone') }, () => requestVisibleCourses(1));
    expect(snapshot.read).toBe('unavailable');
    expect(snapshot.rowCount).toBe(0);
    expect(snapshot.courseCount).toBe(0);
    expect(Object.hasOwn(snapshot, 'supported')).toBe(false);
  });
});

describe('16J-PREUI-E1 the recommendation envelope carries the page status', () => {
  it('G. success carries page facts beside an unchanged result', async () => {
    const spy = spyProvider();
    const outcome = await withChrome(
      { reply: { supported: true, rows: ONE_ROW } },
      () => requestVisibleRecommendations(1, { provider: spy.provider, now: () => new Date('2026-05-06T07:08:09Z') }),
    );
    expect(outcome.page).toMatchObject({ read: 'ok', supported: true, rowCount: 1, courseCount: 1, completeness: 'partial' });
    // The result is the canonical one, and it was produced from the row.
    expect(outcome.result.considered).toBe(1);
    expect(outcome.result.recommendations).toHaveLength(1);
  });

  it('H. an unsupported page still yields a canonical empty result, now explained', async () => {
    const spy = spyProvider();
    const outcome = await withChrome(
      { reply: { supported: false, rows: [] } },
      () => requestVisibleRecommendations(1, { provider: spy.provider, now: () => new Date('2026-05-06T07:08:09Z') }),
    );
    // The engine still runs and still answers: the page status does not short-circuit it.
    expect(outcome.result.considered).toBe(0);
    expect(outcome.result.recommendations).toEqual([]);
    expect(outcome.result.dataCoverage).toBeNull();
    expect(outcome.page).toEqual({ read: 'ok', supported: false, rowCount: 0, courseCount: 0, completeness: 'unknown' });
    expect(spy.searches.length).toBe(0);
  });

  it('I. a failed read is reported as unavailable, with an empty result', async () => {
    const spy = spyProvider();
    const outcome = await withChrome(
      { reject: new Error('no content script') },
      () => requestVisibleRecommendations(1, { provider: spy.provider, now: () => new Date('2026-05-06T07:08:09Z') }),
    );
    expect(outcome.page).toEqual({ read: 'unavailable', rowCount: 0, courseCount: 0, completeness: 'unknown' });
    expect(outcome.result.recommendations).toEqual([]);
  });

  it('I2. an unmappable row is explained rather than reported as an empty page', async () => {
    const spy = spyProvider();
    const outcome = await withChrome(
      { reply: { supported: true, rows: [{ courseName: '   ' }] } },
      () => requestVisibleRecommendations(1, { provider: spy.provider, now: () => new Date('2026-05-06T07:08:09Z') }),
    );
    expect(outcome.page).toMatchObject({ read: 'ok', supported: true, rowCount: 1, courseCount: 0, completeness: 'partial' });
    expect(outcome.result.considered).toBe(0);
  });

  it('J. completeness mirrors the page signal, and is unknown whenever there is none to mirror', async () => {
    /*
     * UPDATED THROUGH E3-A AND E4-B2-R2. This case used to assert that every path said `unknown`, which was right while nothing could read the page's own
     * completeness signal. That signal now exists, so the meaningful statement is twofold: a report is mirrored, and `unknown` is the answer whenever no
     * signal was obtained — an unsupported page, or a supported page whose course list could not be read.
     *
     * What must never happen is unchanged and is asserted for every case: `completeness` is never `complete` unless the PAGE said so.
     */
    for (const reply of [{ supported: true, rows: ONE_ROW }, { supported: false, rows: [] }, { supported: true, rows: [] }]) {
      const spy = spyProvider();
      const outcome = await withChrome({ reply }, () => requestVisibleRecommendations(1, { provider: spy.provider }));
      // A mirrored `partial`, or `unknown` when no signal was obtained — never a claim of completion.
      expect(['partial', 'unknown'], JSON.stringify(reply)).toContain(outcome.page.completeness);
      expect(outcome.page.completeness, JSON.stringify(reply)).not.toBe('complete');
    }
    // And with no usable signal at all, the answer is `unknown`.
    const unsupported = await withChrome({ reply: { supported: false, rows: [] } }, () => requestVisibleRecommendations(1, { provider: spyProvider().provider }));
    expect(unsupported.page.completeness).toBe('unknown');
  });
});

describe('16J-PREUI-E1 the page status does not touch the ranking', () => {
  it('K. the same rows produce the same result fields whatever the page said about itself', async () => {
    /*
     * `supported` is deliberately varied while the ROWS are held identical, because that is the field a careless implementation would let leak into
     * the engine. `completeness` is constant at `unknown` by construction, so it cannot be varied.
     */
    const pick = async (supported: boolean): Promise<unknown> => {
      const spy = spyProvider();
      const outcome = await withChrome(
        { reply: { supported, rows: ONE_ROW } },
        () => requestVisibleRecommendations(1, { provider: spy.provider, now: () => new Date('2026-05-06T07:08:09Z') }),
      );
      const rec = outcome.result.recommendations[0];
      return {
        considered: outcome.result.considered,
        score: rec?.score,
        rank: rec?.rank,
        confidence: rec?.confidence,
        reasons: rec?.reasons,
        reviewSource: outcome.result.reviewSource,
        gradeAggregates: rec?.gradeAggregates,
      };
    };
    expect(await pick(true)).toEqual(await pick(false));
  });

  it('L. the page status survives a JSON round trip and stays plain data', async () => {
    const { provider } = spyProvider();
    const outcome = await withChrome(
      { reply: { supported: true, rows: ONE_ROW } },
      () => requestVisibleRecommendations(1, { provider, now: () => new Date('2026-05-06T07:08:09Z') }),
    );
    const before = outcome.page;
    expect(JSON.parse(JSON.stringify(before))).toEqual(before);
    /*
     * No Map, Set, Date, class instance or function: the envelope crosses a runtime boundary. `loadState` is the one nested object, so it is checked the same
     * way rather than waved through — a nested `Map` would survive the round trip as `{}`, and this is what would notice.
     */
    for (const [key, value] of Object.entries(before)) {
      if (key === 'loadState') {
        for (const nested of Object.values(value as Record<string, unknown>)) {
          expect(['string', 'number', 'boolean'], `${key}.${String(nested)}`).toContain(typeof nested);
        }
        continue;
      }
      expect(['string', 'number', 'boolean'], key).toContain(typeof value);
    }
  });
});
