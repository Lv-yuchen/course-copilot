/**
 * Forwarding for the three availability-filter control messages.
 *
 * ## Why this is a fourth sibling rather than a generalised relay
 *
 * A relay is a few lines, and the four features' relays differ in nothing but their message names. Merging them into one parameterised helper would buy
 * those lines at the cost of a generic abstraction whose only callers are all in this folder — and the next reader would have to learn a framework to
 * follow three string comparisons. Sibling modules are the smaller thing, and that decision was recorded when the second one was written.
 *
 * ## What this module is not
 *
 * It does not operate the filter, hold a session, look at the page, or wait for one to finish. It validates a tab id, asks that tab's content script one
 * question, and returns whatever came back. The session lives in the content script, which is the only layer that has the DOM — and the filter it drives
 * is the page's own, not something this layer could reach.
 */

/** The message types this relay forwards, all of them addressed to a tab. */
const AVAILABILITY_FILTER_FORWARDED_TYPES = {
  start: 'COURSE_COPILOT_START_AVAILABILITY_FILTER',
  cancel: 'COURSE_COPILOT_CANCEL_AVAILABILITY_FILTER',
  status: 'COURSE_COPILOT_QUERY_AVAILABILITY_FILTER_STATUS',
} as const;

/**
 * One fixed sentence for every forwarding failure.
 *
 * The three causes — an unusable tab id, a rejected `sendMessage`, a reply that cannot be used — are not distinguished for the caller, because its next move
 * is identical in all three: it has no session information and must not act as though it does. One string also means no internal detail can reach a panel.
 */
const AVAILABILITY_FILTER_FORWARD_FAILURE_TEXT = '无法与该标签页的课程页面通信。';

/**
 * Ask one tab's content script one of the availability-filter control questions.
 *
 * The reply is passed through rather than inspected, on the same reasoning as the other relays: the content script owns the answer's meaning, and a second
 * opinion about what a well-formed reply looks like would be a second definition of the session contract. The only thing decided here is whether a reply
 * arrived, because that is the transport fact this layer is the one to observe.
 *
 * No retry, no injection of a missing content script, and no reload: each would turn one failed ask into an unbounded or page-modifying operation.
 *
 * @param tabId - the tab to ask; validated here so a malformed request never reaches the tabs API.
 * @param type - which control message to send.
 * @returns the content script's reply, or one fixed failure.
 */
export async function forwardAvailabilityFilterMessage(
  tabId: unknown,
  type: (typeof AVAILABILITY_FILTER_FORWARDED_TYPES)[keyof typeof AVAILABILITY_FILTER_FORWARDED_TYPES],
): Promise<AutoExpandForwarded | AutoExpandForwardFailure> {
  if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId <= 0) {
    return { ok: false, error: AVAILABILITY_FILTER_FORWARD_FAILURE_TEXT };
  }

  try {
    const reply: unknown = await chrome.tabs.sendMessage(tabId, { type });
    // A content script always answers with an object. Anything else is as unusable as not having reached the tab, and is reported the same way.
    if (typeof reply !== 'object' || reply === null) return { ok: false, error: AVAILABILITY_FILTER_FORWARD_FAILURE_TEXT };
    return { ok: true, reply };
  } catch {
    // A rejected send means no content script, a closed tab, or a page that is not the supported one. All ordinary, none retried.
    return { ok: false, error: AVAILABILITY_FILTER_FORWARD_FAILURE_TEXT };
  }
}

/** The three types, exported as data so a caller and its tests name them from one place. */
export { AVAILABILITY_FILTER_FORWARDED_TYPES, AVAILABILITY_FILTER_FORWARD_FAILURE_TEXT };
