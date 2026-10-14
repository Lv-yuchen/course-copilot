/**
 * Forwarding for the three auto-expand control messages.
 *
 * ## What this module is, and what it deliberately is not
 *
 * A relay. It validates a tab id, asks that tab's content script one question, and returns whatever came back. It does not run the expansion, hold any
 * session state, wait for a session to finish, or know anything about the page — no selector, no marker, no click. The session lives in the content
 * script, which is the only layer that has the DOM and the only one whose lifetime covers a whole expansion.
 *
 * That division is what the architecture audit settled, and this file is the part of it that must stay thin: a worker that learned about `#more` or
 * started remembering clicks would be a second implementation of rules that already exist one layer down.
 */

/** The message types the worker forwards, all of them addressed to a tab. */
const FORWARDED_TYPES = {
  start: 'COURSE_COPILOT_START_AUTO_EXPAND',
  cancel: 'COURSE_COPILOT_CANCEL_AUTO_EXPAND',
  status: 'COURSE_COPILOT_QUERY_AUTO_EXPAND_STATUS',
} as const;

/**
 * One fixed sentence for every forwarding failure.
 *
 * The three causes — an unusable tab id, a rejected `sendMessage`, a reply that cannot be used — are not distinguished for the caller, because its next
 * move is identical in all three: it has no session information and must not act as though it does. Keeping one string also means no internal detail
 * (a tab id, a URL, an error message) can reach the panel.
 */
const FORWARD_FAILURE_TEXT = '无法与该标签页的课程页面通信。';

/**
 * Whether a value is a tab id the extension can send to.
 *
 * Integers only, and positive: these reach `chrome.tabs.sendMessage`, and a fractional or negative id would be a malformed request rather than a tab
 * that happens to be missing. `Number.isInteger` is also what the row transport uses, so the two agree on what "a tab id" means.
 *
 * @param value - the value to inspect.
 * @returns true when it may be used as a tab id.
 */
export function isUsableTabId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Ask one tab's content script one of the control questions.
 *
 * ## Why the reply is passed through rather than checked here
 *
 * The content script owns the answer's meaning, and this worker has no business re-deriving it: a second opinion about whether a reply is well formed
 * would be a second definition of the session contract, and the two would drift. The only thing decided here is whether a reply arrived at all, because
 * "nothing came back" is a transport fact this layer is the one to observe.
 *
 * ## Why nothing is retried or repaired
 *
 * No retry, no `scripting.executeScript` to inject a missing content script, and no page reload. All three would turn one failed ask into an unbounded or
 * page-modifying operation, and a tab that cannot answer is an answer.
 *
 * @param tabId - the tab to ask; validated here so a malformed request never reaches the tabs API.
 * @param type - which control message to send.
 * @returns the content script's reply, or one fixed failure.
 */
export async function forwardAutoExpandMessage(
  tabId: unknown,
  type: (typeof FORWARDED_TYPES)[keyof typeof FORWARDED_TYPES],
): Promise<AutoExpandForwarded | AutoExpandForwardFailure> {
  if (!isUsableTabId(tabId)) return { ok: false, error: FORWARD_FAILURE_TEXT };

  try {
    const reply: unknown = await chrome.tabs.sendMessage(tabId, { type });
    /*
     * A content script always answers with an object. A `null`, a primitive or anything else means the reply was not usable, which is reported as the
     * same failure as not having reached the tab at all — the caller cannot do anything different with it.
     */
    if (typeof reply !== 'object' || reply === null) return { ok: false, error: FORWARD_FAILURE_TEXT };
    return { ok: true, reply };
  } catch {
    // A rejected send means no content script, a closed tab, or a page that is not the supported one. All ordinary, none retried.
    return { ok: false, error: FORWARD_FAILURE_TEXT };
  }
}

/** The three types, exported as data so a caller and its tests name them from one place. */
export { FORWARDED_TYPES, FORWARD_FAILURE_TEXT };
