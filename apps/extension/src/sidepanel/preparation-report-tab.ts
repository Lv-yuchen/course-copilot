/**
 * Which tab a preparation report belongs to.
 *
 * ## Why this is its own module rather than a line in the panel
 *
 * The answer changed when the worker started relaying preparation events, and the change is the kind that is easy to get subtly wrong: a relayed message
 * arrives with the SERVICE WORKER as its sender, so reading `sender.tab.id` on a relayed report yields `undefined` — and an `undefined` tab id is not a
 * harmless miss. The panel's ownership check compares it against the tab the operation belongs to, so every relayed report would be discarded as foreign and
 * the panel would sit in a running phase forever. That was the release blocker this module closes.
 *
 * The rule therefore has to be reachable by a test without opening a browser, so it lives here and is exercised directly.
 *
 * ## Two delivery paths, one rule
 *
 * A report can arrive by either of two routes, and both must work:
 *
 *  - **Relayed by the worker.** The worker stamps the ORIGINAL sender's tab id onto the message as `sourceTabId`, because it is the only party that can still
 *    see the content script as the sender. That field is the authority here.
 *  - **Directly from the content script.** A report may also reach an extension page without the worker. Then the browser's own `sender.tab.id` is the
 *    authority, and it is the only trustworthy one: a payload field could say anything, which is why `sourceTabId` is consulted FIRST but only accepted when it
 *    is a real tab id.
 *
 * ## What is deliberately NOT accepted
 *
 * A report with neither field usable is rejected rather than guessed at — and rejection is the safe direction. An unattributable report cannot be assigned to
 * the current operation, and inventing an owner would let one page's progress be rendered as another's. The caller drops it, exactly as it drops a report
 * from a tab that is not the operation's.
 */

/** Whether a value is usable as a browser tab id: a positive integer, as `chrome.tabs` produces. */
export function isTabId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Resolve the tab a relayed-or-direct preparation report belongs to.
 *
 * @param payload - the message body, which may carry the worker's `sourceTabId` stamp.
 * @param senderTabId - the browser's record of the sending tab, or `undefined` when the sender is not a tab.
 * @returns the owning tab id, or `null` when no usable owner is present.
 */
export function preparationReportTabIdOf(payload: unknown, senderTabId: unknown): number | null {
  const record = typeof payload === 'object' && payload !== null ? (payload as { sourceTabId?: unknown }) : {};
  /*
   * The worker's stamp wins, because on that route the sender is the worker and `senderTabId` describes the relay rather than the report.
   */
  if (isTabId(record.sourceTabId)) return record.sourceTabId;
  if (isTabId(senderTabId)) return senderTabId;
  return null;
}
