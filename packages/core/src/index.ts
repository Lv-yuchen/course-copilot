/**
 * `@course-copilot/core` — the deterministic course-selection engine.
 *
 * Host-free by contract: nothing in this package may import DSH, Cordis, a browser
 * API, the filesystem, or a concrete review provider. That is what lets the same
 * code run inside the DSH plugin and, later, inside a backend service.
 *
 * The Phase 1–3 engine is being moved here one dependency-free slice at a time, from
 * the leaves of the dependency tree upward. The aspect model and the course domain have
 * landed; the plugin's own `src/core/**` still holds the rest and reaches this package
 * through compatibility shims.
 *
 * Every export below is real business API. The public surface is recorded in
 * `docs/core-public-api.md` and guarded by `test/coreApiBaseline.test.ts`.
 *
 * @module @course-copilot/core
 */

// The aspect model. Checked for collisions against the course domain before re-exporting,
// so the root surface stays unambiguous.
export * from './aspects/index.js';

// The course domain. Checked the same way; what a consumer needs is available from the root
// as well as from `@course-copilot/core/course`.
export * from './types/course.js';

// Text similarity. Its four function names were checked against both modules above before
// re-exporting, so the root surface stays unambiguous.
export * from './similarity.js';

// Eligibility filtering. This is the first migrated module that *consumes* the course domain
// package-internally (`./types/course.js`), so it exercises core-internal composition rather than
// only standalone algorithms. Names checked the same way.
export * from './eligibility.js';

// Scalar parsing helpers shared by every adapter. Also standalone (zero imports), and checked for
// name collisions case-sensitively against everything above.
export * from './parse.js';

// Course/teacher name normalization. Standalone too, but the most widely consumed module so far:
// it is upstream of course identity, teacher matching, alias lookup and the fuzzy matcher's inputs.
export * from './normalize.js';

// Course and teacher aliases — the last general strategy layer before the matcher. It consumes
// `./normalize.js` package-internally, so this is the second core-internal composition after
// `eligibility`. Checked for name collisions case-sensitively against everything above.
export * from './alias.js';

// Algorithm tuning constants. Only the nine Core-owned ones: user-facing defaults, tool payload
// bounds and review-transport pacing deliberately stay in the application's own config module.
// See `docs/config-ownership-audit.md`.
export * from './config.js';

// Review-data confidence. The first algorithm module that consumes the Core-owned config module
// package-internally, which is what makes `/config` a real internal dependency rather than a
// subpath that merely resolves. Checked for name collisions case-sensitively.
export * from './confidence.js';

// The matching domain. With this, the whole matching stack closes inside the package:
// `course` + `normalize` + `alias` + `similarity` + `config` -> `matching`. Collision-checked.
export * from './matching/index.js';

// The decision layer. Three of its names (`ASPECT_KEYS`, `AspectBreakdown`, `AspectDecision`) are
// re-published from `./aspects/`, so they resolve to symbols this barrel already exposes rather than
// competing with them — the collision audit classifies that as intentional re-publication, not a
// clash. Only the remaining names are new to the root.
export * from './recommendation.js';

// Deterministic scoring and ranking — the last algorithm module, and the top of the engine's
// dependency chain: it consumes `course`, `config`, `confidence` and `recommendation`. It carries no
// host policy: default weights arrive as an argument and the result cap belongs to the caller.
export * from './ranking.js';
