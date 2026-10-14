/**
 * `@course-copilot/provider` — browser-safe review providers, and the contracts they require.
 *
 * ## What this package owns
 *
 * The provider contract (`CacheLike`/`CacheStats`, the review-provider types), the request limiter, the transport defaults, the
 * WHU review semantics, and the `WhuCoursesProvider` implementation.
 *
 * ## What must never be exported from here
 *
 * The Node construction path and anything naming a filesystem or a storage medium: the `TtlCache` implementation, the
 * `createNodeWhucoursesProvider` factory, cache-directory or cache-TTL configuration, and Node built-ins. Both remain in the
 * application, which is this package's CONSUMER — a `./node` subpath owning them would make the package depend on the app it is
 * meant to be consumed by (16D-C).
 *
 * The cache the provider needs is a REQUIRED injected dependency; this package declares the contract and nothing that implements
 * it for a particular host.
 *
 * @module @course-copilot/provider
 */

// The cache contract, as types only: there is no implementation here, and the `export *` below would not carry type-only exports
// under `isolatedModules`/`verbatimModuleSyntax`.
export type { CacheLike, CacheStats } from './cache.js';
export * from './types.js';
export * from './limiter.js';
export * from './defaults.js';
export * from './whu.js';
export * from './review-excerpts.js';
export * from './whucourses.js';
