/**
 * Forwarding for the three full-preparation control messages.
 *
 * ## Why this is a third small module
 *
 * The same reasoning as the teacher-hydration relay: a relay is a few lines, and the three relays differ in nothing but their message names. Merging them
 * would buy those lines at the cost of a generic abstraction whose only callers live in this folder, and the next reader would have to learn a framework to
 * follow three string comparisons.
 *
 * ## What this module is not
 *
 * It does not run the preparation, does not hold its phase or either phase's summary, and does not know a selector. It validates a tab id, asks that tab's
 * content script one question, and returns whatever came back. The run lives in the content script, which is the only layer that has the DOM and whose
 * lifetime covers two passes over the page.
 */

/** The message types this relay forwards, all of them addressed to a tab. */
const PREPARATION_FORWARDED_TYPES = {
  start: 'COURSE_COPILOT_START_FULL_PREPARATION',
  cancel: 'COURSE_COPILOT_CANCEL_FULL_PREPARATION',
  status: 'COURSE_COPILOT_QUERY_FULL_PREPARATION_STATUS',
} as const;

/**
 * One fixed sentence for every forwarding failure.
 *
 * The three causes — an unusable tab id, a rejected `sendMessage`, a reply that cannot be used — are not distinguished for the caller, because its next move
 * is identical in all three: it has no session information and must not act as though it does. One string also means no internal detail can reach a panel.
 */
const PREPARATION_FORWARD_FAILURE_TEXT = '无法与该标签页的课程页面通信。';

/**
 * Ask one tab's content script one of the preparation control questions.
 *
 * ## Why the reply is passed through rather than checked here
 *
 * The content script owns the answer's meaning, and a second opinion about whether a reply is well formed would be a second definition of the session
 * contract. The only thing decided here is whether a reply arrived at all, because that is the transport fact this layer is the one to observe.
 *
 * ## Why nothing is retried or repaired
 *
 * No retry, no injection of a missing content script, and no page reload. Each would turn one failed ask into an unbounded or page-modifying operation, and a
 * tab that cannot answer is an answer.
 *
 * @param tabId - the tab to ask; validated here so a malformed request never reaches the tabs API.
 * @param type - which control message to send.
 * @returns the content script's reply, or one fixed failure.
 */
export async function forwardPreparationMessage(
  tabId: unknown,
  type: (typeof PREPARATION_FORWARDED_TYPES)[keyof typeof PREPARATION_FORWARDED_TYPES],
): Promise<AutoExpandForwarded | AutoExpandForwardFailure> {
  if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId <= 0) {
    return { ok: false, error: PREPARATION_FORWARD_FAILURE_TEXT };
  }

  try {
    const reply: unknown = await chrome.tabs.sendMessage(tabId, { type });
    // A content script always answers with an object. Anything else is as unusable as not having reached the tab, and is reported the same way.
    if (typeof reply !== 'object' || reply === null) return { ok: false, error: PREPARATION_FORWARD_FAILURE_TEXT };
    return { ok: true, reply };
  } catch {
    // A rejected send means no content script, a closed tab, or a page that is not the supported one. All ordinary, none retried.
    return { ok: false, error: PREPARATION_FORWARD_FAILURE_TEXT };
  }
}

/** The three types, exported as data so a caller and its tests name them from one place. */
export { PREPARATION_FORWARDED_TYPES, PREPARATION_FORWARD_FAILURE_TEXT };
