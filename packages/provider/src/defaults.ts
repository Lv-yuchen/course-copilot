/**
 * Defaults a provider falls back to when the caller supplies none.
 *
 * ## Why these live here
 *
 * They describe how to talk to a review site politely — how many requests may be in flight and how far apart they must start.
 * That is a property of the provider, not of the application that happens to use one, and a second provider would need the same
 * kind of number.
 *
 * ## Why the application still re-exports them
 *
 * `src/config.ts` publishes them so the plugin's configuration schema can state a default and so existing
 * `from '../config'` imports keep working. The canonical DECLARATION is here and only here; the application re-exports the same
 * binding rather than restating the number, so the schema default and the provider fallback cannot drift apart.
 *
 * @module @course-copilot/provider/defaults
 */

/** Default maximum concurrent review-provider requests per host. */
export const REVIEW_FETCH_CONCURRENCY = 3;

/** Default minimum spacing between requests to the same review host. */
export const REVIEW_FETCH_MIN_INTERVAL_MS = 350;
