/**
 * The side panel's auto-load controller: one approved click, then a bounded expansion.
 *
 * ## What this owns, and what it deliberately does not
 *
 * This is the panel's own small state machine for ONE feature — "load every course the page will give us". It is kept separate from the recommendation
 * request controller rather than merged into it, because the two answer different questions and a shared state machine would have to invent a
 * relationship between them that the product does not have yet. Merging them is a later decision, and it can only be made honestly while they are
 * still separable.
 *
 * ## Why it holds no result data
 *
 * The only persistent state is which TAB the running operation belongs to. No clicks count, no completeness, no session snapshot: those live in the
 * content script, which is the only place that can observe them, and a copy here would be a second source of truth that goes stale the moment the
 * service worker is suspended. The panel holds the tab id because the tab id is the one fact the panel is authoritative about — it can ask the browser
 * which tab is active, and nothing else in the extension reliably can.
 *
 * ## The approval is the click
 *
 * `start()` is called from one place: a user pressing the button. Nothing in this module starts anything on its own, and the panel's startup path calls
 * {@link AutoLoadController.restore} instead, which reads.
 */

/** Where the panel is in one operation. */
export type AutoLoadPhase = 'idle' | 'starting' | 'running' | 'finished' | 'error';

/** What the panel shows. Derived from the phase and, when finished, from why it stopped. */
export interface AutoLoadView {
  readonly phase: AutoLoadPhase;
  /** Whether the primary button should be offered. */
  readonly canStart: boolean;
  /** Whether the cancel control should be offered. */
  readonly canCancel: boolean;
  /** Batches loaded so far. A count of CLICKS, never of courses — see {@link clicksLabel}. */
  readonly clicks: number;
  /** The line above the controls, or `null` when the phase needs no line of its own. */
  readonly message: string | null;
}

/**
 * The controller's outward contract.
 *
 * `onView` is called on every change, including the first, so the panel has one place to render from.
 */
export interface AutoLoadController {
  /** A user approved a load. Reads the tab fresh, sends START, and returns nothing. */
  readonly start: () => Promise<void>;
  /**
   * A user asked to stop.
   *
   * It re-reads the tab before sending, so a cancel cannot land on a tab the user has since left, and it does NOT claim the operation stopped — the
   * authoritative answer is the finished event or a later status read.
   */
  readonly cancel: () => Promise<void>;
  /**
   * Recover the current tab's session without starting anything.
   *
   * Called on panel open, and again whenever the panel wants the truth. It reads only: a status reply of `idle` leaves the feature idle.
   */
  readonly restore: () => Promise<void>;
  /**
   * Feed one event from the content script.
   *
   * @param tabId - the tab that sent it, taken from the message sender rather than from the payload.
   * @returns nothing.
   */
  readonly onEvent: (tabId: number | null, event: { phase?: unknown; clicks?: unknown; completeness?: unknown; stopReason?: unknown }) => void;
  /** The current view. */
  readonly view: () => AutoLoadView;
}

/** Injectable seams, so the controller can be driven without a browser. */
export interface AutoLoadControllerOptions {
  /** Called whenever the view changes. */
  readonly onView: (view: AutoLoadView) => void;
  /** The active tab's id, or `null`. Defaults to `chrome.tabs.query`. */
  readonly queryActiveTabId?: () => Promise<number | null>;
  /** Send one message. Defaults to `chrome.runtime.sendMessage`. */
  readonly sendMessage?: (message: RuntimeMessage) => Promise<unknown>;
}

/** The panel-facing wording. Each sentence belongs to exactly one situation; none of them is shared. */
export const AUTO_LOAD_MESSAGES = {
  starting: '正在开始自动加载…',
  running: '正在加载全部课程…',
  cancelled: '已停止自动加载。后续推荐只能基于当前已加载的课程。',
  unknown: '无法确认课程列表是否已全部加载。后续推荐只能基于当前已加载的课程。',
  noProgress: '课程列表没有继续加载，已停止。后续推荐只能基于当前已加载的课程。',
  failed: '自动加载课程失败。后续推荐只能基于当前已加载的课程。',
  cap: '达到自动加载上限，仍无法确认已全部加载。后续推荐只能基于当前已加载的课程。',
} as const;

/** The success sentence, used for both `complete` and `already_complete`. */
export const AUTO_LOAD_COMPLETE_TEXT = '✓ 课程列表已全部加载';

/**
 * The progress line's second half.
 *
 * Deliberately a count of BATCHES, not of courses: one click adds a batch whose size varies — measured on the live page, ten panels carrying between
 * ten and thirty teaching-class rows — so "已加载 N 门课程" would be a number the extension cannot compute. The label says what is actually counted.
 *
 * @param clicks - how many batches have been requested.
 * @returns the label.
 */
export function clicksLabel(clicks: number): string {
  return `已展开 ${clicks} 批`;
}

/**
 * The active tab's id, or `null`. Never throws.
 *
 * `chrome` is taken from the global scope rather than imported, because this module is bundled into a page that already has it. A caller that wants a
 * different source injects one, which is how the tests drive every path without a browser.
 */
async function readActiveTabId(): Promise<number | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const first = Array.isArray(tabs) ? tabs[0] : undefined;
    const id = first?.id;
    // Integer only, the same rule the transport applies: a fractional id names no tab the browser can be asked about.
    return typeof id === 'number' && Number.isInteger(id) ? id : null;
  } catch {
    // A failed query means no tab can be named, which is a state the caller handles rather than an exception it must catch.
    return null;
  }
}

/**
 * Turn a stop reason into what the panel says.
 *
 * Every reason gets its own sentence, because they mean different things to the user: a completed list, a user-initiated stop, a page that stopped
 * answering, a page that stopped growing, a hard failure, and a budget that ran out are six different situations. Collapsing them would tell a user
 * their list is fine when it is not.
 *
 * @param stopReason - the reason reported by the content script.
 * @returns the sentence to show.
 */
export function messageForStopReason(stopReason: unknown): string {
  switch (stopReason) {
    case 'complete':
    case 'already_complete':
      return AUTO_LOAD_COMPLETE_TEXT;
    case 'cancelled':
      return AUTO_LOAD_MESSAGES.cancelled;
    case 'no_progress':
      return AUTO_LOAD_MESSAGES.noProgress;
    case 'click_failed':
    case 'wait_failed':
      return AUTO_LOAD_MESSAGES.failed;
    case 'click_cap':
      return AUTO_LOAD_MESSAGES.cap;
    default:
      // `unknown_state` and anything unrecognised: the honest position is that completeness could not be established.
      return AUTO_LOAD_MESSAGES.unknown;
  }
}

/** Whether a stop reason means the list is known to be whole. */
function isSuccess(stopReason: unknown): boolean {
  return stopReason === 'complete' || stopReason === 'already_complete';
}

/**
 * Create the controller.
 *
 * @param options - the view sink and, for tests, injectable seams.
 * @returns the controller.
 */
export function createAutoLoadController(options: AutoLoadControllerOptions): AutoLoadController {
  const { onView } = options;
  const queryActiveTabId = options.queryActiveTabId ?? readActiveTabId;
  const sendMessage = options.sendMessage ?? ((message: RuntimeMessage) => chrome.runtime.sendMessage(message));

  /*
   * THE ONLY PERSISTENT STATE.
   *
   * `operationTabId` is what makes cross-tab events safe: an event is applied only when the tab that sent it is the tab this operation belongs to.
   * Everything else below is a display value, and none of it is a claim the content script has not made.
   */
  let operationTabId: number | null = null;
  let phase: AutoLoadPhase = 'idle';
  let clicks = 0;
  let message: string | null = null;

  /** The view for the current state, so the renderer never assembles one itself. */
  function buildView(): AutoLoadView {
    return {
      phase,
      canStart: phase === 'idle' || phase === 'finished' || phase === 'error',
      canCancel: phase === 'starting' || phase === 'running',
      clicks,
      message,
    };
  }

  function publish(): void {
    onView(buildView());
  }

  /*
   * Publish the starting view immediately, so the sink is never left guessing what to render before the first change. A sink that only heard about
   * changes would have nothing to show on a panel that opens onto an idle feature, and the panel would have to invent that state itself.
   */
  publish();

  /** Move to a phase and, unless it is `running`, replace the message. */
  function set(showPhase: AutoLoadPhase, text: string | null): void {
    phase = showPhase;
    message = text;
    publish();
  }

  return {
    async start(): Promise<void> {
      /*
       * A second start while one is running must not create a second loop. The content script refuses it too, and this is the panel's half of that
       * agreement: pressing the button again during a run is a no-op rather than a duplicate request.
       */
      if (phase === 'starting' || phase === 'running') return;

      // Read the active tab NOW. Reusing an id captured when the panel opened would send the command to whichever tab was active then.
      const tabId = await queryActiveTabId();
      if (tabId === null) {
        set('error', AUTO_LOAD_MESSAGES.failed);
        return;
      }
      operationTabId = tabId;
      clicks = 0;
      set('starting', AUTO_LOAD_MESSAGES.starting);

      let response: unknown;
      try {
        response = await sendMessage({ type: 'COURSE_COPILOT_START_AUTO_EXPAND', tabId });
      } catch {
        // The worker was unreachable, so nothing was accepted. Reported rather than retried.
        set('error', AUTO_LOAD_MESSAGES.failed);
        return;
      }

      const record = typeof response === 'object' && response !== null
        ? (response as { ok?: unknown; reply?: unknown; error?: unknown })
        : {};

      if (record.ok !== true) {
        // A refusal or a forwarding failure. The session is NOT claimed to be running.
        set('error', typeof record.error === 'string' ? record.error : AUTO_LOAD_MESSAGES.failed);
        return;
      }

      const reply = typeof record.reply === 'object' && record.reply !== null
        ? (record.reply as { accepted?: unknown; status?: { phase?: unknown; clicks?: unknown } })
        : {};
      const status = reply.status ?? {};

      if (reply.accepted === false) {
        /*
         * The content script already had a session running for this tab. That is not a failure: the operation IS running, and the honest response is
         * to resume showing it rather than to start a second one or claim an error.
         */
        if (status.phase === 'running') {
          clicks = typeof status.clicks === 'number' ? status.clicks : 0;
          set('running', null);
          return;
        }
        // Accepted false for any other reason means this tab has nothing to resume.
        set('error', AUTO_LOAD_MESSAGES.failed);
        return;
      }

      clicks = typeof status.clicks === 'number' ? status.clicks : 0;
      set('running', null);
    },

    async cancel(): Promise<void> {
      // Nothing to cancel, so nothing is sent. A cancel on an idle panel must not reach the page.
      if (phase !== 'running' && phase !== 'starting') return;
      // Re-read the tab: the user may have switched windows since the operation started.
      const tabId = await queryActiveTabId();
      if (tabId === null || tabId !== operationTabId) {
        /*
         * The active tab is not the tab this operation belongs to. Cancelling the wrong tab would stop someone else's operation, so the request is
         * dropped — and the panel keeps showing the operation it actually has.
         */
        return;
      }
      try {
        await sendMessage({ type: 'COURSE_COPILOT_CANCEL_AUTO_EXPAND', tabId });
      } catch {
        // A failed cancel leaves the session running; the finished event or a later status read is still the authority.
        return;
      }
      /*
       * The panel does NOT write a stop reason here. The content script decides whether the run actually stopped, and until its finished event
       * arrives the honest display is "still cancelling" — the running line stays, which is why nothing is published at this point.
       */
    },

    async restore(): Promise<void> {
      const tabId = await queryActiveTabId();
      if (tabId === null) return;

      let response: unknown;
      try {
        response = await sendMessage({ type: 'COURSE_COPILOT_QUERY_AUTO_EXPAND_STATUS', tabId });
      } catch {
        // Unreachable worker: leave the display as it is rather than inventing a state.
        return;
      }

      const record = typeof response === 'object' && response !== null
        ? (response as { ok?: unknown; reply?: unknown })
        : {};
      if (record.ok !== true) return;
      const reply = typeof record.reply === 'object' && record.reply !== null
        ? (record.reply as { status?: { phase?: unknown; clicks?: unknown; stopReason?: unknown } })
        : {};
      const status = reply.status;
      if (typeof status !== 'object' || status === null) return;

      // The recovered session becomes this panel's operation, so later events from that tab are accepted rather than treated as foreign.
      operationTabId = tabId;
      clicks = typeof status.clicks === 'number' ? status.clicks : 0;

      if (status.phase === 'running') {
        set('running', null);
        return;
      }
      if (status.phase === 'finished') {
        set('finished', messageForStopReason(status.stopReason));
        return;
      }
      // `idle`, or a phase this panel does not know: idleness is the only safe reading, and it starts nothing.
      set('idle', null);
    },

    onEvent(tabId, event): void {
      /*
       * The isolation rule, in one comparison. An event from another tab is not this operation's news: applying it would attribute one page's progress
       * to another, which is exactly the confusion this guard exists to prevent.
       */
      if (tabId === null || operationTabId === null || tabId !== operationTabId) return;

      if (event.phase === 'progress') {
        clicks = typeof event.clicks === 'number' ? event.clicks : clicks;
        // Progress never changes the phase: a running operation stays running until it reports that it finished.
        if (phase === 'starting') phase = 'running';
        message = null;
        publish();
        return;
      }

      if (event.phase === 'finished') {
        clicks = typeof event.clicks === 'number' ? event.clicks : clicks;
        set('finished', messageForStopReason(event.stopReason));
      }
    },

    view: buildView,
  };
}

/** A stop reason the panel treats as a whole list. Exported so a test can name the pair rather than repeat the strings. */
export const AUTO_LOAD_SUCCESS_REASONS = ['complete', 'already_complete'] as const;

/** Whether a stop reason means the list is whole. */
export { isSuccess as autoLoadSucceeded };
