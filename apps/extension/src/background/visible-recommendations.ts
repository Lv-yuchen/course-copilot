/**
 * The composed capability: read a tab's page and run the canonical recommendation engine over it.
 *
 * ## What this module is
 *
 * It is the last join in the extension's internal chain — `RowIdentity` → `NormalizedCourse` → `RecommendationResult` — and it is
 * deliberately only that join. `requestVisibleCourses` owns reading the page and mapping it, `recommendExtensionCourses` owns the
 * engine, this host's policy and the provider wiring. Both are delegated; neither is repeated.
 *
 * ## What it deliberately does NOT do, and why each omission is a decision
 *
 * - **No provider construction.** The provider arrives injected because the worker owns exactly one provider and one cache at
 *   module scope. Building a pair here would discard the cache on every call and quietly turn a six-hour policy into nothing.
 * - **No policy.** `recommendExtensionCourses` binds `EXTENSION_RECOMMENDATION_POLICY` itself, so accepting one here would offer
 *   callers an override that the host never intends to grant.
 * - **No `coverage`.** The canonical engine reports pool coverage as the CALLER observed it and treats `null` as a real answer
 *   rather than a gap. A visible-row scan knows how many rows it read, but `coursesDiscovered` and `exhausted` live in the page's
 *   own paging state and are not carried on a row, so any value passed from here would be invented. Omitting it keeps
 *   `dataCoverage: null`, which is the honest report for a run whose page counts are unknown.
 * - **No empty-input shortcut.** An empty course list already costs zero provider calls and yields a complete canonical result,
 *   so short-circuiting would mean constructing a second `RecommendationResult` here — a second result shape to keep in step with
 *   the engine's `meta`, `preferences` and `dataCoverage` semantics, for no gain.
 * - **No error re-wrapping.** The transport already reports every failure as an empty page, and the engine already degrades a
 *   provider failure to "no trusted evidence". A `try`/`catch` or an `{ ok: false }` envelope here would be a third error model
 *   layered over two that already work.
 *
 * @module
 */

import type { RecommendOptions } from '@course-copilot/recommendation';
import type { RecommendationResult } from '@course-copilot/core/course';
import type { ReviewProvider } from '@course-copilot/provider';
import { recommendExtensionCourses } from './recommendation-runtime.js';
import { requestVisibleCourses } from './visible-courses.js';

/** What one composed run needs beyond the tab it reads. */
export interface VisibleRecommendationInput {
  /**
   * The provider to consult. Injected, never constructed here: the worker owns the single provider and cache, and a second pair
   * built inside this module would silently discard the cache on every call.
   */
  readonly provider: ReviewProvider;
  /** Caller-side engine options, such as a specific `topN` or a preference override. */
  readonly options?: RecommendOptions;
  /** Clock, injected so a caller (or a test) can pin `generatedAt`; omitted, the engine uses its own clock. */
  readonly now?: () => Date;
}

/** What one composed run produced: the page's read status, and the canonical result computed from it. */
export interface VisibleRecommendationOutcome {
  /** Input-side facts about the page read. Report-only: it never influenced the result. */
  readonly page: PageReadStatus;
  /** The canonical `RecommendationResult`, unmodified. */
  readonly result: RecommendationResult;
}

/**
 * Read one tab's loaded courses and recommend from them.
 *
 * The two steps are still the whole pipeline, and every failure still travels the path the components already define: an unusable tab, a missing
 * content script or a malformed reply arrives from the transport as a non-`ok` read, and an empty course list is passed to the engine rather than
 * short-circuited, so the caller receives a canonical empty result with `dataCoverage: null` instead of a hand-built one.
 *
 * What changed is that the reason no longer disappears: the page snapshot travels back beside the result, so a caller can tell an unsupported tab
 * from a failed read from a genuinely empty page from rows that could not be mapped. The result itself is untouched — the page facts are attached
 * AFTER the engine ran and are never an input to it.
 *
 * @param tabId - the tab to read. Accepted as `unknown` because it arrives from a message.
 * @param input - the injected provider and any caller-side engine options.
 * @returns the page's read status and the canonical result.
 */
export async function requestVisibleRecommendations(
  tabId: unknown,
  input: VisibleRecommendationInput,
): Promise<VisibleRecommendationOutcome> {
  const snapshot = await requestVisibleCourses(tabId);

  /*
   * Optional fields are spread conditionally so an absent one stays ABSENT rather than present-and-undefined. That matters for `now`: passing
   * `now: undefined` is not the same statement as not passing it, and the engine distinguishes the two when it decides whether to default the
   * clock.
   */
  const result = await recommendExtensionCourses({
    courses: snapshot.courses,
    provider: input.provider,
    ...(input.options === undefined ? {} : { options: input.options }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  return {
    page: {
      read: snapshot.read,
      ...(snapshot.supported === undefined ? {} : { supported: snapshot.supported }),
      rowCount: snapshot.rowCount,
      courseCount: snapshot.courseCount,
      /*
       * The verdict comes from the page's own signal when there is one, and is `unknown` otherwise. That is the honest answer in every other case:
       * an unsupported tab, an unreadable tab, or a page whose list markers are not shaped as expected. It must never be reported as `complete`,
       * because a user shown a complete-looking list has been told something the extension does not know.
       */
      completeness: snapshot.loadState?.completeness ?? 'unknown',
      /*
       * The underlying presence/visibility facts travel too, so a caller can see WHY the verdict is what it is — and so "the page said unknown" stays
       * distinguishable from "there was no signal at all", which is the state of every non-`ok` read.
       */
      ...(snapshot.loadState === undefined
        ? {}
        : {
          loadState: {
            morePresent: snapshot.loadState.morePresent,
            moreVisible: snapshot.loadState.moreVisible,
            endSignPresent: snapshot.loadState.endSignPresent,
            endSignVisible: snapshot.loadState.endSignVisible,
          },
        }),
    },
    result,
  };
}
