/**
 * The `@course-copilot/core/aspects` entry point.
 *
 * A deliberate domain subpath rather than a deep path: consumers import the *aspect
 * model*, not a file location, so the internal file layout stays free to change. It
 * mirrors the package's public import:
 *
 * ```ts
 * import { ASPECT_KEYS, type AspectAnalysis } from '@course-copilot/core/aspects';
 * ```
 *
 * @module @course-copilot/core/aspects
 */

// The aspect data model.
export * from './types.js';

// The scoring engine that turns aspect evidence into `0..10` scores. Exposed here so the domain
// barrel stays a single import for consumers that want both; the precise
// `@course-copilot/core/aspects/scoring` subpath exists for consumers that want only the engine.
// Checked for name collisions against the model and the rest of the package before adding — note
// that the check must be **case-sensitive**, because `AspectScore` (the model interface) and
// `aspectScore` (the scoring function) are different identifiers, not a clash.
export * from './scoring.js';

// The grade-to-friendliness mapping. Re-published here because it is part of the model's arithmetic —
// `gradeSignal` composes it with text evidence — while the precise
// `@course-copilot/core/aspects/grade` subpath exists for consumers that want only the mapping.
// `gradeToFriendliness` is new to this barrel, so the collision check has nothing to resolve.
export * from './grade.js';

// The grade-signal composition: the outcome half (folded in through the chart above) and the text half,
// kept apart on purpose and combined with stated provenance. Published here for the same reason
// `scoring` is — it is a scoring layer over the model. Collision-checked first: none of its seven names
// clashes with the model, `scoring` or `grade`, not even case-only.
export * from './gradeSignal.js';
