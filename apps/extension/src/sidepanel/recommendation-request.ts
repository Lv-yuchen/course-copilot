/// <reference path="../types/chrome.d.ts" />
/// <reference path="../types/recommendation-types.d.ts" />

/**
 * The side panel's recommendation request lifecycle, as a controller the panel does not use yet.
 *
 * ## What this is
 *
 * The logic that decides WHICH tab a recommendation is asked about and WHETHER an answer may still be applied. It is deliberately
 * separated from any rendering: it takes a sink callback and never touches the DOM, so the UI batch can attach a button and a view to
 * an already-verified lifecycle instead of having the rules invented alongside a button.
 *
 * It is INERT in production: `sidepanel.ts` does not import it, so nothing sends a recommendation request today.
 *
 * ## The three mechanisms, and why each is needed
 *
 * - **trigger-time query** decides who the request is FOR. A tab id read once at panel load goes stale the moment the user switches
 *   tabs, and the failure is not a cosmetic one: the request would be sent about a page the user is no longer looking at. Nothing is
 *   cached between triggers, so every trigger asks the browser again.
 * - **commit-time query** decides whether an answer may still be APPLIED. Between sending and receiving, the user can switch tabs, and
 *   the answer describes the tab that was current when the request started.
 * - **generation** decides which request may write. The commit-time tab comparison cannot distinguish two requests for the SAME tab, so
 *   two rapid triggers on one tab would both look fresh and the slower one could overwrite the faster one's answer.
 *
 * ## What is deliberately absent
 *
 * No `AbortController`, and no `tabs.onActivated` / `onUpdated` / `windows.onFocusChanged`. A sent `chrome.runtime.sendMessage` cannot
 * be cancelled: the worker's pipeline runs to completion regardless. An abort signal here could therefore only stop the panel from
 * waiting, while making it LOOK like the request had been cancelled — and the message contract has no field to carry one anyway. Tab
 * listeners are the other tempting answer, and they would turn a fact that can be asked for at the two moments it matters into a state
 * that must be kept in sync across three event sources; each missed or late event would leave the panel confidently wrong about the
 * active tab.
 *
 * ## The stale rule
 *
 * Once a response is judged stale, this module writes NOTHING — it does not clear `loading`, does not write `idle`, does not write an
 * error and does not clear a result. A stale answer that tidied up after itself would wipe the `loading` state of the request that
 * replaced it, which is exactly the bug the rule exists to prevent. A `loading` state that outlives its request is a known UX backlog
 * item, to be handled by a tab-lifecycle decision later rather than by letting a stale response write.
 *
 * @module
 */

/**
 * One state this controller publishes to the panel.
 *
 * ## Why this type lives HERE and not in `chrome.d.ts`
 *
 * It is PANEL-LOCAL lifecycle state. It never crosses a worker, content-script or message boundary, and it is not part of the Chrome API
 * surface — so putting it in the ambient declarations would promote a private rendering concern into a contract visible to the whole
 * extension. The split is deliberate and mirrors the one established for the message contract:
 *
 * - `QueryRecommendationsRequest` / `QueryRecommendationsResponse` — SHARED ambient, in `chrome.d.ts`, because they cross a boundary;
 * - `RecommendationRequestState` — panel-local, exported from this module, because it does not.
 *
 * ## Why `error` is not "no result"
 *
 * `ok: false` means the run itself broke, outside everything the canonical pipeline degrades. A course with no usable reviews is NOT
 * that: it arrives as `ok: true` carrying a canonical result whose `insufficientData` lists it. Collapsing the two would tell a reader
 * something is broken when the honest answer is "there is nothing to rank".
 *
 * ## Why `success` carries the page
 *
 * `page` is the input-side half of the worker's answer, and it is what makes an EMPTY result explainable. Without it the panel sees
 * `recommendations: []` and cannot tell an unsupported tab from a failed read from a page that genuinely lists no courses — and it would
 * have to guess, or say "no reviews", which is a false statement about the world in two of those three cases. The state therefore keeps the
 * worker's own `PageReadStatus` rather than restating or re-deriving any part of it.
 *
 * ## Why `stale` is its own arm and not a flavour of `error`
 *
 * A tab change is not a failure of the request: the answer was computed correctly for the page it was asked about, and that page is simply
 * no longer the one the user is looking at. Reporting it as an error would claim something broke, and reporting it as success would attribute
 * one page's rankings to another. It is also not `loading` — leaving `loading` standing forever, which is what a silent discard used to do, is
 * exactly the bug this arm exists to fix.
 *
 * `stale` carries only a REASON, never a result: a result that arrives stale must not be readable as current by any consumer.
 *
 * ## What `stale` must never be used for
 *
 * It is for a changed tab and nothing else. An unavailable review source, partially hydrated teacher data, low confidence and thin evidence are
 * all ordinary outcomes that travel inside `success.page` or `success.result`; calling any of them "stale" would collapse four different facts
 * into one word and hide which of them actually happened.
 *
 * ## What is deliberately absent
 *
 * No preferences, weights, expanded-evidence, competition or sorting state: a copy here would be a second source of truth for data the
 * canonical result already carries. `loading` carries nothing on purpose — the tab a request is loading for is decided per request and
 * never cached, so there is no id worth publishing.
 */
export type RecommendationRequestState =
  | { readonly status: 'loading' }
  | { readonly status: 'success'; readonly page: PageReadStatus; readonly result: RecommendationResult }
  | { readonly status: 'error'; readonly error: string }
  | { readonly status: 'stale'; readonly reason: 'tab_changed' };

/** The generic error text used when the request could not even be made, or the answer was unusable. */
const LOCAL_FAILURE_TEXT = '无法获取推荐：当前标签页不可用。';
/** The text used when the runtime boundary answered with something that is not the shared response shape. */
const MALFORMED_RESPONSE_TEXT = '无法获取推荐：响应格式异常。';

/** What the controller needs from its host. */
export interface RecommendationRequestControllerOptions {
  /** Receives every state the controller decides to publish. Never called for a stale answer. */
  readonly sink: (state: RecommendationRequestState) => void;
  /** The tab query, injectable so the lifecycle can be tested without a browser. Defaults to `chrome.tabs.query`. */
  readonly queryActiveTab?: () => Promise<Array<{ id?: number }>>;
  /** The message sender, injectable for the same reason. Defaults to `chrome.runtime.sendMessage`. */
  readonly sendMessage?: (message: RuntimeMessage) => Promise<unknown>;
}

/** The controller's only published capability. */
export interface RecommendationRequestController {
  /**
   * Ask for a recommendation, optionally for a tab the caller has already approved, optionally with the user's own weights.
   *
   * ## The two modes
   *
   * **Without `expectedTabId`** the request is for whichever tab is active now, read at trigger time. That is the standalone behaviour and is
   * unchanged: the panel is asking about whatever the user is looking at.
   *
   * **With `expectedTabId`** the request is bound to that tab and NOTHING else. This is the preparation-handoff mode, and it exists because the
   * two modes answer different questions. A preparation finishes against a specific tab; if the user has since switched away, the honest response
   * is "this result belongs to a page you have left" — never a fresh request aimed at the tab that happens to be in front, which would read a
   * different page's courses and query a review source about them.
   *
   * The binding is enforced in both directions: an active tab that no longer matches is reported as stale BEFORE anything is sent, and a change
   * after sending is reported as stale instead of being committed. The target never migrates.
   *
   * ## Preferences
   *
   * `preferences` is the four importance weights the panel's sliders hold, and it travels on the SAME request as everything else. Two reasons it
   * is not a separate message: the freshness machinery below is precisely what a re-rank needs — the answer must be superseded if the user
   * switches tabs mid-flight, and the generation counter is what makes a slow first run unable to overwrite a newer one — and a second channel
   * would need its own copy of all of it.
   *
   * Omitting it is the same statement as never having opened the editor: the engine falls back to the host's default weighting. This method does
   * NOT validate the numbers; the engine's `normalizePreferences` is the authority on what a weight vector means.
   *
   * Resolves when the attempt is finished, whatever the outcome. It never rejects: a failure is published through the sink, and a superseded
   * attempt is published nowhere.
   */
  readonly request: (expectedTabId?: number, preferences?: QueryRecommendationsRequest['preferences']) => Promise<void>;
  /**
   * The tab the current answer describes, or `null` before any attempt.
   *
   * The page a weight change must re-rank. Read-only, and deliberately NOT used to decide freshness — that still re-queries the active tab, which is what
   * stops a remembered id from making a stale answer look current.
   */
  readonly tabId: () => number | null;
}

/**
 * Create the recommendation request controller.
 *
 * @param options - the sink and, for tests, injectable transport seams.
 * @returns the controller.
 */
export function createRecommendationRequestController(
  options: RecommendationRequestControllerOptions,
): RecommendationRequestController {
  const { sink } = options;
  const queryActiveTab = options.queryActiveTab ?? (() => chrome.tabs.query({ active: true, currentWindow: true }));
  const sendMessage = options.sendMessage ?? ((message: RuntimeMessage) => chrome.runtime.sendMessage(message));

  /*
   * THE ONLY PERSISTENT STATE.
   *
   * A request id, not a record: no tab id, no result, no rows and no courses live here. Caching a result would give the panel a second
   * source of truth for data the worker already owns, and caching a tab id would reintroduce the exact staleness the double query
   * exists to remove.
   */
  let generation = 0;

  /**
   * The tab the most recent attempt was for, or `null` before any attempt.
   *
   * ## Why this is remembered when the doc above says nothing about a tab id is
   *
   * The comment on {@link generation} is about not caching a tab to AVOID the double query — it forbids using a remembered id to decide whether an answer
   * is still fresh, and that rule is unchanged: freshness is still decided by re-querying the active tab.
   *
   * What this holds is a different fact, added in PRE-RELEASE-UX-A18: which page the CURRENT result describes. A weight change re-ranks the page the user
   * already prepared, and it must not migrate to whatever is in front now — that would rank a different page's courses and present them as the ones the
   * user was looking at. The controller is the only component that knows the tab a result belongs to, so it is the honest place to ask.
   */
  let lastTabId: number | null = null;

  /** Read the active tab's id, or `null` when there is no usable one. Never throws. */
  async function readActiveTabId(): Promise<number | null> {
    try {
      const tabs = await queryActiveTab();
      const first = Array.isArray(tabs) ? tabs[0] : undefined;
      const id = first?.id;
      // Integer only: the transport applies the same rule, and a fractional id names no tab the browser can be asked about.
      return typeof id === 'number' && Number.isInteger(id) ? id : null;
    } catch {
      // A failed query is "no tab can be named", not an exception for the caller to handle.
      return null;
    }
  }

  /**
   * Decide whether an answer for `requestTabId` may still be applied.
   *
   * Both conditions are required, and they mean DIFFERENT things to the caller:
   *
   * - a **generation** mismatch means a newer request has superseded this one, so this attempt is not merely stale but IRRELEVANT — it must write
   *   nothing at all, because anything it wrote could land on top of the newer attempt's state;
   * - a **tab** mismatch with the generation still current means this attempt is the live one and its answer describes a page the user has left, which
   *   is a real outcome the panel has to show.
   *
   * `'superseded'` and `'stale'` are therefore separate verdicts rather than one boolean. Collapsing them would either resurrect a superseded
   * attempt's writes or silently swallow a live attempt's tab change.
   */
  async function freshnessOf(myGeneration: number, requestTabId: number): Promise<'fresh' | 'stale' | 'superseded'> {
    if (myGeneration !== generation) return 'superseded';
    const activeTabNow = await readActiveTabId();
    // Re-check the generation: the query above is asynchronous, so a trigger can have happened while it was in flight.
    if (myGeneration !== generation) return 'superseded';
    return activeTabNow !== null && activeTabNow === requestTabId ? 'fresh' : 'stale';
  }

  /** Publish the stale outcome, but only for an attempt that is still the live one. */
  function publishStale(myGeneration: number): void {
    if (myGeneration === generation) sink({ status: 'stale', reason: 'tab_changed' });
  }

  return {
    tabId: (): number | null => lastTabId,
    request: async (expectedTabId?: number, preferences?: QueryRecommendationsRequest['preferences']): Promise<void> => {
      /*
       * The id is taken SYNCHRONOUSLY, before the first await, so a second trigger arriving in the same tick cannot race this one onto
       * the same id.
       */
      generation += 1;
      const myGeneration = generation;

      let requestTabId: number | null;
      if (expectedTabId === undefined) {
        // Standalone mode: ask about whatever is in front now. Nothing is remembered between triggers.
        requestTabId = await readActiveTabId();
      } else {
        /*
         * HANDOFF MODE. The caller has already approved this tab, so it is the target — but the target is checked BEFORE anything is sent, and a
         * mismatch ends the attempt here.
         *
         * The preflight is the point of this mode, not a redundant second check. Without it the panel would still send a recommendation request to
         * a tab the user had left; the commit-time guard cannot prevent that, because by then the request has already read someone else's page and
         * queried a review source about its courses.
         */
        requestTabId = expectedTabId;
        const activeTabNow = await readActiveTabId();
        // A newer trigger took over while the query was in flight: this attempt is no longer anyone's, so it writes nothing.
        if (myGeneration !== generation) return;
        if (activeTabNow !== requestTabId) {
          publishStale(myGeneration);
          return;
        }
      }

      if (requestTabId === null) {
        /*
         * Nothing can be asked, but the answer still has to be the CURRENT one's: the query above awaited, so a newer trigger may
         * already have started, and writing here would clobber its state.
         */
        if (myGeneration === generation) sink({ status: 'error', error: LOCAL_FAILURE_TEXT });
        return;
      }

      /*
       * Recorded once the target is settled, so `tabId()` names the page THIS attempt is about even if the user switches away mid-flight. A
       * superseded or stale attempt does not get to overwrite it: the guard below is the one that lets a newer attempt claim the slot.
       */
      if (myGeneration === generation) lastTabId = requestTabId;

      sink({ status: 'loading' });

      let response: unknown;
      try {
        // The shared request shape, and nothing else: the worker owns the provider and the policy.
        // The tab is `requestTabId` as decided above and is NEVER re-read here — that is what stops the target from migrating after approval.
        /*
         * `preferences` is spread conditionally so an absent one stays ABSENT rather than present-and-undefined: "the user has expressed no
         * preference" and "the user sent an empty object" are different statements, and only the first is what a default run means.
         */
        const request: QueryRecommendationsRequest = {
          type: 'COURSE_COPILOT_QUERY_RECOMMENDATIONS',
          tabId: requestTabId,
          ...(preferences === undefined ? {} : { preferences }),
        };
        response = await sendMessage(request);
      } catch {
        /*
         * A rejected `sendMessage` is a PANEL-LOCAL failure, not a canonical `insufficientData`: the worker never answered, so there is
         * no result to degrade. It still goes through the freshness check first, so a superseded or stale failure does not write.
         */
        const verdict = await freshnessOf(myGeneration, requestTabId);
        if (verdict === 'fresh') sink({ status: 'error', error: LOCAL_FAILURE_TEXT });
        if (verdict === 'stale') publishStale(myGeneration);
        return;
      }

      /*
       * THE FRESHNESS RULE.
       *
       * `superseded` writes NOTHING — not an error, not `stale`, and it does not clear `loading`, because clearing it would wipe the `loading`
       * state of the attempt that replaced this one.
       *
       * `stale` writes exactly one thing: the stale outcome. The answer was computed for a page the user has left, so committing it would attribute
       * one page's rankings to another; and staying silent would leave `loading` on screen forever, which is the state this arm exists to end.
       */
      const verdict = await freshnessOf(myGeneration, requestTabId);
      if (verdict === 'superseded') return;
      if (verdict === 'stale') {
        publishStale(myGeneration);
        return;
      }

      /*
       * Shape-checked at runtime as well as by type: the response crosses a process boundary, so it is DATA, not a guarantee. The
       * fields are read through a widened view for the same reason, then narrowed before use.
       */
      const answer = typeof response === 'object' && response !== null
        ? (response as { ok?: unknown; result?: unknown; page?: unknown; error?: unknown })
        : null;
      if (answer === null || typeof answer.ok !== 'boolean') {
        sink({ status: 'error', error: MALFORMED_RESPONSE_TEXT });
        return;
      }
      if (answer.ok) {
        /*
         * BOTH halves are required. A success without a page cannot explain an empty result, and a success without a result is not a success — so an
         * incomplete one is reported as malformed rather than committed as though the missing half were absent-by-design.
         *
         * The page is checked for the fields the contract promises and NOT re-derived: `completeness`, `rowCount` and `courseCount` are the worker's
         * own readings, and recomputing any of them here would create a second opinion about a page this layer has never seen.
         */
        if (!isPageReadStatus(answer.page) || answer.result === undefined) {
          sink({ status: 'error', error: MALFORMED_RESPONSE_TEXT });
          return;
        }
        /*
         * Published by REFERENCE: no clone, no reshape, no serialization — the worker's page and result are the page and result. The cast is the
         * runtime check above plus the shared union's guarantee; a field-by-field copy here is exactly what would make the panel's data drift
         * from the canonical shape.
         */
        sink({ status: 'success', page: answer.page, result: answer.result as RecommendationResult });
        return;
      }
      // The worker's own bounded text is shown as it arrived; the panel does not invent a replacement.
      sink({ status: 'error', error: typeof answer.error === 'string' ? answer.error : MALFORMED_RESPONSE_TEXT });
    },
  };
}

/**
 * Whether a value is the shared {@link PageReadStatus} shape.
 *
 * The same structural check the transport applies to the same object, because it crosses the same boundary: a reply is data, not a guarantee. Only the
 * fields the panel will read are required; `supported` and `loadState` are legitimately absent on some reads.
 *
 * @param value - the candidate.
 * @returns whether it can be used as a page read status.
 */
function isPageReadStatus(value: unknown): value is PageReadStatus {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { read?: unknown; rowCount?: unknown; courseCount?: unknown; completeness?: unknown };
  if (record.read !== 'ok' && record.read !== 'unavailable' && record.read !== 'malformed') return false;
  if (typeof record.rowCount !== 'number' || typeof record.courseCount !== 'number') return false;
  return record.completeness === 'partial' || record.completeness === 'complete' || record.completeness === 'unknown';
}
