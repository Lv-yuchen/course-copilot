/// <reference path="../types/chrome.d.ts" />
/// <reference path="../types/globals.d.ts" />

/**
 * The worker's transport primitive for the full-visible-row contract.
 *
 * ## What this is
 *
 * `COURSE_COPILOT_QUERY_VISIBLE_ROWS` is an EXISTING content-side contract: the content script already answers it from the live
 * page with `{ rows: RowIdentity[] }`. What was missing was a worker-side way to ask. This module is that way, and nothing else.
 *
 * ## What it deliberately is not
 *
 * It is a TRANSPORT PRIMITIVE, not a pipeline stage. It does not cache, clone, normalize or re-scan the rows; it does not compute a
 * recommendation; and it does not touch the worker's own memory — `knownStatus`, `knownPanelCount` and `reportingTabIds` are the
 * status path's state, and a full-row request is a different question with a different answer. A caller that wants a failure to
 * change the worker's view of a tab must decide that itself; this function reports "no rows" and stops there.
 *
 * That separation is why the rows are not cached even though the request is not free. The status path deliberately forwards rows
 * without storing them (`"keeping a copy here would create a second, staler source"`), and this path returns far more of them. The
 * page can change between calls, so a remembered answer could describe a page that no longer exists.
 *
 * ## Who owns the tab id
 *
 * The CALLER supplies it, and `unknown` is the parameter type on purpose: the only reliable source is the message that triggered
 * the request — the panel reads the active tab's id, and a content-script message carries `sender.tab.id`. The worker's own record
 * of reporting tabs lives in memory and is lost when Manifest V3 suspends it, so it must never be treated as authoritative. Taking
 * `unknown` lets a caller pass `message.tabId` straight through while this module owns the one numeric validation.
 *
 * ## Why this module names its ambient types
 *
 * Every other background module so far has been self-contained: `chrome` and `RowIdentity` are GLOBAL declarations in this
 * project's `apps/extension/src/types/chrome.d.ts`, and only the two runtime ENTRY points (the worker and the content script) used
 * them, both of which the extension's own config type-checks. This is the first background LIBRARY module to need them, and the
 * repository root's program includes no `.d.ts` at all — measured, not assumed. The `reference` above is that dependency stated
 * explicitly, so the module type-checks wherever it is compiled from.
 *
 * @module
 */

/** The existing content-side message this module sends. Not a new type: it is already part of the extension's message union. */
const QUERY_VISIBLE_ROWS_MESSAGE = 'COURSE_COPILOT_QUERY_VISIBLE_ROWS';

/** What one ask of a tab's content script produced. */
export interface VisibleRowsSnapshot {
  /**
   * How the ask itself went.
   *
   * - `ok` — a content script answered, and its reply was usable.
   * - `unavailable` — no usable answer: an unusable tab id, no content script in the tab, or a rejected `sendMessage`.
   * - `malformed` — something answered, but not in the agreed shape.
   *
   * `unavailable` and `malformed` are kept apart because they call for different responses: the first usually means "you are not on the page",
   * the second means the extension and its own content script disagree about the contract.
   */
  readonly read: 'ok' | 'unavailable' | 'malformed';
  /**
   * The content script's verdict on the page, when it answered.
   *
   * ABSENT when nothing usable answered rather than `false`: `false` would be the script's opinion, and there was no script opinion to report.
   */
  readonly supported?: boolean;
  /**
   * The page's own completeness signal, when the script reported one.
   *
   * ABSENT — not a fabricated `unknown` — on anything other than a usable answer from the supported page. There is a real difference between "the
   * page said unknown" and "nobody told us", and only the second is a transport outcome.
   */
  readonly loadState?: CourseListLoadState;
  /** The rows reported. Empty whenever `read !== 'ok'`, because nothing readable was obtained. */
  readonly rows: RowIdentity[];
}

/**
 * Ask one tab's content script for every valid teaching-class row currently loaded.
 *
 * Every failure is REPORTED rather than thrown, and reported as WHICH failure it was: the caller used to receive `[]` for an unusable tab, a
 * missing content script, a rejected message, an unsupported page and a genuinely empty page alike, so it could not tell "I could not read" from
 * "there was nothing to read". No retry, no injection and no reload — the caller learns what happened and decides what it means.
 *
 * @param tabId - the tab to ask. Accepted as `unknown` because it arrives from a message; only a number is usable.
 * @returns the snapshot: how the ask went, the page verdict when there was one, and the rows.
 */
export async function requestVisibleRows(tabId: unknown): Promise<VisibleRowsSnapshot> {
  /*
   * The one validation, in the one place. A non-number means no tab can be named, so nothing is sent.
   *
   * The check is `Number.isInteger` rather than `typeof === 'number'`, and that is a measured correction: `7.5` passes a
   * `typeof` test, and the test suite caught it being sent. A tab id is a whole number, and sending a fractional one would be a
   * request the browser cannot satisfy.
   */
  if (!Number.isInteger(tabId)) return { read: 'unavailable', rows: [] };
  /*
   * The narrowed value is bound explicitly, because `Number.isInteger` has no TYPE PREDICATE in the standard library — measured on
   * TypeScript 5.9.3, where the guard above leaves the parameter typed as `unknown` and the call below refuses it. The assertion is
   * therefore a statement of what the guard just proved, not a bypass of it: nothing reaches the cast without passing the check.
   */
  const usableTabId = tabId as number;

  let reply: unknown;
  try {
    reply = await chrome.tabs.sendMessage(usableTabId, { type: QUERY_VISIBLE_ROWS_MESSAGE });
  } catch {
    /*
     * The expected outcome when the tab has no content script: an ordinary page, or the extension was reloaded while the page stayed open. The
     * browser reports both as a rejected message, and neither is distinguishable from the other here.
     */
    return { read: 'unavailable', rows: [] };
  }

  /*
   * Shape-checked before use, with the reply treated as `unknown`. The content script is the only intended producer, but a response crossing a
   * process boundary is data rather than a guarantee, so the fields are inspected rather than assumed.
   */
  if (typeof reply !== 'object' || reply === null) return { read: 'malformed', rows: [] };
  const record = reply as { supported?: unknown; rows?: unknown; loadState?: unknown };
  if (typeof record.supported !== 'boolean') return { read: 'malformed', rows: [] };
  if (!Array.isArray(record.rows)) return { read: 'malformed', rows: [] };
  /*
   * The load state is carried through as the script shaped it, after a shape check: it crosses a process boundary, so its fields are inspected
   * rather than trusted. A reply whose `loadState` is not the agreed object is treated as having reported none, because the rows themselves might
   * still be perfectly usable and discarding them over a diagnostic field would throw away good data.
   */
  const loadState = isLoadState(record.loadState) ? record.loadState : undefined;
  /*
   * A SUPPORTED PAGE THAT REPORTED NO LOAD STATE COULD NOT BE READ.
   *
   * The script answers `supported: true` only for the one page it operates on, and it reports a load state exactly when that page's course list exists — the
   * state describes the list, so there is nothing to report without one. Measured in 16J-PREUI-E4-B2-R2: with the list missing, `rows` is empty while the
   * markers OUTSIDE the list still described a half-loaded course list, so the reply was indistinguishable from a genuinely empty page.
   *
   * Reported as `malformed` rather than `ok`, because `ok` would claim the read succeeded and "this page has no courses" is a claim the extension is not
   * entitled to make about a page whose course list it could not find. An UNSUPPORTED page is unaffected: it legitimately reports no load state and stays
   * `ok`, because recognising a page this extension does not operate on is a success rather than a structural failure.
   */
  if (record.supported && loadState === undefined) {
    /*
     * The rows are still carried back: they were read, and discarding them would lose data over a diagnostic. What is withheld is the load state and the
     * `ok` verdict, because neither can be honestly given for a page whose course list could not be found.
     */
    return { read: 'malformed', supported: true, rows: record.rows as RowIdentity[] };
  }
  return {
    read: 'ok',
    supported: record.supported,
    ...(loadState === undefined ? {} : { loadState }),
    rows: record.rows as RowIdentity[],
  };
}

/**
 * Whether a value is the agreed {@link CourseListLoadState} shape.
 *
 * Checked field by field rather than accepted wholesale, because the value arrives from another process. A partially-shaped object is treated as
 * absent instead of being coerced: an invented `false` for a missing `moreVisible` would read as "no more rows" and could be mistaken for a
 * finished list.
 *
 * @param value - the value to inspect.
 * @returns true when every field is present with the right primitive type.
 */
function isLoadState(value: unknown): value is CourseListLoadState {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.morePresent !== 'boolean') return false;
  if (typeof record.moreVisible !== 'boolean') return false;
  if (typeof record.endSignPresent !== 'boolean') return false;
  if (typeof record.endSignVisible !== 'boolean') return false;
  return record.completeness === 'partial' || record.completeness === 'complete' || record.completeness === 'unknown';
}
