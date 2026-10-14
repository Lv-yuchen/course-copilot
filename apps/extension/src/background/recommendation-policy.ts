/**
 * The browser extension's recommendation host policy.
 *
 * ## Why this file exists, and why the values are written out here
 *
 * `@course-copilot/recommendation` owns NO policy values, by design: how many recommendations to return, which weights to fall back
 * on, how many review records one query may pull back and how large a response may ever be are decisions belonging to the HOST.
 * The DSH plugin's decisions live in `src/config.ts`. These are the EXTENSION's, and this file is their owner.
 *
 * The two hosts currently choose the same numbers. That is a starting point, not a shared ownership: nothing here imports
 * `src/config.ts`, and there is deliberately no check that the two agree. If the extension later wants ten recommendations or a
 * different default weighting, that is a change to this file alone — and it must stay possible without editing the application.
 *
 * Writing the numbers here is therefore correct rather than a duplication to be removed. The rule this repository follows is that
 * the *reusable package* owns no host defaults; it is not a rule that no host may state its own.
 *
 * ## Immutability
 *
 * The object is frozen, so a future caller cannot quietly mutate the configuration a running worker is using. `satisfies` keeps
 * the literal's own types while still proving it satisfies the contract — and, because every field of `RecommendationPolicy` is
 * required, omitting one is a compile error rather than a silently chosen default.
 *
 * @module
 */

import type { RecommendationPolicy } from '@course-copilot/recommendation';

/**
 * The extension's policy, chosen to match the current product semantics.
 *
 * Values, and what each one means here:
 *
 * - `defaultPreferences` — the four weights a user can steer, matching the DSH host's current default so that the same question
 *   answered in either host is answered the same way. COMPLETE, not partial: the engine uses these as the base for any weight a
 *   caller omits, so a partial set would leave the engine choosing the missing numbers.
 * - `defaultTopN` — how many recommendations to return when a caller does not ask for a number.
 * - `maxTopN` — the response-size ceiling the engine enforces regardless of what a caller asks for.
 * - `candidateLimit` — the upper bound on review records one provider query may return.
 */
export const EXTENSION_RECOMMENDATION_POLICY = Object.freeze({
  defaultPreferences: Object.freeze({
    gradeFriendliness: 0.5,
    workloadFriendliness: 0.3,
    attendanceFriendliness: 0.15,
    overallScore: 0.05,
  }),
  defaultTopN: 5,
  maxTopN: 50,
  candidateLimit: 25,
} satisfies RecommendationPolicy);
