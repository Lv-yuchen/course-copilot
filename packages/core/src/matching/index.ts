/**
 * The `@course-copilot/core/matching` entry point.
 *
 * A domain subpath rather than a deep path: consumers import the *matching domain*, not a file
 * location, so the internal file layout stays free to change. It mirrors the package's public import:
 *
 * ```ts
 * import { matchCourse } from '@course-copilot/core/matching';
 * ```
 *
 * @module @course-copilot/core/matching
 */

export * from './courseMatcher.js';
