/**
 * Course Copilot — minimal MV3 service worker.
 *
 * ## Responsibilities
 *
 * 1. Open the side panel when the toolbar icon is clicked.
 * 2. Hold what the content script reports — page identity and a course-panel count — **in memory only**, and relay it to
 *    the side panel.
 *
 * ## Why the status is held here at all
 *
 * The content script may report before the panel exists. Holding the values lets a panel opened later learn them without the
 * page having to reload. They are kept in memory deliberately: they describe the current browsing session, so persisting them
 * would mean showing a stale answer after a restart.
 *
 * ## What this file does not do
 *
 * No `chrome.storage`, no database, no state projection, no network request. The only information it handles is a boolean, a
 * number, and the message type they arrived with. It never inspects a page.
 *
 * ## The one core import, and why it exists
 *
 * `availabilityFromSeats` is imported and CALLED once, to prove that a real `@course-copilot/core` function survives bundling
 * and executes inside the shipped worker. That is the entire purpose: it is a build-level capability proof, not a feature.
 *
 * It is called rather than merely imported because an unused import is dead code that a bundler may legitimately remove, which
 * would let "the source imports core" stand in for "the artifact contains core" — a claim this project has already been burned
 * by once. The result is consumed by a comparison that throws, so the call cannot be elided either.
 *
 * The probe is deterministic and side-effect-free: no network, no DOM, no storage, no clock, no randomness, no user data. Its
 * result is never returned to the panel or to any message response, and no message type was added for it.
 *
 * ## What the file imports
 *
 * Three module-level imports, all browser-safe and all bundleable by esbuild: a core eligibility function for the probe above, the
 * provider package, and the worker's own in-memory cache. There is no `node:` built-in, no `TtlCache`, and no Node factory — the
 * Node host's pieces stay out of the worker by construction, because the cache is supplied explicitly rather than defaulted.
 *
 * ## Why everything is wrapped in a function
 *
 * The body stays inside one function so its bindings cannot collide with identically named ones elsewhere. The import above is
 * module-level because that is where imports belong — and this entry is allowed module syntax, since its manifest entry declares
 * `type: "module"`.
 */
import { availabilityFromSeats } from '@course-copilot/core/eligibility';
import type { RawReviewRow } from '@course-copilot/core/course';
import { WhuCoursesProvider } from '@course-copilot/provider';
import { MemoryCache } from './memory-cache.js';
import { guardedPublicReviewFetch } from './public-review-fetch.js';
import { EXTENSION_RECOMMENDATION_POLICY } from './recommendation-policy.js';
import { requestVisibleRecommendations } from './visible-recommendations.js';
import { FORWARDED_TYPES, forwardAutoExpandMessage } from './auto-expand-forward.js';
import { TEACHER_HYDRATION_FORWARDED_TYPES, forwardTeacherHydrationMessage } from './teacher-hydration-forward.js';
import { AVAILABILITY_FILTER_FORWARDED_TYPES, forwardAvailabilityFilterMessage } from './availability-filter-forward.js';
import { PREPARATION_FORWARDED_TYPES, forwardPreparationMessage } from './preparation-forward.js';

/*
 * ============================================================================================================================
 * THE REVIEW CACHE AND PROVIDER
 * ============================================================================================================================
 *
 * ## What is wired here, and what is deliberately NOT
 *
 * A cache and a provider are constructed, once, at module scope, and the provider is given the guarded public-review `fetch` rather
 * than the ambient one. **Nothing queries them yet.** No `searchCourse`, no request to `whucourses.cn`, and no message type was
 * added to expose them. This step establishes the runtime wiring and the outbound boundary; actually asking the site a question is
 * a later, separate decision.
 *
 * That separation is why the construction is proved with a purely local, deterministic check rather than by making a call.
 *
 * ## Lifetime: one pair per worker instance
 *
 * Both bindings live at MODULE scope, so each worker instance constructs exactly one cache and one provider. Nothing constructs
 * either per message — a per-message provider would throw away the cache on every call and quietly turn a 6-hour policy into
 * nothing.
 *
 * The honest limit of that: a Manifest V3 worker is suspended and restarted by the browser, so "module scope" means "this worker
 * instance", not "until the cache expires". The TTL bounds how stale a value may be; it does not promise the worker lives that
 * long. This is also why the cache is memory-only — a restarted worker starts empty rather than reading back a value it can no
 * longer vouch for.
 *
 * ## The TTL policy, and why it is chosen here
 *
 * Six hours, matching the Node host's review cache. The two hosts read the SAME public review data, so letting them disagree about
 * freshness would mean the same question answered differently depending on where it was asked. The constant is extension-local
 * and deliberately not imported from the application's `src/config.ts`: the extension is a separate host with its own bundle
 * boundary, and reaching into the application's source for a number would couple them for nothing.
 */
const REVIEW_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** The worker's single review cache. Memory-only, expiring lazily; nothing persists it. */
const reviewCache = new MemoryCache<RawReviewRow[]>({ ttlMs: REVIEW_CACHE_TTL_MS });

/**
 * The worker's single review provider.
 *
 * `origin` is left at the provider's own default, because the provider is the module that owns where reviews come from. `fetchImpl`
 * is supplied EXPLICITLY as the guarded boundary rather than left to default to the ambient `fetch`: the default would be an
 * unrestricted fetch, and the whole point of this step is that no request can leave the worker without passing the allowlist.
 *
 * The cache is supplied because the provider deliberately refuses to default it.
 *
 * Constructing a provider performs no I/O — it assigns fields — so nothing here reaches the network, with or without the guard.
 */
const reviewProvider = new WhuCoursesProvider({
  cache: reviewCache,
  fetchImpl: guardedPublicReviewFetch as unknown as typeof fetch,
});

/*
 * The wiring proof.
 *
 * It reads a real value off the constructed provider and throws unless the result is the contract's initial counters. A cache that
 * had already been written to, or one reporting itself `disabled`, would mean the wiring is not what this file claims.
 *
 * ## What this does NOT claim
 *
 * It is tempting to say the read stops the wiring from being tree-shaken. That was TESTED rather than assumed, and it is false
 * here: esbuild keeps a top-level `new WhuCoursesProvider(...)` whether or not anything reads the result, because a constructor
 * call may have side effects and the bundler will not remove it on speculation. The read is a CORRECTNESS check, not an
 * anti-elision guard.
 *
 * What actually binds the wiring into the artifact is a structural assertion on the bundle — exactly one `new WhuCoursesProvider(`
 * and one `new MemoryCache(` survive into `background/service-worker.js`, alongside the provider's real review logic. That check
 * fails if the construction is removed.
 */
const initialCacheStats = reviewProvider.cacheStats;
if (
  initialCacheStats.hits !== 0
  || initialCacheStats.misses !== 0
  || initialCacheStats.writes !== 0
  || initialCacheStats.disabled !== false
) {
  throw new Error(`review provider wiring 失败：初始 cacheStats 为 ${JSON.stringify(initialCacheStats)}`);
}

/*
 * ============================================================================================================================
 * THE EXTENSION'S OWN RECOMMENDATION POLICY
 * ============================================================================================================================
 *
 * The policy is carried here exactly as the engine is: present in the artifact, and not yet used. Nothing passes it to
 * `recommendCourses`, because executing a recommendation needs visible rows and is a later, separate decision.
 *
 * ## What the invariant below is, and what it is not
 *
 * It is a HOST CONFIGURATION sanity check: the numbers this host chose are the shape they claim to be. It is not a re-implementation
 * of the engine's preference normalization, and it deliberately does not touch `core` for that — normalizing weights is the engine's
 * job, and repeating it here would create a second place for the same rule to live.
 *
 * It reads only its own frozen constants: no network, no DOM, no recommendation call.
 */
{
  const policy = EXTENSION_RECOMMENDATION_POLICY;
  const positives: Array<[string, number]> = [
    ['defaultTopN', policy.defaultTopN],
    ['maxTopN', policy.maxTopN],
    ['candidateLimit', policy.candidateLimit],
  ];
  for (const [name, value] of positives) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`recommendation policy 非法：${name} = ${String(value)}（应为正整数）`);
    }
  }
  if (policy.maxTopN < policy.defaultTopN) {
    throw new Error(`recommendation policy 非法：maxTopN ${policy.maxTopN} < defaultTopN ${policy.defaultTopN}`);
  }
  /*
   * The weights must be finite and non-negative. Zero is allowed for a weight — the engine treats a zero as "this dimension does
   * not participate" — but a negative or non-finite one would corrupt the score rather than merely change its emphasis.
   */
  for (const [name, value] of Object.entries(policy.defaultPreferences)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`recommendation policy 非法：defaultPreferences.${name} = ${String(value)}（应为有限非负数）`);
    }
  }
}

/*
 * ============================================================================================================================
 * THE COMPOSED PAGE-TO-RECOMMENDATION CAPABILITY IS CARRIED, NOT USED
 * ============================================================================================================================
 *
 * `requestVisibleRecommendations` is the whole internal chain in one call: read a tab's loaded courses, map them through the
 * canonical adapter, and recommend from them with this host's policy and the worker's own provider. The worker SHIPS that chain
 * and deliberately never calls it — no production path reads the page yet, and wiring one is a separate decision that also has to
 * decide what a failure means for the panel.
 *
 * The import is the FULL COMPOSITION rather than any single link, so the artifact carries
 * `visible-recommendations → visible-courses → { visible-rows, row-to-course, recommendation-runtime }` by dependency. The worker
 * therefore names neither the transport, nor the adapter, nor the runner: everything below this one import arrives through it.
 *
 * ## Why there is ONE guard here and not a second one on the runner
 *
 * 16J-F-B-R1 MEASURED this rather than reasoning about it. Before the page-to-recommendation composition existed, the worker
 * imported the runner directly and guarded it, and 16I-E measured that guard to be load-bearing — dropping it dropped the engine
 * from the bundle.
 *
 * Once `visible-recommendations` existed and was itself guarded, that second guard became redundant. Removing the direct runner
 * import and its guard, then rebuilding, left every required symbol in the artifact unchanged
 * (`recommendExtensionCourses`, `requestVisibleCourses`, `requestVisibleRows`, `rowIdentityToCourse`, and the engine's
 * `calculateReviewConfidence` / `calculateCourseScore` / `normalizePreferences`), with exactly one `new MemoryCache(` and one
 * `new WhuCoursesProvider(`, and a **196-byte** smaller worker. The only thing that changed was the guard's own text.
 *
 * So the ownership is now: the worker holds the HIGHEST-LEVEL composition, and the transport, the adapter and the runner reach the
 * bundle through that dependency closure. A second direct import would be a guard protecting something already reachable.
 *
 * ## Why the guard is load-bearing
 *
 * esbuild DROPS an unused imported function, so removing this check would drop the whole chain — and its message type — from the
 * bundle. That was measured in 16I-E rather than assumed, and the structural side is checked too: the skeleton gate requires the
 * engine's real logic to be present in `background/service-worker.js`.
 *
 * ## What this does NOT claim
 *
 * Carrying the chain is not running it. Nothing here reads a page, no panel trigger exists, and the composition is called nowhere
 * in production. The capability is present in the artifact and dormant.
 */
if (typeof requestVisibleRecommendations !== 'function') {
  throw new Error(`visible-recommendations 组合接线失败：requestVisibleRecommendations 为 ${typeof requestVisibleRecommendations}`);
}


(() => {
  console.log('[Course Copilot] service worker 已启动（最小骨架，无业务逻辑）');

  /*
   * The core-bundle probe.
   *
   * `availabilityFromSeats(0)` is a fixed input with a fixed answer: no seats left is `'full'`. Nothing here depends on the
   * page, the user or the clock, so a failure means the bundled core code is not executing — which is the only thing this
   * checks. `void` marks the binding as deliberately read so the call is not treated as unused.
   */
  const coreBundleProbe = availabilityFromSeats(0);
  void coreBundleProbe;
  if (coreBundleProbe !== 'full') {
    throw new Error(`core bundle probe 失败：availabilityFromSeats(0) 返回 ${String(coreBundleProbe)}`);
  }

  /** Message the content script sends when it has identified the page. */
  const PAGE_STATUS_MESSAGE = 'COURSE_COPILOT_PAGE_STATUS';
  /** Message the content script sends with the course-panel count. */
  const PANEL_COUNT_MESSAGE = 'COURSE_COPILOT_PANEL_COUNT';
  /**
   * The preparation run reporting itself, sent BY the content script.
   *
   * Relayed ONWARD to extension pages, never back to a tab: a branch that handed the script its own report would form a loop, and the source guard below is
   * what prevents it.
   */
  const FULL_PREPARATION_EVENT_MESSAGE = 'COURSE_COPILOT_FULL_PREPARATION_EVENT';
  /** Message the side panel sends to ask for the current state. */
  const PING_MESSAGE = 'COURSE_COPILOT_PING';
  /** Message the worker sends to a known content script asking it to report again. */
  const QUERY_STATUS_MESSAGE = 'COURSE_COPILOT_QUERY_STATUS';
  /**
   * Message a caller sends to look up PUBLIC review data for a course.
   *
   * This is the one message that reaches the network. It carries a course name and an optional single teacher — nothing else. No
   * URL, origin, header, cookie, token, page address or DOM content is accepted, because this path reads a public review corpus and
   * has no business carrying anything about the user or their session.
   */
  const QUERY_PUBLIC_REVIEWS_MESSAGE = 'COURSE_COPILOT_QUERY_PUBLIC_REVIEWS';
  /**
   * Message a caller sends to recommend from the courses currently loaded in a tab.
   *
   * This is the worker's page-to-recommendation path: it reads the tab's loaded rows, maps them through the canonical adapter, and
   * runs the canonical engine with this host's policy and the worker's own provider. It carries a TAB ID and nothing else.
   *
   * ## Why this is its own message rather than an extension of `PING`
   *
   * `PING` is a page-state probe: bounded, offline, side-effect-free, and it never fails — its worst case is "no usable tab id",
   * which degrades to the worker's remembered state. A recommendation run is the opposite on every axis: unbounded in time, able to
   * reach the network, and carrying tens of kilobytes of result. Folding it into `PING` would blur a probe that cannot fail with a
   * request that can, and would make the probe's state refresh happen as a side effect of asking for a ranking.
   *
   * ## What a caller may NOT send
   *
   * No `provider`, no `policy`, no `coverage`, no `preferences`, no `topN`. The provider and the policy are WORKER ownership: the
   * provider is the worker's single module-scope instance and the policy is bound inside the runner, so accepting either would invite
   * a second provider, a second cache, or a caller-chosen policy. Preferences and `topN` are absent because no caller has controls for
   * them yet — a field with no source is a field nothing can be held to.
   */
  const QUERY_RECOMMENDATIONS_MESSAGE = 'COURSE_COPILOT_QUERY_RECOMMENDATIONS';

  /**
   * Longest accepted course name or teacher name, after trimming.
   *
   * Bounded explicitly rather than by a generic length check somewhere else: the value becomes a query parameter, and an unbounded
   * one would let a caller build a URL of arbitrary size. 200 characters comfortably exceeds any real course or personal name.
   */
  const PUBLIC_REVIEW_SUBJECT_MAX_LENGTH = 200;

  /** The answer to {@link QUERY_PUBLIC_REVIEWS_MESSAGE} on success, carrying the provider's own result unchanged. */
  interface PublicReviewSuccess {
    readonly ok: true;
    readonly result: unknown;
  }

  /** The answer on failure. Deliberately bounded: no stack, no response object, no internal URL, no credential. */
  interface PublicReviewFailure {
    readonly ok: false;
    readonly error: string;
  }

  /*
   * The recommendation RESPONSE TYPES are not declared here.
   *
   * `QueryRecommendationsSuccess` and `QueryRecommendationsFailure` are shared ambient types in `src/types/chrome.d.ts`, so the worker
   * and the side panel read ONE declaration instead of each keeping a private copy that could drift. The handler below therefore uses
   * the shared names directly.
   */
  /**
   * The one bounded error text a caller can receive from the recommendation path.
   *
   * This stays worker-local on purpose: the panel must not be able to construct it. It reads `ok: false` and shows whatever string
   * arrived, which is only safe while the worker is the sole author of that string.
   */
  const RECOMMENDATIONS_FAILURE_TEXT = '推荐请求失败。';

  /** Validate one optional string field of a message, returning its trimmed value or `null` when unusable. */
  function readSubjectField(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > PUBLIC_REVIEW_SUBJECT_MAX_LENGTH) return null;
    return trimmed;
  }

  /**
   * The most recent page-identity report, or `null` if nothing has reported yet.
   *
   * In-memory and intentionally unpersisted: once the worker is suspended this says nothing about the session, and the panel
   * recovers by asking the content script again rather than by reading a stored value.
   */
  let knownStatus: boolean | null = null;

  /** The most recent panel count, or `null` if the content script has not reported one. */
  let knownPanelCount: number | null = null;

  /** Tab ids that have reported, so the worker can ask them again without needing the `tabs` permission. */
  const reportingTabIds = new Set<number>();

  /** Relay a status to whoever is listening (the side panel, when one is open). */
  function broadcastStatus(supported: boolean): void {
    // A rejected promise here means no panel is open, which is normal rather than an error.
    chrome.runtime.sendMessage({ type: PAGE_STATUS_MESSAGE, supported }).catch(() => {});
  }

  /** Relay a panel count to whoever is listening. */
  function broadcastPanelCount(count: number): void {
    chrome.runtime.sendMessage({ type: PANEL_COUNT_MESSAGE, count }).catch(() => {});
  }

  /**
   * Relay one preparation report to whoever is listening (the side panel, when one is open).
   *
   * ## Why the original tab id has to travel inside the message
   *
   * Re-broadcasting from here makes THIS worker the sender, so the panel can no longer read `sender.tab.id` to learn which page the report belongs to — it
   * would see the worker. The original tab is therefore stamped on as `sourceTabId` while it is still visible, and the panel routes on that field.
   *
   * The report's own fields are spread unchanged: this layer does not interpret a phase, a stop reason or a summary, and a relay that reshaped them would be
   * a second definition of the preparation contract.
   */
  function broadcastPreparationReport(report: Record<string, unknown>, sourceTabId: number): void {
    // A rejected promise here means no panel is open, which is normal rather than an error.
    chrome.runtime.sendMessage({ ...report, sourceTabId }).catch(() => {});
  }

  chrome.runtime.onInstalled.addListener((details: unknown) => {
    console.log('[Course Copilot] onInstalled', details);

    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((error: unknown) => {
        console.log('[Course Copilot] 设置 side panel 打开行为失败', error);
      });
  });

  /*
   * The single message listener.
   *
   * The first two branches matter: a message this worker itself broadcasts arrives back here, and answering it would loop.
   * They are ignored explicitly rather than implicitly, so the guard is visible.
   */
  chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender: RuntimeSender, sendResponse: (response: unknown) => void) => {
    const type = message?.type;

    if (type === PAGE_STATUS_MESSAGE) {
      knownStatus = message.supported === true;
      const tabId = sender.tab?.id;
      if (typeof tabId === 'number') reportingTabIds.add(tabId);
      broadcastStatus(knownStatus);
      return false;
    }

    if (type === PANEL_COUNT_MESSAGE) {
      const count = message.count;
      // Guarded rather than trusted: a non-number would otherwise reach the panel and render as "undefined".
      knownPanelCount = typeof count === 'number' && Number.isFinite(count) ? count : null;
      if (knownPanelCount !== null) broadcastPanelCount(knownPanelCount);
      return false;
    }

    if (type === FULL_PREPARATION_EVENT_MESSAGE) {
      /*
       * THE PREPARATION REPORT, RELAYED.
       *
       * ## Why this branch exists
       *
       * The panel learns what a run is doing from these reports and from nothing else. A run answers its START once, and a status read happens only when a
       * panel opens, so a report is the ONLY way the panel can learn that a run has ended — which is what makes it able to start another one. Without this
       * relay the panel stayed in a running phase after a cancellation, kept its start control hidden, and refused every later start. That was a release
       * blocker, and this relay is the whole fix.
       *
       * ## Why the source must be a real tab
       *
       * The report is broadcast from here, so it will come back to this very listener. Relaying a report whose sender is not a content-script tab would
       * therefore re-broadcast its own copy for ever, so an absent tab id ends the branch. That one guard is both the attribution rule and the loop
       * protection: a report from the worker, the panel or another extension page has no tab to attribute it to, and is dropped rather than relayed.
       */
      const sourceTabId = sender?.tab?.id;
      if (typeof sourceTabId === 'number' && Number.isInteger(sourceTabId) && sourceTabId > 0) {
        broadcastPreparationReport(message as unknown as Record<string, unknown>, sourceTabId);
      }
      // Nothing to answer: a report is an announcement, not a question.
      return false;
    }

    if (type === PING_MESSAGE) {
      /*
       * The panel names the tab it is looking at.
       *
       * This is the recovery path a suspended worker needs. `reportingTabIds` and `knownStatus` live in this worker's memory
       * and are gone once Manifest V3 reclaims it, so a restarted worker cannot discover which tab to ask — which is why an
       * earlier version answered `supported: false` forever after a restart. The panel knows the tab, because it can read
       * the active tab's id without any extra permission: `chrome.tabs.query` does not require `"tabs"`, which governs the
       * sensitive properties (`url`, `title`) that are never read here.
       *
       * Nothing is remembered between calls. Each panel opening supplies the tab again.
       */
      const askedTabId = message.tabId;

      if (typeof askedTabId !== 'number') {
        /*
         * No usable tab id, so the only thing available is memory. The panel renders "not detected" rather than this worker
         * guessing at a tab it was not told about.
         */
        sendResponse({ known: knownStatus !== null, supported: knownStatus === true, panelCount: knownPanelCount, rows: [] });
        return false;
      }

      /*
       * The answer is awaited so the panel's reply depends on the content script's CURRENT state rather than on this worker's
       * possibly stale copy. `return true` keeps the message channel open for that asynchronous reply.
       */
      chrome.tabs
        .sendMessage(askedTabId, { type: QUERY_STATUS_MESSAGE })
        .then((reply: unknown) => {
          const answer = typeof reply === 'object' && reply !== null ? reply as StatusResponse : null;
          if (answer !== null) {
            /*
             * Refresh the in-memory copy from the authoritative answer. That copy is a cache for the passive broadcast path,
             * not the source of truth.
             */
            knownStatus = answer.supported === true;
            knownPanelCount = typeof answer.panelCount === 'number' ? answer.panelCount : null;
            reportingTabIds.add(askedTabId);
            /*
             * The teaching-class rows are forwarded straight through and are NOT cached. A restarted worker must be able to recover
             * them from the page, so keeping a copy here would create a second, staler source that could answer for a page that
             * has since changed.
             */
            sendResponse({
              known: true,
              supported: knownStatus,
              panelCount: knownPanelCount,
              rows: Array.isArray(answer.rows) ? answer.rows : [],
            });
            return;
          }
          sendResponse({ known: knownStatus !== null, supported: knownStatus === true, panelCount: knownPanelCount, rows: [] });
        })
        .catch(() => {
          /*
           * The expected outcome when the active tab has no content script — an ordinary page, or the extension was reloaded
           * while the page stayed open. Reported as "not supported", with no retry, no injection and no reload.
           */
          reportingTabIds.delete(askedTabId);
          sendResponse({ known: false, supported: false, panelCount: null, rows: [] });
        });
      return true;
    }

    if (type === QUERY_PUBLIC_REVIEWS_MESSAGE) {
      /*
       * Public review lookup.
       *
       * ## Validation comes first
       *
       * `courseName` must be a non-empty string within the length bound, and `teacher`, when present at all, must be the same. The
       * message is rejected BEFORE the provider or the network is touched, so a malformed caller cannot cause an outbound request.
       * Nothing is coerced, trimmed into validity, or fuzzy-matched: a name that is not usable is reported as unusable.
       *
       * Only these two fields are READ. If a caller sends anything else — a URL, a token, a cookie, fetch options — it is ignored
       * by construction rather than filtered, because this handler never looks at anything else.
       */
      const requestedCourseName = readSubjectField(message.courseName);
      if (requestedCourseName === null) {
        sendResponse({ ok: false, error: '课程名无效。' } satisfies PublicReviewFailure);
        return false;
      }

      /*
       * `teacher` is optional, but an explicitly PRESENT and unusable value is an error rather than being dropped: silently
       * ignoring it would answer a different question than the one asked, and the caller would never know.
       */
      let requestedTeacher: string | undefined;
      if (message.teacher !== undefined) {
        const readTeacher = readSubjectField(message.teacher);
        if (readTeacher === null) {
          sendResponse({ ok: false, error: '教师名无效。' } satisfies PublicReviewFailure);
          return false;
        }
        requestedTeacher = readTeacher;
      }

      /*
       * The module-scope provider, never a fresh one. A per-message provider would discard the 6-hour cache on every call and
       * quietly turn the policy into nothing, while still passing any test that only checked the TTL.
       *
       * `teacher` is passed through ONLY when it was supplied, so a name-only query keeps the provider's name-only behaviour
       * (including the course-level roll-up it produces only in that case).
       */
      const query = requestedTeacher === undefined
        ? { courseName: requestedCourseName }
        : { courseName: requestedCourseName, teacher: requestedTeacher };

      // `return true` keeps the channel open: the answer arrives asynchronously.
      void reviewProvider
        .searchCourse(query)
        .then((result) => {
          // The provider's result travels unchanged. It is not re-shaped, and its bounded sample rows stay as they are.
          sendResponse({ ok: true, result } satisfies PublicReviewSuccess);
        })
        .catch(() => {
          /*
           * One bounded failure shape for every cause — a rejected fetch, a provider error, a malformed upstream body. No stack, no
           * response object, no internal URL and no credential reaches the caller, because none of them is useful to it and each
           * could disclose something it should not.
           */
          sendResponse({ ok: false, error: '公开评价查询失败。' } satisfies PublicReviewFailure);
        });
      return true;
    }

    /*
     * ================================================================================================================================
     * AUTO-EXPAND FORWARDING
     * ================================================================================================================================
     *
     * Three control messages, relayed to the tab whose content script owns the session. This worker decides nothing about them: it does not run the
     * expansion, does not remember a click count, and does not know a single selector. The session lives one layer down, in the only runtime that has
     * the DOM and whose lifetime covers a whole expansion.
     *
     * A fourth message of this family is deliberately absent. `AUTO_EXPAND_EVENT` travels FROM a content script UP to whoever is listening; a branch
     * that forwarded it to a tab would relay it back to the script that sent it, which is a loop rather than a feature.
     */
    if (type === FORWARDED_TYPES.start || type === FORWARDED_TYPES.cancel || type === FORWARDED_TYPES.status) {
      void forwardAutoExpandMessage(message.tabId, type).then((outcome) => {
        /*
         * The content script's reply travels through unmodified. It is already a receipt — for START that is an acknowledgement, not the outcome of
         * the expansion — so there is nothing here to wait for and nothing to re-shape.
         */
        sendResponse(outcome);
      });
      return true;
    }

    /*
     * The teacher-hydration controls, relayed the same way and for the same reason: this worker decides nothing about them. It does not run the
     * hydration, does not hold a queue or a session, and does not know a single selector — the queue lives one layer down, in the only runtime that has
     * the DOM and whose lifetime covers a pass over a hundred panels.
     *
     * The event message has no branch here. `TEACHER_HYDRATION_EVENT` travels FROM a content script UP; relaying it to a tab would hand it back to the
     * script that sent it, which is a loop rather than a feature.
     */
    if (type === TEACHER_HYDRATION_FORWARDED_TYPES.start
      || type === TEACHER_HYDRATION_FORWARDED_TYPES.cancel
      || type === TEACHER_HYDRATION_FORWARDED_TYPES.status) {
      void forwardTeacherHydrationMessage(message.tabId, type).then((outcome) => {
        sendResponse(outcome);
      });
      return true;
    }

    /*
     * The availability-filter controls, relayed the same way.
     *
     * This worker holds no filter phase, knows no selector, and never touches the page: the filter being operated is WHU's own, and the session lives one
     * layer down, in the only runtime that has the DOM. As above, the event message has no branch here — it travels FROM a content script UP, and relaying it
     * to a tab would hand it back to the script that sent it.
     */
    if (type === AVAILABILITY_FILTER_FORWARDED_TYPES.start
      || type === AVAILABILITY_FILTER_FORWARDED_TYPES.cancel
      || type === AVAILABILITY_FILTER_FORWARDED_TYPES.status) {
      void forwardAvailabilityFilterMessage(message.tabId, type).then((outcome) => {
        sendResponse(outcome);
      });
      return true;
    }

    /*
     * The unified preparation controls, relayed the same way. This worker holds neither the preparation phase nor either phase's summary, and it knows no
     * selector: the run lives one layer down, in the only runtime that has the DOM and whose lifetime covers both passes over the page.
     */
    if (type === PREPARATION_FORWARDED_TYPES.start
      || type === PREPARATION_FORWARDED_TYPES.cancel
      || type === PREPARATION_FORWARDED_TYPES.status) {
      void forwardPreparationMessage(message.tabId, type).then((outcome) => {
        sendResponse(outcome);
      });
      return true;
    }

    if (type === QUERY_RECOMMENDATIONS_MESSAGE) {
      /*
       * The page-to-recommendation path.
       *
       * ## Only the tab id and the user's weights are read
       *
       * `message.tabId` is passed to the composition AS-IS, unvalidated here, because the transport already owns that validation:
       * a non-integer tab id makes it send nothing and report no rows, which the engine turns into a canonical empty result. Doing
       * the numeric check here as well would be a second copy of one rule, and the two could drift.
       *
       * PRE-RELEASE-UX-A18 adds `message.preferences`, the four importance weights the panel's sliders hold. It is forwarded and NOT
       * validated here, for the same reason: the engine's `normalizePreferences` is the authority on what a weight vector means, and it
       * already clamps, fills omitted keys from host policy and redistributes across absent aspects. A worker-side copy of that rule would
       * be a second ranking authority, and the two could disagree about the same numbers.
       *
       * Still nothing else — not `provider`, not `policy`, not `topN`, not `coverage`. The provider comes from this worker's module scope,
       * which is the only place a provider and its cache are allowed to exist, and the policy is bound inside the runner. A caller that sends
       * those fields has them ignored by construction, because this handler never looks at them.
       *
       * ## Why a weight change costs no page preparation
       *
       * This branch reads the page and runs the engine; it never STARTS anything on the page. The preparation operations — the availability
       * filter, the load-more clicks, the teacher-detail expansion — are separate START messages this handler does not send, so re-ranking
       * after a slider moves cannot repeat them. The page read it does perform is `COURSE_COPILOT_QUERY_VISIBLE_ROWS`, whose content-script
       * branch only queries and scans the DOM.
       *
       * ## Why ordinary failures are successes
       *
       * An unusable tab, a missing content script, a malformed reply, an unsupported page, a provider failure and a course with no
       * reviews ALL reach `ok: true`, carrying whatever the canonical pipeline degraded them to. They are answers, not errors.
       *
       * ## And why nothing is remembered
       *
       * The rows, the courses and the result are not cached, and this branch does not touch `knownStatus`, `knownPanelCount` or
       * `reportingTabIds`. Those belong to the status path; a ranking is a different question, and a remembered answer could
       * describe a page that has since changed.
       */
      void requestVisibleRecommendations(message.tabId, {
        provider: reviewProvider,
        ...(message.preferences === undefined ? {} : { options: { preferences: message.preferences } }),
      })
        .then((outcome) => {
          /*
           * The page's read status travels beside the result, not inside it. It describes the INPUT — whether the tab could be read at all — and
           * the canonical result is unchanged by it, which is what lets a caller explain an empty answer instead of guessing at one.
           */
          sendResponse({ ok: true, page: outcome.page, result: outcome.result } satisfies QueryRecommendationsSuccess);
        })
        .catch(() => {
          /*
           * Everything the pipeline can degrade has already been degraded by this point, so reaching here means the run broke
           * outside that: the message is fixed and bounded, and the original exception — which could name an internal module, a URL
           * or a provider detail — goes nowhere.
           */
          sendResponse({ ok: false, error: RECOMMENDATIONS_FAILURE_TEXT } satisfies QueryRecommendationsFailure);
        });
      return true;
    }

    return false;
  });
})();
