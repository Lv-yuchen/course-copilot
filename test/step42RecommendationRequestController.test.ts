/**
 * PART 16J-H-B2-A — the inert panel recommendation request controller.
 *
 * ## What is being proved
 *
 * The lifecycle rules that decide WHICH tab a recommendation is asked about and WHETHER an answer may still be applied. The controller
 * is driven directly here — `sidepanel.ts` does not import it — so every assertion is about the rules themselves, with the browser
 * transport faked and the controller itself production code.
 *
 * ## The three mechanisms, and the race each one covers
 *
 * - trigger-time query: a tab id read once at panel load goes stale on a tab switch, so a request could be sent about a page the user
 *   has left. Every trigger asks again.
 * - commit-time query: between sending and receiving the user can switch, and the answer describes the tab that WAS current.
 * - generation: the tab comparison cannot separate two requests for the SAME tab, so two rapid triggers would both look fresh and the
 *   slower answer could overwrite the faster one's.
 *
 * The races are driven with deferred promises, so "the older request finishes last" is arranged rather than hoped for.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createRecommendationRequestController, type RecommendationRequestState } from '../apps/extension/src/sidepanel/recommendation-request.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const controllerPath = join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'recommendation-request.ts');
const controllerSource = readFileSync(controllerPath, 'utf8');
const controllerCode = controllerSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

/** A canonical-looking result. Only its IDENTITY matters: the controller must publish it by reference. */
const RESULT = { recommendations: [], ratedButNotRecommended: [], considered: 3, excluded: [], insufficientData: [], ambiguousCandidates: [], preferences: {}, dataCoverage: null, meta: {} } as never;

/**
 * A canonical-looking page read status.
 *
 * Carried by every success state since 16J-PREUI-E4-C2-B2, because an empty result is only explainable beside the page it came from.
 */
const PAGE = { read: 'ok', supported: true, rowCount: 3, courseCount: 3, completeness: 'complete' } as never;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => {};
  let rejectFn: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => { resolveFn = res; rejectFn = rej; });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

interface HarnessOptions {
  /** Answers for successive trigger-time / commit-time queries, in call order. */
  readonly tabAnswers: Array<number | null | Error | Deferred<Array<{ id?: number }>>>;
  /** What `sendMessage` does, in call order. */
  readonly responses?: Array<unknown | Error | Deferred<unknown>>;
}

interface Harness {
  readonly request: () => Promise<void>;
  /** Every state the controller published, in order. */
  readonly states: RecommendationRequestState[];
  /** Every message the controller sent. */
  readonly sent: RuntimeMessage[];
  /** How many tab queries happened. */
  readonly queryCount: () => number;
}

function harness(options: HarnessOptions): Harness {
  const states: RecommendationRequestState[] = [];
  const sent: RuntimeMessage[] = [];
  let queryIndex = 0;
  let responseIndex = 0;

  const queryActiveTab = (): Promise<Array<{ id?: number }>> => {
    const answer = options.tabAnswers[queryIndex];
    queryIndex += 1;
    if (answer === undefined) return Promise.resolve([]);
    if (answer instanceof Error) return Promise.reject(answer);
    if (typeof answer === 'number' || answer === null) return Promise.resolve(answer === null ? [] : [{ id: answer }]);
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

  const controller = createRecommendationRequestController({
    sink: (state) => states.push(state),
    queryActiveTab,
    sendMessage,
  });

  return { request: controller.request, states, sent, queryCount: () => queryIndex };
}

describe('16J-H-B2-A a normal request reads the tab, asks, re-reads and publishes', () => {
  it('publishes loading then success, sent to the tab that was active at trigger time', async () => {
    const result = RESULT;
    const h = harness({ tabAnswers: [7, 7], responses: [{ ok: true, page: PAGE, result }] });
    await h.request();

    expect(h.states).toEqual([{ status: 'loading' }, { status: 'success', page: PAGE, result }]);
    // The exact shared request shape, and nothing else.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toEqual({ type: 'COURSE_COPILOT_QUERY_RECOMMENDATIONS', tabId: 7 });
    expect(Object.keys(h.sent[0] as object).sort()).toEqual(['tabId', 'type']);
    // Two queries: one to choose the tab, one to decide whether the answer may be applied.
    expect(h.queryCount()).toBe(2);
  });

  it('publishes the SAME result reference — no clone, no reshape', async () => {
    const result = RESULT;
    const h = harness({ tabAnswers: [1, 1], responses: [{ ok: true, page: PAGE, result }] });
    await h.request();
    const success = h.states[1] as { status: string; result: unknown };
    expect(success.result).toBe(result);
  });

  it('publishes the worker\'s own error text unchanged', async () => {
    const h = harness({ tabAnswers: [1, 1], responses: [{ ok: false, error: '推荐请求失败。' }] });
    await h.request();
    expect(h.states).toEqual([{ status: 'loading' }, { status: 'error', error: '推荐请求失败。' }]);
  });
});

describe('16J-H-B2-A trigger-time query decides the target', () => {
  it('a tab switch between requests retargets the SECOND request', async () => {
    /*
     * The A→B proof. A one-shot stored tab id would send the second request to A again.
     */
    const h = harness({ tabAnswers: [1, 1, 2, 2], responses: [{ ok: true, page: PAGE, result: RESULT }, { ok: true, page: PAGE, result: RESULT }] });
    await h.request();
    await h.request();
    expect(h.sent).toHaveLength(2);
    expect((h.sent[0] as { tabId: number }).tabId).toBe(1);
    expect((h.sent[1] as { tabId: number }).tabId).toBe(2);
    // Four queries: two per request. Nothing was reused.
    expect(h.queryCount()).toBe(4);
  });

  it('no usable tab publishes a bounded local error and sends nothing', async () => {
    for (const answer of [null, new Error('query failed')] as const) {
      const h = harness({ tabAnswers: [answer] });
      await h.request();
      expect(h.sent, String(answer)).toHaveLength(0);
      expect(h.states).toHaveLength(1);
      expect((h.states[0] as { status: string }).status).toBe('error');
    }
  });

  it('a non-integer tab id is treated as no tab', async () => {
    const h = harness({
      tabAnswers: [],
      responses: [],
    });
    // Build the harness by hand so the id can be fractional: `tabAnswers` only carries integers.
    const states: RecommendationRequestState[] = [];
    const sent: RuntimeMessage[] = [];
    const controller = createRecommendationRequestController({
      sink: (state) => states.push(state),
      queryActiveTab: () => Promise.resolve([{ id: 7.5 }]),
      sendMessage: (message) => { sent.push(message); return Promise.resolve({ ok: true, page: PAGE, result: RESULT }); },
    });
    await controller.request();
    void h;
    expect(sent).toHaveLength(0);
    expect((states[0] as { status: string }).status).toBe('error');
  });
});

describe('16J-H-B2-A commit-time query decides whether an answer may be applied', () => {
  it('a tab switch during the request reports STALE and commits no answer', async () => {
    /*
     * CHANGED IN 16J-PREUI-E4-C2-B2. This used to expect the answer to add NOTHING, which was right while a silent discard was the only safe option: a
     * stale answer that tidied up after itself could wipe the loading state of the request that replaced it.
     *
     * The gap that left is the one this step closes. When the generation is still CURRENT, nothing replaced this attempt — so silence leaves `loading`
     * on screen forever. The distinction the freshness check now makes is between "something newer took over" (write nothing) and "this is still the
     * live attempt and its page is gone" (write exactly one stale outcome).
     */
    const h = harness({ tabAnswers: [1, 2], responses: [{ ok: true, page: PAGE, result: RESULT }] });
    await h.request();
    expect(h.states).toEqual([{ status: 'loading' }, { status: 'stale', reason: 'tab_changed' }]);
    // And never as a success: the answer describes a page the user has left.
    expect(h.states.some((state) => state.status === 'success')).toBe(false);
  });

  it('a switch also reports STALE for a FAILURE answer — a stale error is never an error', async () => {
    const h = harness({ tabAnswers: [1, 2], responses: [{ ok: false, error: '推荐请求失败。' }] });
    await h.request();
    expect(h.states).toEqual([{ status: 'loading' }, { status: 'stale', reason: 'tab_changed' }]);
    // A tab change is not a broken run, so the worker's error text must not be published as one.
    expect(h.states.some((state) => state.status === 'error')).toBe(false);
  });

  it('a send rejection is a panel-local failure, not canonical insufficientData', async () => {
    const h = harness({ tabAnswers: [3, 3], responses: [new Error('no receiver')] });
    await h.request();
    expect(h.states).toHaveLength(2);
    expect((h.states[1] as { status: string; error: string }).status).toBe('error');
    // A local text, NOT a canonical result: the worker never answered, so there is nothing to degrade.
    expect((h.states[1] as { error: string }).error).not.toContain('insufficient');
  });

  it('a send rejection on a tab the user has left is STALE, not an error', async () => {
    const h = harness({ tabAnswers: [3, 9], responses: [new Error('no receiver')] });
    await h.request();
    expect(h.states).toEqual([{ status: 'loading' }, { status: 'stale', reason: 'tab_changed' }]);
  });
});

describe('16J-H-B2-A generation is what resolves a SAME-tab race', () => {
  it('the older request finishing last writes nothing', async () => {
    /*
     * Both requests target tab 5, so the commit-time tab comparison is TRUE for both and cannot separate them. Only the generation can.
     */
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const h = harness({
      // #1: trigger 5, commit 5. #2: trigger 5, commit 5.
      tabAnswers: [5, 5, 5, 5],
      responses: [first, second],
    });

    const startedFirst = h.request();
    const startedSecond = h.request();

    // #2 finishes first and is the newest, so it is applied.
    second.resolve({ ok: true, page: PAGE, result: RESULT });
    await startedSecond;
    expect(h.states).toContainEqual({ status: 'success', page: PAGE, result: RESULT });

    // Now the older one lands. It must add NOTHING — and it must not even run its commit-time query.
    const before = h.states.length;
    const queriesBefore = h.queryCount();
    first.resolve({ ok: true, page: PAGE, result: { ...(RESULT as object), stale: true } as never });
    await startedFirst;

    expect(h.states.length, 'stale answer wrote state').toBe(before);
    // It stopped at the generation check, before the commit-time query: that is the cheapest early exit, and it proves the generation
    // is what discarded it rather than the tab comparison (which would have passed).
    expect(h.queryCount()).toBe(queriesBefore);
  });
});

describe('16J-H-B2-A malformed responses never reach the UI as an exception', () => {
  it('a non-response becomes a bounded local error', async () => {
    for (const response of [null, undefined, 'x', 42, {}, { ok: 'yes' }]) {
      const h = harness({ tabAnswers: [1, 1], responses: [response] });
      await h.request();
      const last = h.states[h.states.length - 1] as { status: string; error?: string };
      expect(last.status, JSON.stringify(response)).toBe('error');
      // A bounded text, not a stringified object.
      expect((last.error ?? '').length, JSON.stringify(response)).toBeLessThan(40);
    }
  });

  it('an ok:false without a usable message still yields a bounded text', async () => {
    const h = harness({ tabAnswers: [1, 1], responses: [{ ok: false }] });
    await h.request();
    const last = h.states[h.states.length - 1] as { status: string; error: string };
    expect(last.status).toBe('error');
    expect(typeof last.error).toBe('string');
  });
});

describe('16J-H-B2-A the module stays inside its scope', () => {
  it('uses double requery plus generation, with no browser lifecycle machinery', () => {
    for (const forbidden of ['AbortController', 'onActivated', 'onUpdated', 'onFocusChanged', 'addEventListener', 'signal']) {
      expect(controllerCode.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('keeps no cached DATA but the generation counter and the current tab pointer', () => {
    /*
     * UPDATED IN PRE-RELEASE-UX-A18. This used to forbid every remembered identifier, including `lastTabId`, on the grounds that caching a tab id
     * would reintroduce the staleness the double query exists to remove. Adding the preference editor forced the question, and the answer is that the
     * two are different facts:
     *
     *   - Caching a tab id to decide whether an answer is still FRESH is what the rule forbids, and that is unchanged: `freshnessOf` still re-queries
     *     the active tab and compares, so a remembered id can never make a stale answer look current.
     *   - Remembering which page the CURRENT result describes is a different statement, and the weight-change action needs it: re-ranking must target
     *     the page the user prepared, and falling back to the active tab would rank a page they never approved.
     *
     * So the DATA rules are asserted unchanged, and the one allowed pointer is named along with its type.
     */
    for (const forbidden of ['cachedTabId', 'currentTabId', 'cachedResult', 'cachedRows', 'cachedCourses']) {
      expect(controllerCode.includes(forbidden), forbidden).toBe(false);
    }
    /*
     * `let` at two spaces of indentation is MODULE scope inside the factory — the only place persistent state could live. A `let` deeper in (like the per-attempt `response`) is scoped to one request and disappears with it. Checking indentation is what makes this assertion about persistence rather than about the keyword.
     */
    const moduleLevel = [...controllerCode.matchAll(/^  let (\w+)/gmu)].map((m) => m[1]);
    expect(moduleLevel).toEqual(['generation', 'lastTabId']);
    // The pointer holds a NUMBER and nothing else: no result, no rows and no courses travel with it.
    expect(/let lastTabId: number \| null = null;/u.test(controllerCode)).toBe(true);
  });

  it('uses the shared request and response types without redeclaring the shape', () => {
    expect(controllerCode.includes('QueryRecommendationsRequest')).toBe(true);
    // No local restatement of the response union.
    expect(controllerCode.includes('ok: true;')).toBe(false);
    expect(controllerCode.includes('ok: false;')).toBe(false);
  });

  it('owns its state type locally: it is panel lifecycle, not a cross-boundary contract', () => {
    /*
     * The split this asserts: the MESSAGE contract is shared ambient because it crosses a runtime boundary; the panel's own STATE is
     * exported from the controller because it does not. Promoting it into `chrome.d.ts` would make a private rendering concern a
     * contract visible to the whole extension.
     */
    expect(/export type RecommendationRequestState =/u.test(controllerCode)).toBe(true);
    const chromeDts = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'types', 'chrome.d.ts'), 'utf8');
    expect(chromeDts.includes('RecommendationRequestState')).toBe(false);
    // The shared message contract stays where it belongs.
    expect(chromeDts.includes('type QueryRecommendationsRequest =')).toBe(true);
    expect(chromeDts.includes('type QueryRecommendationsResponse =')).toBe(true);
    // And the state union is exactly four arms, with no extra fields.
    const union = /export type RecommendationRequestState =([\s\S]*?tab_changed' \};)/u.exec(controllerCode)?.[1] ?? '';
    /*
     * UPDATED IN 16J-PREUI-E4-C2-B2: `stale` joined the union, so three became four. It is its own arm rather than a flavour of `error` because a tab
     * change is not a broken run — the answer was computed correctly for the page it was asked about, and that page simply is not the one on screen.
     */
    expect([...union.matchAll(/status: '(\w+)'/gu)].map((m) => m[1])).toEqual(['loading', 'success', 'error', 'stale']);
    expect(union.includes('result: RecommendationResult')).toBe(true);
    expect(union.includes('page: PageReadStatus')).toBe(true);
    expect(union.includes('error: string')).toBe(true);
    expect(union.includes("reason: 'tab_changed'")).toBe(true);
    /*
     * `stale` must carry a REASON and nothing else: a result that arrives stale must not be readable as current by any consumer.
     */
    const staleArm = /status: 'stale'[\s\S]*?\}/u.exec(union)?.[0] ?? '';
    expect(staleArm).not.toContain('result');
    expect(staleArm).not.toContain('page');
    for (const forbidden of ['preferences', 'weights', 'tabId', 'generation', 'expanded', 'competition', 'sort']) {
      expect(union.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('sidepanel drives exactly ONE recommendation controller, through the hardened path', () => {
    const panel = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');
    /*
     * UPDATED IN 16J-PREUI-E3-C, then AGAIN IN 16J-PREUI-E4-C2-B3-A.
     *
     * The E3-C version required zero `addEventListener` calls and no `<button>`, which held only while the panel had no interactive control at all. That was
     * replaced by the narrower statement that the panel did not import the recommendation controller — which held while the controller was inert.
     *
     * It is wired now: the panel owns one instance and one request path, and that IS the delivery. What still protects the design is asserted instead: exactly one
     * instance, the request reached only through the expected-tab argument, and still exactly one runtime listener.
     */
    expect([...panel.matchAll(/createRecommendationRequestController\(/gu)]).toHaveLength(1);
    expect(panel).toContain('recommendation.request(expectedTabId)');
    expect([...panel.matchAll(/chrome\.runtime\.onMessage\.addListener/gu)]).toHaveLength(1);
    /*
     * UPDATED IN 16J-PREUI-E4-C2-A. The panel's one interactive control is now the unified data-preparation action, which replaced the separate
     * auto-load action. The FEATURE name changed; what this case protects did not, so the control is named for what it is today rather than deleted.
     */
    expect(panel.includes('full-preparation-start')).toBe(true);
    const html = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'sidepanel.html'), 'utf8');
    /*
     * UPDATED IN PRE-RELEASE-UX-A13, from a bare count of two to the exact set of three.
     *
     * The third control is the rated section's collapse toggle, which was added deliberately. A bare `toHaveLength(3)` would also pass if a second "generate
     * recommendation" entry point replaced one of the two existing buttons, so each is now named by its own id: exactly one preparation start, one cancel, and one
     * disclosure control — and no fourth button.
     */
    const buttons = [...html.matchAll(/<button[^>]*id="([^"]+)"/gu)].map((match) => match[1]);
    expect(buttons.sort()).toEqual(['full-preparation-cancel', 'full-preparation-start', 'preferences-apply', 'preferences-reset', 'rated-toggle']);
    /*
         * UPDATED IN PRE-RELEASE-UX-A18. This banned every `<input>`, which held while the panel had no form control at all. The preference editor now
         * has four, so the rule is restated as what it protected: the document carries no input that could SUBMIT anything or name a value the extension
         * would send as a page operation. Every input is a range slider with the frozen 0..10 bounds, and there are exactly as many as there are controls.
         */
        const inputs = [...html.matchAll(/<input[^>]*>/gu)].map((match) => match[0]);
        expect(inputs).toHaveLength(4);
        for (const input of inputs) {
          expect(input).toContain('type="range"');
          expect(input).toContain('min="0"');
          expect(input).toContain('max="10"');
          expect(input).toContain('step="1"');
        }
        for (const forbidden of ['type="text"', 'type="submit"', 'type="hidden"', 'type="file"', 'type="password"']) {
          expect(html.includes(forbidden), forbidden).toBe(false);
        }
  });
});
