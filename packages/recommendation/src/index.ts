/**
 * `@course-copilot/recommendation` — the canonical recommendation engine, host-free.
 *
 * ## What this package is
 *
 * The deterministic recommendation pipeline: courses → eligibility filter → provider lookup → match → score → confidence →
 * deterministic sort → structured result. It is the ONE implementation; the application's `src/pipeline/recommend.ts` is a
 * compatibility wrapper over it that injects the application's own host policy.
 *
 * ## What it deliberately does not own
 *
 * No host policy values — see {@link RecommendationPolicy}. No provider or cache construction: it consumes the
 * `ReviewProvider` contract, and a `CacheLike` is never its concern. No Node, no filesystem, no DSH.
 *
 * @module @course-copilot/recommendation
 */

export type { RecommendationPolicy } from './policy.js';
export * from './recommend.js';
