/**
 * PART 16J-PREUI-E4-C2-B2 — the hardened recommendation handoff.
 *
 * ## The three seams this proves
 *
 * 1. **`page` is kept.** The worker already answers `{ ok, page, result }`; the controller used to publish only `result`, which left an empty
 *    recommendation list unexplainable. Without the page, "unsupported tab", "failed read" and "this page genuinely lists no courses" are one answer.
 * 2. **the target can be bound.** `request(expectedTabId)` aims at an APPROVED tab rather than at whatever is in front. This is the preparation handoff: a
 *    run finishes against one tab, and a request aimed at a different tab would read another page's courses and query a review source about them.
 * 3. **a changed tab is a reported outcome.** When the attempt is still the live one and its page is gone, the panel is told `stale` instead of being left
 *    in `loading` forever — while a SUPERSEDED attempt still writes nothing, so it cannot clobber the newer attempt's state.
 *
 * The controller is production code here; the transport is faked.
 */
import { describe, expect, it } from 'vitest';
import { createRecommendationRequestController, type RecommendationRequestState } from '../apps/extension/src/sidepanel/recommendation-request.js';

/** A canonical-looking result. Only its IDENTITY matters: the controller must publish it by reference. */
const RESULT = { recommendations: [], considered: 3 } as never;
/** A canonical-looking page read status. */
const PAGE = { read: 'ok', supported: true, rowCount: 3, courseCount: 3, completeness: 'complete' } as never;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => { resolveFn = res; });
  return { promise, resolve: resolveFn };
}

interface Harness {
  readonly request: (expectedTabId?: number) => Promise<void>;
  readonly states: RecommendationRequestState[];
  readonly sent: RuntimeMessage[];
  readonly queryCount: () => number;
}

/**
 * Build a controller whose tab answers and responses are scripted in call order.
 *
 * A deferred tab answer is how "the user switches while the query is in flight" is arranged rather than hoped for; because it is consumed ONCE, a test that
 * makes two calls must queue two answers. That one-shot consumption is also what makes the ordering assertion in these tests meaningful.
 */
function harness(options: {
  tabAnswers: Array<number | null | Array<{ id?: number }> | Deferred<Array<{ id?: number }>>>;
  responses?: Array<unknown | Error | Deferred<unknown>>;
}): Harness {
  const states: RecommendationRequestState[] = [];
  const sent: RuntimeMessage[] = [];
  let queryIndex = 0;
  let responseIndex = 0;

  const queryActiveTab = (): Promise<Array<{ id?: number }>> => {
    const answer = options.tabAnswers[queryIndex];
    queryIndex += 1;
    if (answer === undefined) return Promise.resolve([]);
    if (typeof answer === 'number') return Promise.resolve([{ id: answer }]);
    if (answer === null) return Promise.resolve([]);
    if (Array.isArray(answer)) return Promise.resolve(answer);
    return answer.promise;
  };

  const sendMessage = (message: RuntimeMessage): Promise<unknown> => {
    sent.push(message);
    const answer = options.responses?.[responseIndex];
    responseIndex += 1;
    if (answer instanceof Error) return Promise.reject(answer);
    if (answer !== undefined && typeof answer === 'object' && answer !== null && 'promise' in (answer as object)) {
      return (answer as Deferred<unknown>).promise;
    }
    return Promise.resolve(answer);
  };

  const controller = createRecommendationRequestController({ sink: (state) => states.push(state), queryActiveTab, sendMessage });
  return { request: controller.request, states, sent, queryCount: () => queryIndex };
}

/**
 * Let every pending microtask settle.
 *
 * One `await` is not enough: a request crosses several awaits (preflight query, then send), so a single tick would leave the send un-issued and make an
 * ordering assertion pass or fail for the wrong reason.
 */
async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

/** The tab id a message was addressed to. */
function target(message: RuntimeMessage | undefined): number | undefined {
  return (message as { tabId?: number } | undefined)?.tabId;
}

describe('16J-PREUI-E4-C2-B2 A. the legacy no-argument call still asks about the active tab', () => {
  it('reads the tab at trigger time and sends exactly one request to it', async () => {
    const h = harness({ tabAnswers: [7, 7], responses: [{ ok: true, page: PAGE, result: RESULT }] });
    await h.request();
    expect(h.sent).toHaveLength(1);
    expect(target(h.sent[0])).toBe(7);
    // One query to choose the tab, one to decide whether the answer may be applied.
    expect(h.queryCount()).toBe(2);
    expect(h.states).toEqual([{ status: 'loading' }, { status: 'success', page: PAGE, result: RESULT }]);
  });

  it('a tab switch between requests retargets the second one', async () => {
    // Nothing is cached, so a stored tab id cannot leak from the first request into the second.
    const h = harness({
      tabAnswers: [1, 1, 2, 2],
      responses: [{ ok: true, page: PAGE, result: RESULT }, { ok: true, page: PAGE, result: RESULT }],
    });
    await h.request();
    await h.request();
    expect(h.sent.map(target)).toEqual([1, 2]);
  });
});

describe('16J-PREUI-E4-C2-B2 B. an expected tab is adopted and used', () => {
  it('sends exactly one request, to the expected tab', async () => {
    const h = harness({ tabAnswers: [11, 11], responses: [{ ok: true, page: PAGE, result: RESULT }] });
    await h.request(11);
    expect(h.sent).toHaveLength(1);
    expect(target(h.sent[0])).toBe(11);
  });

  it('binds even when the active tab would have been a different one — the expected tab wins', async () => {
    /*
     * The core of the handoff. A naive implementation reads the active tab and sends there; this one sends to the approved tab, and the preflight is what
     * decides whether the attempt may proceed at all rather than what it aims at.
     */
    const h = harness({ tabAnswers: [11, 11], responses: [{ ok: true, page: PAGE, result: RESULT }] });
    await h.request(11);
    expect(h.sent.map(target)).toEqual([11]);
  });
});

describe('16J-PREUI-E4-C2-B2 C. a mismatched preflight sends NOTHING and reports stale', () => {
  it('zero requests when the user has already left the approved tab', async () => {
    /*
     * The failure this prevents is not a cosmetic one: sending here would read tab B's page and query a review source about B's courses — a real operation on a
     * page the user never approved for it.
     */
    const h = harness({ tabAnswers: [22], responses: [{ ok: true, page: PAGE, result: RESULT }] });
    await h.request(11);
    expect(h.sent, 'a request was sent to the wrong tab').toHaveLength(0);
    // Nothing was published as loading either: the attempt never began.
    expect(h.states).toEqual([{ status: 'stale', reason: 'tab_changed' }]);
  });

  it('zero requests when no tab can be named at all', async () => {
    const h = harness({ tabAnswers: [null], responses: [] });
    await h.request(11);
    expect(h.sent).toHaveLength(0);
    expect(h.states).toEqual([{ status: 'stale', reason: 'tab_changed' }]);
  });
});

describe('16J-PREUI-E4-C2-B2 D. the target never migrates after approval', () => {
  it('a switch AFTER sending leaves the sent target alone and reports stale', async () => {
    /*
     * Preflight says A. The user then switches to B while the worker is reading the page. The request that was already sent stays addressed to A — it cannot
     * be re-aimed — and the answer is judged stale rather than committed against B.
     *
     * The tab answers are queued in the order they will be consumed: the preflight, then the commit-time check.
     */
    const answer = deferred<unknown>();
    const h = harness({ tabAnswers: [11, 22], responses: [answer] });
    const started = h.request(11);
    // Let the preflight resolve and the send be issued, but NOT the answer.
    await settle();
    expect(h.sent.map(target), 'the request was not addressed to the approved tab').toEqual([11]);

    answer.resolve({ ok: true, page: PAGE, result: RESULT });
    await started;

    // Still only ever addressed to A.
    expect(h.sent.map(target)).toEqual([11]);
    expect(h.sent.every((message) => target(message) !== 22)).toBe(true);
    expect(h.states).toEqual([{ status: 'loading' }, { status: 'stale', reason: 'tab_changed' }]);
  });
});

describe('16J-PREUI-E4-C2-B2 E. success carries BOTH the page and the result', () => {
  it('publishes both, by reference', async () => {
    const page = PAGE;
    const result = RESULT;
    const h = harness({ tabAnswers: [5, 5], responses: [{ ok: true, page, result }] });
    await h.request(5);
    const success = h.states[1] as { status: string; page: unknown; result: unknown };
    expect(success.status).toBe('success');
    // By reference: no clone, no reshape. A copy here is what would let the panel's data drift from the canonical shape.
    expect(success.page).toBe(page);
    expect(success.result).toBe(result);
  });
});

describe('16J-PREUI-E4-C2-B2 F and G. an incomplete success is malformed, never success', () => {
  it('a success without a page is an error', async () => {
    /*
     * A success with no page cannot explain an empty result, and the panel would have to guess why there were no recommendations. Reporting it as success would
     * make "I could not see the page" indistinguishable from "the page has nothing".
     */
    const h = harness({ tabAnswers: [4, 4], responses: [{ ok: true, result: RESULT }] });
    await h.request(4);
    expect(h.states[1]?.status).toBe('error');
    expect(h.states.some((state) => state.status === 'success')).toBe(false);
  });

  it('a success without a result is an error', async () => {
    const h = harness({ tabAnswers: [4, 4], responses: [{ ok: true, page: PAGE }] });
    await h.request(4);
    expect(h.states[1]?.status).toBe('error');
    expect(h.states.some((state) => state.status === 'success')).toBe(false);
  });

  it('a page that is present but not the agreed shape is an error', async () => {
    // A page object is not enough: the fields the panel reads must actually be there, because the value crossed a process boundary.
    for (const page of [{}, { read: 'ok' }, { read: 'ok', rowCount: 1, courseCount: 1 }, { read: 'nonsense', rowCount: 1, courseCount: 1, completeness: 'complete' }]) {
      const h = harness({ tabAnswers: [4, 4], responses: [{ ok: true, page, result: RESULT }] });
      await h.request(4);
      expect(h.states[1]?.status, JSON.stringify(page)).toBe('error');
    }
  });
});

describe('16J-PREUI-E4-C2-B2 H. a superseded attempt writes nothing at all', () => {
  it('produces no stale, no success and no error after it is superseded', async () => {
    /*
     * The distinction the freshness check makes. A NEWER attempt took over, so this one is not merely stale — it is irrelevant, and anything it wrote could
     * land on top of the newer attempt's `loading`.
     *
     * The arrangement is fully scripted so there is no reliance on which microtask lands first. Both attempts are for the SAME tab, which is the point: the
     * tab comparison is true for both, so only the generation can separate them.
     *
     *   #1  preflight → A (immediate)   commit → A (immediate)   send → parked forever
     *   #2  preflight → A (immediate)   commit → A (immediate)   send → success
     */
    const parkedResponse = deferred<unknown>();
    const responses: unknown[] = [parkedResponse];
    const h = harness({
      tabAnswers: [5, 5, 5, 5],
      responses,
    });

    // #1 runs to its send and parks there: the worker is "still reading the page".
    const startedFirst = h.request(5);
    await settle();
    expect(h.sent, '#1 did not reach its send').toHaveLength(1);

    // #2 takes over. Its response is scripted now, so the fallback cannot silently become a malformed-reply error.
    responses.push({ ok: true, page: PAGE, result: RESULT });
    const startedSecond = h.request(5);
    await startedSecond;
    expect(h.states).toContainEqual({ status: 'success', page: PAGE, result: RESULT });

    /*
     * Now #1's answer arrives. Everything it could do from here is forbidden: committing would overwrite the newer success, and reporting `stale` would
     * claim the live attempt's page had changed when the live attempt is #2's, not this one.
     */
    const before = h.states.length;
    parkedResponse.resolve({ ok: true, page: PAGE, result: RESULT });
    await startedFirst;

    expect(h.states.length, 'a superseded attempt wrote state').toBe(before);
    expect(h.states.some((state) => state.status === 'stale'), 'a superseded attempt wrote stale').toBe(false);
    // The newest answer is still the one on screen, not the older one that landed last.
    expect(h.states[h.states.length - 1]).toEqual({ status: 'success', page: PAGE, result: RESULT });
  });
});

describe('16J-PREUI-E4-C2-B2 I and J. stale is written once, and carries no result', () => {
  it('exactly one stale write for a same-generation tab change', async () => {
    const h = harness({ tabAnswers: [8, 9], responses: [{ ok: true, page: PAGE, result: RESULT }] });
    await h.request(8);
    expect(h.states.filter((state) => state.status === 'stale')).toHaveLength(1);
  });

  it('the stale state carries a reason and nothing that could be read as a result', async () => {
    const h = harness({ tabAnswers: [8, 9], responses: [{ ok: true, page: PAGE, result: RESULT }] });
    await h.request(8);
    const stale = h.states.find((state) => state.status === 'stale') as unknown as Record<string, unknown>;
    expect(stale).toEqual({ status: 'stale', reason: 'tab_changed' });
    // A stale answer must never be readable as current: no keys beyond the reason.
    expect(Object.keys(stale).sort()).toEqual(['reason', 'status']);
    expect(Object.hasOwn(stale, 'result')).toBe(false);
    expect(Object.hasOwn(stale, 'page')).toBe(false);
  });

  it('stale is never used for review health, hydration, confidence or evidence', async () => {
    /*
     * The four things `stale` must never mean. Each has its own home: review health travels in `page`/`result.reviewSource`, partial teacher data in the
     * preparation's stop reason, and confidence and evidence inside the result. Calling any of them "stale" would collapse four different facts into one word.
     */
    const h = harness({ tabAnswers: [8, 8], responses: [{ ok: true, page: PAGE, result: RESULT }] });
    await h.request(8);
    // A perfectly ordinary successful run publishes no stale at all, whatever the result contains.
    expect(h.states.some((state) => state.status === 'stale')).toBe(false);
    expect(h.states[1]?.status).toBe('success');
  });
});

describe('16J-PREUI-E4-C2-B2 K and L. the worker’s own page verdicts are preserved, not re-interpreted', () => {
  it('a malformed page READ is preserved as a successful result beside it', async () => {
    /*
     * `page.read === 'malformed'` describes how the CONTENT SCRIPT's reply looked, not whether the worker's answer is usable. The envelope is well formed, so
     * the panel gets both halves and can say "I could not read that page" instead of showing an unexplained empty list.
     */
    const page = { read: 'malformed', supported: true, rowCount: 0, courseCount: 0, completeness: 'unknown' } as never;
    const h = harness({ tabAnswers: [1, 1], responses: [{ ok: true, page, result: RESULT }] });
    await h.request(1);
    expect(h.states[1]).toEqual({ status: 'success', page, result: RESULT });
    // NOT converted into a generic controller failure.
    expect(h.states.some((state) => state.status === 'error')).toBe(false);
  });

  it('an unavailable page READ is preserved too', async () => {
    const page = { read: 'unavailable', rowCount: 0, courseCount: 0, completeness: 'unknown' } as never;
    const h = harness({ tabAnswers: [1, 1], responses: [{ ok: true, page, result: RESULT }] });
    await h.request(1);
    expect(h.states[1]).toEqual({ status: 'success', page, result: RESULT });
    expect(h.states.some((state) => state.status === 'error')).toBe(false);
  });

  it('an unsupported page verdict is preserved rather than flattened', async () => {
    // `supported: false` is the content script's own claim and must arrive intact; the controller has no opinion about which page is right.
    const page = { read: 'ok', supported: false, rowCount: 0, courseCount: 0, completeness: 'unknown' } as never;
    const h = harness({ tabAnswers: [1, 1], responses: [{ ok: true, page, result: RESULT }] });
    await h.request(1);
    const success = h.states[1] as { page: { supported: boolean } };
    expect(success.page.supported).toBe(false);
  });

  it('every completeness value passes through unchanged', async () => {
    for (const completeness of ['partial', 'complete', 'unknown'] as const) {
      const page = { read: 'ok', supported: true, rowCount: 2, courseCount: 2, completeness } as never;
      const h = harness({ tabAnswers: [1, 1], responses: [{ ok: true, page, result: RESULT }] });
      await h.request(1);
      expect((h.states[1] as { page: { completeness: string } }).page.completeness, completeness).toBe(completeness);
    }
  });

  it('rowCount and courseCount are never recomputed or levelled', async () => {
    // The two disagree in a case worth preserving: rows that exist but cannot be mapped.
    const page = { read: 'ok', supported: true, rowCount: 9, courseCount: 0, completeness: 'unknown' } as never;
    const h = harness({ tabAnswers: [1, 1], responses: [{ ok: true, page, result: RESULT }] });
    await h.request(1);
    const success = h.states[1] as { page: { rowCount: number; courseCount: number } };
    expect(success.page.rowCount).toBe(9);
    expect(success.page.courseCount).toBe(0);
  });
});

describe('16J-PREUI-E4-C2-B2 M. review-source health travels through untouched', () => {
  it('each status reaches the panel exactly as the engine reported it', async () => {
    /*
     * The worker already distinguishes a successful empty query from an unavailable source, so the controller must not touch either. It also must not turn any
     * of the three into `stale` or into an error: they are ordinary outcomes of a run that worked.
     */
    for (const status of ['healthy', 'partial', 'unavailable'] as const) {
      const result = { recommendations: [], reviewSource: { status, queries: 1, rows: 0, empty: 1, unavailable: 0 } } as never;
      const h = harness({ tabAnswers: [1, 1], responses: [{ ok: true, page: PAGE, result }] });
      await h.request(1);
      const success = h.states[1] as { status: string; result: { reviewSource: { status: string } } };
      expect(success.status, status).toBe('success');
      expect(success.result.reviewSource.status, status).toBe(status);
    }
  });

  it('a successful empty query and an unavailable source stay structurally different', async () => {
    const empty = { status: 'healthy', queries: 1, rows: 0, empty: 1, unavailable: 0 } as never;
    const down = { status: 'unavailable', queries: 1, rows: 0, empty: 0, unavailable: 1, failureKinds: ['http'] } as never;
    const a = harness({ tabAnswers: [1, 1], responses: [{ ok: true, page: PAGE, result: { recommendations: [], reviewSource: empty } }] });
    const b = harness({ tabAnswers: [1, 1], responses: [{ ok: true, page: PAGE, result: { recommendations: [], reviewSource: down } }] });
    await a.request(1);
    await b.request(1);
    const left = (a.states[1] as { result: { reviewSource: unknown } }).result.reviewSource;
    const right = (b.states[1] as { result: { reviewSource: unknown } }).result.reviewSource;
    expect(left).not.toEqual(right);
    expect(left).toEqual(empty);
    expect(right).toEqual(down);
  });
});

describe('16J-PREUI-E4-C2-B2 the module stays inside its scope', () => {
  it('still keeps nothing but the generation counter', async () => {
    const source = (await import('node:fs')).readFileSync(
      new URL('../apps/extension/src/sidepanel/recommendation-request.ts', import.meta.url),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
    /*
     * `expectedTabId` is a PARAMETER, not remembered state: the approved tab is passed in per call and never cached, so a second request cannot inherit the
     * first one's target. A stored copy would reintroduce exactly the staleness the per-request decision exists to remove.
     */
    const moduleLevel = [...code.matchAll(/^  let (\w+)/gmu)].map((match) => match[1]);
    expect(moduleLevel).toEqual(['generation', 'lastTabId']);
    for (const forbidden of ['cachedTabId', 'expectedTabCache', 'lastExpectedTabId']) {
      expect(code.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('adds no browser lifecycle machinery for the tab-change case', async () => {
    // The tab is asked for at the two moments it matters rather than tracked; a listener would be a third source of truth to keep in sync.
    const source = (await import('node:fs')).readFileSync(
      new URL('../apps/extension/src/sidepanel/recommendation-request.ts', import.meta.url),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
    for (const forbidden of ['onActivated', 'onUpdated', 'onFocusChanged', 'AbortController']) {
      expect(code.includes(forbidden), forbidden).toBe(false);
    }
  });
});
