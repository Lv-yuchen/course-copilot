/**
 * The host-policy contract.
 *
 * Its own module so that both the package entry and the engine can name it without the engine importing the entry point it is
 * exported from.
 *
 * ## Why the policy is an input rather than something this package decides
 *
 * How many recommendations to return, which preference weights to fall back on, how many reviews one query may pull back, and how
 * large a response may ever be — those are the HOST's decisions. A reusable engine that ships its own copies of them creates a
 * second source of truth: the host's configured value and the engine's built-in value would both exist, and their agreement would
 * rest on a test rather than on ownership.
 *
 * So there are deliberately **no policy values in this package**. Not a default, not a fallback, not a factory. Every field is
 * required, which turns "a host forgot to state its policy" into a compile error instead of a silently chosen number.
 *
 * ## Who supplies it
 *
 * - the DSH plugin supplies the application's current values from its own config;
 * - the extension will supply its own, without importing the application's config at all.
 *
 * Both read this type; neither shares the other's numbers.
 *
 * @module @course-copilot/recommendation/policy
 */

import type { RankingPreferences } from '@course-copilot/core/course';

/**
 * Every policy value the recommendation engine needs, supplied by its host.
 *
 * All four fields are REQUIRED. An optional field would need a fallback somewhere, and a fallback declared here would be this
 * package deciding host policy — exactly what the contract exists to prevent.
 */
export interface RecommendationPolicy {
  /**
   * Preference weights to use when a caller does not supply its own.
   *
   * COMPLETE, not partial. The engine falls back to these for any weight a caller omits, so they have to be a full set — a partial
   * one would leave the engine choosing the missing numbers, which is precisely the host decision this contract exists to keep out
   * of the package.
   */
  readonly defaultPreferences: RankingPreferences;
  /** How many recommendations to return when a caller does not ask for a specific number. */
  readonly defaultTopN: number;
  /**
   * Hard ceiling on the number of recommendations in one response.
   *
   * A response-size bound rather than a scoring rule, and it is enforced by the engine regardless of what a caller asks for. It
   * lives in host policy because the same ceiling also governs how large an agent-facing payload may be described as being.
   */
  readonly maxTopN: number;
  /** Upper bound on how many review records one provider query may return. */
  readonly candidateLimit: number;
}
