/**
 * A GLOBAL alias for the canonical `RecommendationResult`.
 *
 * ## Why this file exists at all
 *
 * `chrome.d.ts` has to be able to name the canonical result — the recommendation response carries one — but it cannot import it.
 * That file is deliberately ambient (no imports, no exports) so the CONTENT SCRIPT can reference `RuntimeMessage`, `RowIdentity` and
 * friends without an import, which is exactly what once made the compiler emit a bare `export {};` into a script the browser loads
 * as a classic script.
 *
 * Measured, not assumed: adding a type-only import DIRECTLY to `chrome.d.ts` turned that file into a MODULE, so its declarations
 * stopped being global and the content script failed with six `TS2304: Cannot find name` errors for `RuntimeMessage` and
 * `RowIdentity`.
 *
 * ## Why the alias is wrapped in `declare global`
 *
 * A file with an import IS a module, and a module's `type` alias is module-scoped — it is invisible to ambient files. That was also
 * measured: with a bare `type RecommendationResult = Canonical`, `chrome.d.ts` silently degraded the name to `any`, so a deliberately
 * bogus field access compiled cleanly. `declare global` puts the alias back into the global scope, which is the whole point of this
 * file, and it keeps the exception contained to ONE declaration file rather than touching `chrome.d.ts`.
 *
 * All of that is erased at compile time: a declaration file emits nothing, so the content script's output stays a classic script
 * with no module statement.
 *
 * Aliasing rather than restating is the other half: a structural copy of `RecommendationResult` would be a second source of truth for
 * the same shape, and the two would drift without anything noticing. This alias cannot drift — it IS the canonical type.
 *
 * @module
 */

import type { RecommendationResult as CanonicalRecommendationResult } from '@course-copilot/core/course';

declare global {
  /**
   * The canonical recommendation result, available globally.
   *
   * A type alias, so every field keeps its canonical type and a consumer reading one (say `result.considered`) is checked against
   * the real definition rather than against a description of it.
   */
  type RecommendationResult = CanonicalRecommendationResult;
}
