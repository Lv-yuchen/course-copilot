/**
 * The extension's recommendation runtime — the adapter that composes the three pieces.
 *
 * ## What this file is
 *
 * It is HOST ORCHESTRATION, not engine logic. The extension already owns three things: the canonical engine
 * (`@course-copilot/recommendation`), an extension-owned `RecommendationPolicy`, and a browser-safe `ReviewProvider` with a
 * memory cache. This is the single place that puts them together.
 *
 * ## What it deliberately does not do
 *
 * No ranking, no matching, no multi-teacher partitioning, no score or confidence arithmetic, and no call to
 * `provider.searchCourse` — all of that belongs to the engine, and a copy here would be a second implementation of the algorithm
 * that could drift from the canonical one. The provider is INJECTED rather than constructed, so the worker keeps its single
 * module-scope provider and its single cache, and this file never grows a second one.
 *
 * ## Why the policy is bound here and not passed in
 *
 * `EXTENSION_RECOMMENDATION_POLICY` is this host's own decision, so binding it here is what makes "the extension's policy" true of
 * every run rather than of whichever caller remembered to pass it. A caller may still override any individual value through
 * `options`; what it cannot do is supply a different policy.
 *
 * @module
 */

import {
  recommendCourses,
  type RecommendOptions,
} from '@course-copilot/recommendation';
import type { NormalizedCourse, RecommendationResult } from '@course-copilot/core/course';
import type { ReviewProvider } from '@course-copilot/provider';
import { EXTENSION_RECOMMENDATION_POLICY } from './recommendation-policy.js';

/** The host inputs one extension recommendation run needs. */
export interface ExtensionRecommendationInput {
  /** The candidate courses, already normalized by whatever read the page. */
  readonly courses: readonly NormalizedCourse[];
  /**
   * The provider to consult. Injected, never constructed here: the worker owns exactly one provider and one cache, and a second
   * pair built inside this function would silently discard the cache on every call.
   */
  readonly provider: ReviewProvider;
  /** Caller-side options, such as a specific `topN` or a preference override. */
  readonly options?: RecommendOptions;
  /** Clock, injected so a test can pin `generatedAt`. Defaults to the engine's own clock. */
  readonly now?: () => Date;
  /** Coverage counts as the caller observed them, or omitted when there is no page behind this run. */
  readonly coverage?: {
    coursesDiscovered: number;
    sectionsDiscovered: number;
    sectionsHydrated: number;
    exhausted?: boolean | null;
  };
}

/**
 * Run the canonical recommendation pipeline with the extension's policy.
 *
 * @param input - the courses, the injected provider, and optional caller overrides.
 * @returns the canonical `RecommendationResult`, unmodified — this function adds no fields and re-shapes nothing.
 */
export async function recommendExtensionCourses(
  input: ExtensionRecommendationInput,
): Promise<RecommendationResult> {
  const { courses, provider, options, now, coverage } = input;

  /*
   * The composition, in full. `providers` and `policy` are the two things the engine refuses to decide for itself, and both come
   * from this host: the provider from the caller, the policy from the extension's own module.
   *
   * `lookup` is left to the engine's `defaultLookup`, which is what supplies `candidateLimit` to the provider query. Passing
   * `provider.searchCourse` from here instead would put transport policy in this file and bypass the policy's candidate limit.
   */
  return recommendCourses(
    courses,
    options ?? {},
    {
      providers: [provider],
      policy: EXTENSION_RECOMMENDATION_POLICY,
      ...(now === undefined ? {} : { now }),
    },
    coverage,
  );
}
