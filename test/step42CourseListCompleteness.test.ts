/**
 * PART 16J-PREUI-E3-A — the real WHU course-list completeness state.
 *
 * ## Where the rule comes from
 *
 * Measured on the live selection page across three read-only passes (16J-PREUI-E2, E2-R1 and E2-R2): the page states whether its course list is fully
 * loaded by toggling `#more` and `#endsign`, and BOTH nodes exist in BOTH states. In `partial` the page shows `#more` and hides `#endsign`; on the
 * final batch it adds `display: none` to `#more` and removes it from `#endsign`, leaving the `点此查看更多` anchor in the DOM but hidden.
 *
 * So presence proves nothing and only visibility decides — which is why the type carries both facts per node.
 *
 * ## How these tests reach the code
 *
 * The detector runs inside the built content script, so it is exercised by loading that artifact into a minimal DOM that contains exactly the two
 * markers and a `getComputedStyle` that reports their inline styles. The propagation is then driven through the real background modules.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { requestVisibleRows } from '../apps/extension/src/background/visible-rows.js';
import { requestVisibleCourses } from '../apps/extension/src/background/visible-courses.js';
import { requestVisibleRecommendations } from '../apps/extension/src/background/visible-recommendations.js';
import type { CourseReview } from '@course-copilot/core/course';
import type { ReviewProvider } from '@course-copilot/provider';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contentScriptPath = join(repoRoot, 'apps', 'extension', 'dist', 'content', 'content-script.js');

const NAME = '\u9ad8\u7b49\u6570\u5b66';
const TEACHER = '\u5468\u5955\u534e';

/** How one marker is rendered. `null` means the node is absent from the DOM entirely. */
type Marker = { display: string; visibility?: string } | null;

const MORE_ID = 'more';
const END_SIGN_ID = 'endsign';

/**
 * Load the built content script against a DOM holding exactly the two markers.
 *
 * The parts of the DOM the detector needs and no more: `querySelector('#id')`, `getComputedStyle(...).display/.visibility`, and a listener registry so
 * the visible-rows message can be asked. `querySelectorAll` returns nothing, because these tests are about the load state, not the rows.
 */
function loadContentScript(more: Marker, endSign: Marker, supported = true): { ask: (type: string) => Record<string, unknown> } {
  const markers = new Map<string, Marker>([[`#${MORE_ID}`, more], [`#${END_SIGN_ID}`, endSign]]);
  /*
   * The REAL course list, because since 16J-PREUI-E4-B2-R2 the content script reports a load state only when that list exists: its two markers describe the
   * list, so with no list there is nothing for them to describe. These tests are about the detector's verdict, so the list is present; the
   * missing-container case has its own suite.
   */
  markers.set('#contentBox .tjxk_list', { display: 'block' });
  const listeners: Array<(message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => unknown> = [];

  const elementFor = (marker: Marker): Record<string, unknown> | null => (marker === null
    ? null
    // The course-list container is a real element, so the scanner can call `querySelectorAll` on it and find no panels.
    : { style: { display: marker.display, visibility: marker.visibility ?? 'visible' }, querySelectorAll: () => [] });

  const sandbox: Record<string, unknown> = {
    document: {
      querySelectorAll: () => [],
      querySelector: (selector: string): unknown => elementFor(markers.get(selector) ?? null),
      documentElement: { querySelectorAll: () => [] },
    },
    getComputedStyle: (element: { style?: { display?: string; visibility?: string } }): { display: string; visibility: string } => ({
      display: element.style?.display ?? 'block',
      visibility: element.style?.visibility ?? 'visible',
    }),
    location: {
      hostname: supported ? 'jwgl.whu.edu.cn' : 'example.invalid',
      pathname: supported ? '/xsxk/zzxkyzb_cxZzxkYzbIndex.html' : '/',
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    MutationObserver: class { observe(): void {} disconnect(): void {} },
    window: { setTimeout: () => 0 },
    setTimeout: () => 0,
    clearTimeout: () => {},
    chrome: {
      runtime: {
        id: 'test-extension-id',
        sendMessage: () => Promise.resolve(undefined),
        onMessage: { addListener: (listener: never) => { listeners.push(listener); } },
      },
    },
  };
  sandbox['globalThis'] = sandbox;
  vm.createContext(sandbox);
  new vm.Script(readFileSync(contentScriptPath, 'utf8'), { filename: 'content-script.js' }).runInContext(sandbox);

  return {
    ask(type: string): Record<string, unknown> {
      let response: unknown;
      const listener = listeners[0];
      if (listener === undefined) throw new Error('content script registered no listener');
      listener({ type }, {}, (value: unknown) => { response = value; });
      return response as Record<string, unknown>;
    },
  };
}

/** Ask the content script for its visible-rows reply, with the markers as given. */
function loadStateFrom(more: Marker, endSign: Marker, supported = true): Record<string, unknown> | undefined {
  const reply = loadContentScript(more, endSign, supported).ask('COURSE_COPILOT_QUERY_VISIBLE_ROWS');
  return reply.loadState as Record<string, unknown> | undefined;
}

/* The two shapes measured on the live page. */
const REAL_PARTIAL = { more: { display: 'block' }, endSign: { display: 'none' } } as const;
const REAL_COMPLETE = { more: { display: 'none' }, endSign: { display: 'block' } } as const;

describe('16J-PREUI-E3-A the detector reads the real WHU shapes', () => {
  it('A. real partial: #more shown, #endsign hidden', () => {
    expect(loadStateFrom(REAL_PARTIAL.more, REAL_PARTIAL.endSign)).toEqual({
      morePresent: true, moreVisible: true, endSignPresent: true, endSignVisible: false, completeness: 'partial',
    });
  });

  it('B. real complete: #more hidden, #endsign shown', () => {
    expect(loadStateFrom(REAL_COMPLETE.more, REAL_COMPLETE.endSign)).toEqual({
      morePresent: true, moreVisible: false, endSignPresent: true, endSignVisible: true, completeness: 'complete',
    });
  });

  it('C. complete while the #more node is STILL PRESENT', () => {
    /*
     * The E2-R2 finding, frozen: on the final batch the page hides `#more` rather than removing it, and its `点此查看更多` anchor stays in the DOM. A
     * detector that inferred the end from a missing node would report `unknown` here, and a caller would keep telling the user to load more.
     */
    const state = loadStateFrom(REAL_COMPLETE.more, REAL_COMPLETE.endSign);
    expect(state?.morePresent).toBe(true);
    expect(state?.moreVisible).toBe(false);
    expect(state?.completeness).toBe('complete');
  });

  it('visibility: collapse counts as hidden', () => {
    expect(loadStateFrom({ display: 'block', visibility: 'collapse' }, { display: 'block' }, true)?.moreVisible).toBe(false);
    expect(loadStateFrom({ display: 'block' }, { display: 'block', visibility: 'hidden' })?.endSignVisible).toBe(false);
  });
});

describe('16J-PREUI-E3-A every other combination is unknown', () => {
  const cases: Array<[string, Marker, Marker, string]> = [
    ['D both visible', { display: 'block' }, { display: 'block' }, 'the page is contradicting itself'],
    ['E both hidden', { display: 'none' }, { display: 'none' }, 'no signal at all'],
    ['F both missing', null, null, 'markers not found'],
    ['G #more missing, end shown', null, { display: 'block' }, 'only one half of the pair'],
    ['H #more shown, end missing', { display: 'block' }, null, 'only one half of the pair'],
  ];
  for (const [label, more, endSign, why] of cases) {
    it(`${label} → unknown (${why})`, () => {
      const state = loadStateFrom(more, endSign);
      expect(state?.completeness).toBe('unknown');
      // And the two presence facts stay truthful, so a caller can still see which half was missing.
      expect(state?.morePresent).toBe(more !== null);
      expect(state?.endSignPresent).toBe(endSign !== null);
    });
  }

  it('I. an unsupported page reports no load state at all', () => {    /*
     * Another site could contain `#more` and `#endsign` by coincidence. The detector is consulted only on the supported page, so the reply carries no
     * load state there — and the worker turns that absence into `unknown` rather than a verdict about a page it never recognised.
     */
    const reply = loadContentScript(REAL_PARTIAL.more, REAL_PARTIAL.endSign, false).ask('COURSE_COPILOT_QUERY_VISIBLE_ROWS');
    expect(reply.supported).toBe(false);
    expect(Object.hasOwn(reply, 'loadState')).toBe(false);
  });
});

describe('16J-PREUI-E3-A presence is a precondition, not a formality', () => {
  it('a missing marker is never read as a verdict, however its visibility would compute', () => {
    /*
     * This is the case that caught a real defect in the first implementation. `isShown(null)` is `false`, so a rule written only in terms of visibility
     * turned "the end sign is there and `#more` is gone" into `complete`, and "`#more` is there and the end sign is gone" into `partial` — reading a
     * page that is not shaped as expected as though it had answered. The `present` checks are what stop that, and they are asserted here on their own
     * because the case is easy to reintroduce by simplifying the rule.
     */
    expect(loadStateFrom(null, { display: 'block' })?.completeness).toBe('unknown');
    expect(loadStateFrom({ display: 'block' }, null)?.completeness).toBe('unknown');
    expect(loadStateFrom(null, { display: 'none' })?.completeness).toBe('unknown');
    expect(loadStateFrom({ display: 'none' }, null)?.completeness).toBe('unknown');
  });

  it('a marker that is present and hidden still yields a verdict', () => {
    // The distinction the rule exists to preserve: the live page HIDES `#more`, it does not remove it.
    expect(loadStateFrom({ display: 'none' }, { display: 'block' })?.completeness).toBe('complete');
    expect(loadStateFrom({ display: 'none' }, { display: 'block' })?.morePresent).toBe(true);
  });
});

describe('16J-PREUI-E3-A the rule does not depend on counts', () => {
  it('J. the same markers give the same verdict whatever the row count is', () => {
    /*
     * E2-R2 measured that one course panel can hold 15 teaching-class rows, so `rowCount` cannot express progress: it moved by 10, 12, 13, 15 and 30
     * across identical clicks. The verdict is derived from the two markers alone, so it cannot move with the rows — this holds the markers fixed and
     * varies nothing that could influence it.
     */
    const partial = loadStateFrom(REAL_PARTIAL.more, REAL_PARTIAL.endSign);
    const complete = loadStateFrom(REAL_COMPLETE.more, REAL_COMPLETE.endSign);
    expect(partial?.completeness).toBe('partial');
    expect(complete?.completeness).toBe('complete');
    // Neither verdict mentions a count, and no count is part of the state.
    expect(Object.keys(partial ?? {}).sort()).toEqual(['completeness', 'endSignPresent', 'endSignVisible', 'morePresent', 'moreVisible']);
  });
});

// ---- background propagation ---------------------------------------------------------------------

/** Install a chrome stub whose content reply is fixed, and run one read. */
async function withReply<T>(reply: unknown, reject: unknown, run: () => Promise<T>): Promise<T> {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals.chrome;
  globals.chrome = {
    tabs: { sendMessage: () => (reject !== undefined ? Promise.reject(reject) : Promise.resolve(reply)) },
    runtime: { sendMessage: () => Promise.resolve(), onMessage: { addListener: () => {} } },
    sidePanel: { setPanelBehavior: () => Promise.resolve() },
  };
  try {
    return await run();
  } finally {
    globals.chrome = previous;
  }
}

const REAL_LOAD_STATE = { morePresent: true, moreVisible: true, endSignPresent: true, endSignVisible: false, completeness: 'partial' };

describe('16J-PREUI-E3-A the state propagates through the background', () => {
  it('K. requestVisibleRows carries it', async () => {
    const snapshot = await withReply({ supported: true, rows: [], loadState: REAL_LOAD_STATE }, undefined, () => requestVisibleRows(3));
    expect(snapshot.read).toBe('ok');
    expect(snapshot.loadState).toEqual(REAL_LOAD_STATE);
  });

  it('L. requestVisibleCourses carries it', async () => {
    const snapshot = await withReply({ supported: true, rows: [], loadState: REAL_LOAD_STATE }, undefined, () => requestVisibleCourses(3));
    expect(snapshot.loadState).toEqual(REAL_LOAD_STATE);
  });

  it('M. the failure reads report no load state at all, and never a fabricated one', async () => {
    /*
     * A read that obtained nothing has no page facts. Inventing four `false` values would read as "no more rows and no end sign" — a claim about a
     * page that was never successfully read.
     */
    const unavailable = await withReply(undefined, new Error('no content script'), () => requestVisibleRows(3));
    expect(unavailable.read).toBe('unavailable');
    expect(Object.hasOwn(unavailable, 'loadState')).toBe(false);

    /*
     * The malformed replies are the ones whose AGREED SHAPE is broken: a non-object, or an object missing `rows` or a boolean `supported`. A reply
     * whose `loadState` is wrong is a different case and is asserted in the next test: the rows are still usable, so the read stays `ok` and only the
     * diagnostic field is dropped. `{ supported: true, rows: [] }` is likewise a valid `ok` reply with no load state, covered by case P.
     */
    for (const malformed of [null, {}, { rows: [] }, { supported: true }]) {
      const snapshot = await withReply(malformed, undefined, () => requestVisibleRows(3));
      expect(snapshot.read, JSON.stringify(malformed)).toBe('malformed');
      expect(Object.hasOwn(snapshot, 'loadState'), JSON.stringify(malformed)).toBe(false);
    }
  });

  it('N. a reply whose loadState is wrong is still a usable read, with the field dropped', async () => {
    /*
     * The value crosses a process boundary, so it is checked field by field. A partially-shaped object — or a value that is not an object at all — is
     * dropped rather than coerced, because an invented `moreVisible: false` could be read as a finished list.
     *
     * The read itself stays `ok`, and that is deliberate: the rows are still perfectly usable, and discarding good data over an optional diagnostic
     * field would be the wrong trade. This is not a malformed reply — the reply's own shape is intact.
     */
    const wrongShapes: unknown[] = [
      'partial',
      { morePresent: true, moreVisible: false, endSignPresent: true },
      { morePresent: true, moreVisible: true, endSignPresent: true, endSignVisible: false, completeness: 'done' },
      { morePresent: 'yes', moreVisible: true, endSignPresent: true, endSignVisible: false, completeness: 'partial' },
    ];
    for (const loadState of wrongShapes) {
      const snapshot = await withReply({ supported: true, rows: [{ courseName: NAME }], loadState }, undefined, () => requestVisibleRows(3));
      /*
       * UPDATED IN 16J-PREUI-E4-B2-R2: `malformed`, not `ok`. A supported reply carrying no USABLE load state cannot be told apart from a page whose course
       * list could not be read, because the load state is present exactly when that list exists. What this case protects is unchanged — a misshapen
       * diagnostic must never be COERCED into a verdict, so no `loadState` is invented here.
       */
      expect(snapshot.read, JSON.stringify(loadState)).toBe('malformed');
      expect(Object.hasOwn(snapshot, 'loadState'), JSON.stringify(loadState)).toBe(false);
      // The rows are still carried back, so the caller can see what was read rather than losing it to the diagnostic.
      expect(snapshot.rows, JSON.stringify(loadState)).toHaveLength(1);
    }
  });

  it('an UNSUPPORTED reply with a malformed loadState stays a successful read', async () => {
    /*
     * The unsupported case must not inherit the rule above: recognising a page this extension does not operate on is a success, and it legitimately carries
     * no load state. Only a reply that CLAIMS support can be reporting an unreadable course structure.
     */
    const snapshot = await withReply({ supported: false, rows: [], loadState: 'partial' }, undefined, () => requestVisibleRows(3));
    expect(snapshot.read).toBe('ok');
    expect(snapshot.supported).toBe(false);
    expect(snapshot.loadState).toBeUndefined();
  });
});

/** A provider that always has one well-shaped review, so the engine can score. */
function spyProvider(): ReviewProvider {
  const review: CourseReview = {
    provider: 'spy', courseName: NAME, normalizedName: NAME, teacher: TEACHER, normalizedTeacher: TEACHER,
    reviewCount: 2, courseReviewCount: 2, matchedTeacherReviewCount: 2, gradedSampleCount: 2, meanGrade: 90,
    aspects: {
      scores: (['gradeFriendliness', 'workloadFriendliness', 'attendanceFriendliness', 'studentSentiment'] as const).map((aspect) => ({
        aspect, score: 8, evidenceReviewCount: 2, mentionCount: 2, positiveReviewCount: 2,
        negativeReviewCount: 0, mixedReviewCount: 0, positiveMentions: 2, negativeMentions: 0,
        sampleCount: 2, matchedTerms: [], note: 'fixture',
      })),
      positiveMentions: 8, negativeMentions: 0, mixedReviewCount: 0, coveredReviewCount: 2, reviewCount: 2,
      examFormats: { unknown: 0, closed_book: 0, open_book: 0, paper: 0, presentation: 0, no_exam: 0 },
    },
  };
  return {
    id: 'spy', label: 'spy', homepage: 'https://example.invalid', isAvailable: async () => true,
    searchCourse: async () => ({ reviews: [review], provider: 'spy', fromCache: false, warnings: [] }),
  } as ReviewProvider;
}

describe('16J-PREUI-E3-A the verdict reaches page and never the result', () => {
  const rows = [{ courseName: NAME, teacher: TEACHER }];

  it('O. the three verdicts land on page.completeness, with the facts beside them', async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['partial', { morePresent: true, moreVisible: true, endSignPresent: true, endSignVisible: false, completeness: 'partial' }, 'partial'],
      ['complete', { morePresent: true, moreVisible: false, endSignPresent: true, endSignVisible: true, completeness: 'complete' }, 'complete'],
      ['unknown', { morePresent: true, moreVisible: true, endSignPresent: true, endSignVisible: true, completeness: 'unknown' }, 'unknown'],
    ];
    for (const [label, loadState, expected] of cases) {
      const outcome = await withReply({ supported: true, rows, loadState }, undefined, () => requestVisibleRecommendations(1, { provider: spyProvider() }));
      expect(outcome.page.completeness, label).toBe(expected);
      expect(outcome.page.rowCount, label).toBe(1);
      expect(outcome.page.courseCount, label).toBe(1);
      expect(outcome.page.loadState, label).toMatchObject({
        morePresent: loadState.morePresent, moreVisible: loadState.moreVisible,
        endSignPresent: loadState.endSignPresent, endSignVisible: loadState.endSignVisible,
      });
    }
  });

  it('P. a read with no signal reports unknown and no facts', async () => {
    const outcome = await withReply({ supported: true, rows }, undefined, () => requestVisibleRecommendations(1, { provider: spyProvider() }));
    expect(outcome.page.completeness).toBe('unknown');
    expect(Object.hasOwn(outcome.page, 'loadState')).toBe(false);
  });

  it('Q. the recommendation result is untouched by the verdict', async () => {
    /*
     * `completeness` is an INPUT fact. The same courses must produce the same ranking, scores, confidence, reasons, warnings, review source and grade
     * aggregates whatever the page said about its own completeness.
     */
    const pick = async (loadState: Record<string, unknown>): Promise<unknown> => {
      const outcome = await withReply({ supported: true, rows, loadState }, undefined, () => requestVisibleRecommendations(1, { provider: spyProvider(), now: () => new Date('2026-05-06T07:08:09Z') }));
      const rec = outcome.result.recommendations[0];
      return {
        recommendations: outcome.result.recommendations.length,
        considered: outcome.result.considered,
        score: rec?.score, rank: rec?.rank, confidence: rec?.confidence,
        reasons: rec?.reasons, warnings: rec?.warnings,
        reviewSource: outcome.result.reviewSource, gradeAggregates: rec?.gradeAggregates,
      };
    };
    const partial = await pick({ morePresent: true, moreVisible: true, endSignPresent: true, endSignVisible: false, completeness: 'partial' });
    const complete = await pick({ morePresent: true, moreVisible: false, endSignPresent: true, endSignVisible: true, completeness: 'complete' });
    const unknown = await pick({ morePresent: false, moreVisible: false, endSignPresent: false, endSignVisible: false, completeness: 'unknown' });
    expect(complete).toEqual(partial);
    expect(unknown).toEqual(partial);
  });

  it('R. the page status survives a JSON round trip as plain data', async () => {
    const outcome = await withReply({ supported: true, rows, loadState: REAL_LOAD_STATE }, undefined, () => requestVisibleRecommendations(1, { provider: spyProvider(), now: () => new Date('2026-05-06T07:08:09Z') }));
    const before = outcome.page;
    expect(JSON.parse(JSON.stringify(before))).toEqual(before);
    for (const [key, value] of Object.entries(before)) {
      if (key === 'loadState') continue;
      expect(['string', 'number', 'boolean'], key).toContain(typeof value);
    }
  });
});
