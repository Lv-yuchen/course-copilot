/**
 * The sidepanel's preference editor — the four importance sliders and what they mean.
 *
 * ## The product rule this module encodes
 *
 * Each control is an integer **importance** from 0 to 10, where `0` means "this dimension does not matter to me" and `10` means "this
 * matters a lot". The numbers are a RATIO, not percentages, so the user never has to make four numbers add up to 100 — and the panel
 * never adjusts a slider the user did not touch. What the engine receives is the four relative values; the percentage shown beside each
 * slider is derived for display only.
 *
 * ## Why 10 and not 3 (a deliberate departure from the older control)
 *
 * An earlier version of this product used four tiers 0..3. That cannot express the shipped defaults: the engine's own default weighting
 * is `0.5 / 0.3 / 0.15 / 0.05`, and an exhaustive check of all 256 tier combinations found NONE that normalises to it, so a tier
 * control would have had to change the default ranking the moment the editor was opened. `10 / 6 / 3 / 1` is exact:
 *
 * ```
 * 10 : 6 : 3 : 1  =  0.5 : 0.3 : 0.15 : 0.05
 * ```
 *
 * So the defaults below reproduce the shipped ranking exactly, and the UI values are no longer a lossy approximation of the truth.
 *
 * ## Why the percentage is computed here and not in the engine
 *
 * It is a presentation of the RATIO, and the engine's own `normalizePreferences` is the authority on what the ratio becomes. This module
 * therefore never normalises into the payload: it sends whole importance values and shows the proportion, which is the same arithmetic the
 * engine will apply. It deliberately does NOT re-implement the engine's missing-dimension redistribution, so a displayed percentage can
 * differ from the engine's effective weight once an aspect is absent — and that is the honest position, because the panel cannot know
 * which aspects a course's corpus will supply.
 *
 * @module
 */

/**
 * The four dimensions a user may steer, in the order they are shown.
 *
 * The same four the engine's ranking actually uses. `teachingQuality` and `examFriendliness` are absent on purpose: they reach the
 * explanation but cannot move a course up or down, so a control for either would be a control that does nothing. `preset`,
 * `minReviewCount` and `requireAvailableSeats` are absent for a different reason — they are not importance weights at all, and the
 * comment filter and the availability filter are decisions the panel already makes elsewhere.
 *
 * The union is declared HERE rather than imported. `RankingPreferences` is the engine's wider input and its four weights are the subset
 * this editor is allowed to send; naming that subset locally is what keeps a future optional weight from silently acquiring a slider.
 */
export type PreferenceKey = 'gradeFriendliness' | 'workloadFriendliness' | 'attendanceFriendliness' | 'overallScore';

export const PREFERENCE_CONTROLS: readonly { readonly key: PreferenceKey; readonly label: string }[] = [
  { key: 'gradeFriendliness', label: '成绩友好' },
  { key: 'workloadFriendliness', label: '工作量轻松' },
  { key: 'attendanceFriendliness', label: '考勤宽松' },
  { key: 'overallScore', label: '学生评价' },
];

/** The lowest importance a slider can take. `0` means the dimension does not participate. */
export const PREFERENCE_MIN = 0;

/** The highest importance a slider can take. */
export const PREFERENCE_MAX = 10;

/** The slider step. Whole numbers only: a fractional "importance" is not a thing a person means. */
export const PREFERENCE_STEP = 1;

/**
 * The importance each control starts at.
 *
 * `10 / 6 / 3 / 1` is the engine's default weighting expressed as a ratio, which is what makes the default state reproduce the shipped
 * ranking exactly rather than approximately. Do not "round these to look nicer": any other set changes the default order.
 */
export const PREFERENCE_DEFAULTS: Readonly<Record<PreferenceKey, number>> = Object.freeze({
  gradeFriendliness: 10,
  workloadFriendliness: 6,
  attendanceFriendliness: 3,
  overallScore: 1,
});

/** The four importances, as the panel holds them. */
export type PreferenceValues = Record<PreferenceKey, number>;

/** A copy of {@link PREFERENCE_DEFAULTS} the caller may mutate. */
export function defaultPreferenceValues(): PreferenceValues {
  return { ...PREFERENCE_DEFAULTS };
}

/**
 * Whether a value is one the controls can actually produce.
 *
 * The native `<input type="range">` cannot emit anything else while the markup declares the same bounds, but the values arrive from DOM
 * reads and a message boundary, so they are checked rather than trusted. An out-of-range or fractional value is NOT clamped here — it
 * is reported as unusable, because silently turning a bug into `10` would rank a course by a number the user never chose.
 *
 * @param value - the value under inspection.
 * @returns `true` for a whole number within the slider's own range.
 */
export function isUsableImportance(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= PREFERENCE_MIN
    && value <= PREFERENCE_MAX;
}

/** Why a set of importances cannot be sent. */
export type PreferenceProblem =
  /** A value is not a whole number inside the slider's range. */
  | { readonly code: 'unusable_value'; readonly key: PreferenceKey }
  /** Every dimension is `0`, so nothing would participate in the ranking. */
  | { readonly code: 'all_zero' };

/** The reader-facing sentence for a problem, or `null` when there is none. */
export const PREFERENCE_PROBLEM_TEXT: Readonly<Record<'all_zero' | 'unusable_value', string>> = Object.freeze({
  all_zero: '至少有一项重要程度需要大于 0。',
  unusable_value: '偏好值必须是 0 到 10 之间的整数。',
});

/**
 * Check a set of importances before it is sent.
 *
 * All-zero is REFUSED rather than replaced with the defaults. The user has just said that none of the four dimensions matters, which is not
 * a ranking this engine can produce; substituting the defaults would silently overrule what they chose, and a product that does that teaches
 * people their settings do not stick.
 *
 * @param values - the four importances.
 * @returns `null` when the set is usable, otherwise the problem.
 */
export function preferenceProblemOf(values: Readonly<Record<string, unknown>>): PreferenceProblem | null {
  for (const { key } of PREFERENCE_CONTROLS) {
    if (!isUsableImportance(values[key])) return { code: 'unusable_value', key };
  }
  const total = PREFERENCE_CONTROLS.reduce((sum, { key }) => sum + (values[key] as number), 0);
  return total === 0 ? { code: 'all_zero' } : null;
}

/**
 * The proportion each importance represents, as a whole percentage.
 *
 * Display only. The four values are divided by their own total, so they always describe the SAME set the user is looking at and no slider
 * is ever changed to make them fit. Rounding is applied per control; the displayed figures may therefore total 99 or 101, which is why the
 * column is labelled as an approximation of the ratio rather than presented as a sum that must reach 100.
 *
 * @param values - the four importances.
 * @returns the percentage for each control, in {@link PREFERENCE_CONTROLS} order.
 */
export function preferencePercentagesOf(values: Readonly<Record<string, number>>): number[] {
  const total = PREFERENCE_CONTROLS.reduce((sum, { key }) => sum + (values[key] ?? 0), 0);
  // A zero total has no proportion to report. `preferenceProblemOf` refuses it, so this is a guard rather than a state the UI shows.
  if (total <= 0) return PREFERENCE_CONTROLS.map(() => 0);
  return PREFERENCE_CONTROLS.map(({ key }) => Math.round(((values[key] ?? 0) / total) * 100));
}

/**
 * The engine-facing payload for a set of importances.
 *
 * The four relative values and nothing else: no normalisation, no rounding into weights, no key renaming. The engine's own
 * `normalizePreferences` is the single authority on what they become, and a second normaliser here is exactly the duplication this shape
 * avoids. `studentSentiment` is deliberately not emitted — it is the same weight as `overallScore` and the product names it once.
 *
 * @param values - the four importances.
 * @returns the payload to send.
 */
export function preferencePayloadOf(values: Readonly<Record<string, number>>): Record<PreferenceKey, number> {
  return {
    gradeFriendliness: values.gradeFriendliness ?? 0,
    workloadFriendliness: values.workloadFriendliness ?? 0,
    attendanceFriendliness: values.attendanceFriendliness ?? 0,
    overallScore: values.overallScore ?? 0,
  };
}

/** Whether two sets of importances are the same, so a caller can tell "changed" from "unchanged". */
export function samePreferenceValues(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): boolean {
  return PREFERENCE_CONTROLS.every(({ key }) => left[key] === right[key]);
}
