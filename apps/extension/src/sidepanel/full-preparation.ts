/**
 * The side panel's controller for ONE approved full-course preparation.
 *
 * ## What one approval buys
 *
 * Pressing the button is the user's approval for the whole preparation: load every course the page will give us, fill in the teacher data those panels hide until
 * they are expanded, and read the finished page back. The two page interactions are read-only and both happen inside that single approval, which is exactly why
 * the copy beside the button has to name BOTH of them — a user who approved "load the list" has not approved "expand course details", and the panel must not
 * quietly widen what was agreed to.
 *
 * ## What this does NOT do yet
 *
 * It produces no recommendation and requests none. It stops at the prepared page, which is a coherent place to stop: the recommendation chain is a separate
 * concern with its own failure modes, and mixing the two would make a page-interaction bug indistinguishable from a ranking bug.
 *
 * ## Why it holds no page data
 *
 * The only persistent state is which TAB the operation belongs to. No row counts, no panel counts, no phase summary: the content script is the only layer that
 * can observe those, and a copy here would be a second source of truth that goes stale the moment the service worker is suspended. What the panel DOES keep is
 * the last status the content script reported, because it has to render a finished run — and that snapshot is always labelled as a report rather than as
 * something this module measured.
 *
 * ## The approval is the click
 *
 * `start()` is called from one place: a user pressing the button. Nothing here starts anything on its own; the startup path calls
 * {@link FullPreparationController.restore}, which only reads.
 */

/** Where the panel is in one preparation. The first five mirror the content script's own phases; the last two are the panel's. */
export type PreparationUiPhase = 'idle' | 'starting' | 'filtering_available' | 'loading_courses' | 'hydrating_teachers' | 'rescanning' | 'finished' | 'error';

/** The teacher-hydration numbers, as the content script reported them. */
export interface HydrationReport {
  /** Panels in the snapshot this run took. */
  readonly queued?: number;
  /** Panels the controller reached before stopping. */
  readonly considered?: number;
  /**
   * Panels that were NOT skipped, which includes panels that could not be examined at all.
   *
   * Deliberately never rendered as a click count: an unreadable panel is attempted without being clicked.
   */
  readonly attempted?: number;
  /** Panels whose teacher data is now complete because of this run. */
  readonly hydrated?: number;
  /** Panels this run tried and could not complete. */
  readonly failed?: number;
  /** Panels that already had complete teacher data. */
  readonly skipped?: number;
  /**
   * The real number of expand clicks.
   *
   * This is the ONLY count that may be worded as clicks, because it is the only one that counts them.
   */
  readonly hydrationClicks?: number;
  readonly stopReason?: string;
}

/** The panel's view of one preparation run. */
export interface PreparationView {
  readonly phase: PreparationUiPhase;
  /** Whether the primary button should be offered. */
  readonly canStart: boolean;
  /** Whether the cancel control should be offered. */
  readonly canCancel: boolean;
  /** Batches loaded so far, from the expansion's own report. A count of CLICKS, never of courses. */
  readonly clicks: number;
  /** The teacher-hydration report, once that phase has reported. */
  readonly hydration: HydrationReport | null;
  /**
   * Teaching-class rows the final rescan read back.
   *
   * `null` means the final page is not known — either no read happened or the run has not finished. It is NEVER rendered as 0, because those are different
   * statements and 0 would claim the page holds no teaching classes.
   */
  readonly finalRowCount: number | null;
  /** The page the final rescan reported, when it reported one. */
  readonly finalListPresent: boolean | null;
  /**
   * The canonical preparation stop reason, or `null` while the run has no verdict yet.
   *
   * Carried BESIDE {@link message} rather than derived from it, because the two answer different questions: the message is what a reader sees, and this is what
   * the run actually decided. A consumer that must act on the outcome — the recommendation handoff deciding whether this completion permits a request — has to
   * read the verdict itself rather than pattern-match a sentence, which would break the moment a sentence is reworded.
   */
  readonly stopReason: string | null;
  /** The line above the controls, or `null` when the phase needs no line of its own. */
  readonly message: string | null;
}

/** The controller's outward contract. */
export interface FullPreparationController {
  /** A user approved a preparation. Reads the tab fresh, sends START, and returns nothing. */
  readonly start: () => Promise<void>;
  /**
   * A user asked to stop.
   *
   * It sends the TOP-LEVEL cancel only: the panel controls the workflow, not its phases, and the content script routes the request to whichever phase is
   * running. It does NOT claim the run stopped — the finished event or a later status read is the authority.
   */
  readonly cancel: () => Promise<void>;
  /** Recover what this tab is already doing, without starting anything. Called on panel open. */
  readonly restore: () => Promise<void>;
  /**
   * Feed one preparation event from the content script.
   *
   * @param tabId - the tab that sent it, taken from the message sender rather than from the payload.
   * @param event - the event's fields.
   */
  readonly onEvent: (tabId: number | null, event: Record<string, unknown>) => void;
  /** The current view. */
  readonly view: () => PreparationView;
  /**
   * The tab this panel's preparation belongs to, or `null` when none has been approved.
   *
   * Exposed because the recommendation handoff must ask about THE SAME TAB the preparation read. Re-reading the active tab at handoff time would send the request
   * to whichever page is now in front — a page the preparation never touched and the user never approved for it. The value is read-only and never set from
   * outside: it is the tab this panel's own `start()` recorded.
   */
  readonly operationTabId: () => number | null;
}

/** Injectable seams, so the controller can be driven without a browser. */
export interface FullPreparationControllerOptions {
  readonly onView: (view: PreparationView) => void;
  /** The active tab's id, or `null`. Defaults to `chrome.tabs.query`. */
  readonly queryActiveTabId?: () => Promise<number | null>;
  /** Send one message. Defaults to `chrome.runtime.sendMessage`. */
  readonly sendMessage?: (message: RuntimeMessage) => Promise<unknown>;
}

/**
 * The single message the panel sends to begin.
 *
 * Exported so the panel and its tests name one string, and so a test can assert that this is the ONLY start message the panel sends.
 */
export const PREPARATION_START_MESSAGE = 'COURSE_COPILOT_START_FULL_PREPARATION';
/** The single message the panel sends to stop. */
export const PREPARATION_CANCEL_MESSAGE = 'COURSE_COPILOT_CANCEL_FULL_PREPARATION';
/** The read-only status question. */
export const PREPARATION_STATUS_MESSAGE = 'COURSE_COPILOT_QUERY_FULL_PREPARATION_STATUS';
/** The message the content script reports itself with. */
export const PREPARATION_EVENT_MESSAGE = 'COURSE_COPILOT_FULL_PREPARATION_EVENT';

/*
 * ============================================================================================================================
 * THE APPROVAL COPY HAS ONE SOURCE, AND IT IS NOT IN THIS FILE
 * ============================================================================================================================
 *
 * It used to be duplicated: an exported copy constant here, and the rendered paragraph in `sidepanel.html`. That was removed in PRE-RELEASE-UX-A10, for a reason
 * worth recording precisely, because "de-duplicate the copy" sounds cosmetic and was not.
 *
 * The constant had NO production caller. The HTML was what rendered, and the constant was kept in step only by a test that asserted the HTML CONTAINED the
 * constant — a SUBSTRING check. The rendered paragraph was already longer than the constant by a whole trailing sentence, so the assertion could not have failed:
 * the constant was a prefix of the copy being compared against it. TWO independently editable copies existed and the test could not tell them apart.
 *
 * The copy therefore lives ONLY in `sidepanel.html`, in the paragraph whose id is `full-preparation-note`, and the tests read THAT element and assert its own text.
 * An edit there is an edit the tests see; there is no second place to forget, and no name for one — which is why the removed constant's identifier is not written
 * here either. A name kept alive in prose is a name a later edit can revive.
 */

/**
 * Every sentence the panel shows for a finished run.
 *
 * One sentence per stop reason, because they mean different things to a user: everything worked, some teachers could not be filled in, a limit was reached, the
 * user stopped it, the list itself was incomplete, and the final read failed are six different situations. Collapsing any of them into "完成" would tell a user
 * their data is whole when it is not.
 */
export const PREPARATION_MESSAGES = {
  starting: '正在开始…',
  /*
   * The filtered pool is what the whole run is about, so the wording says 可选课程 rather than 全部课程. The old wording promised the complete WHU catalogue, which
   * this flow deliberately does not assemble: it prepares the courses that currently have places.
   */
  filteringAvailable: '正在筛选可选课程…',
  loadingCourses: '正在加载可选课程…',
  hydratingTeachers: '正在补全教师信息…',
  rescanning: '正在重新读取课程信息…',
  completed: '可选课程信息已准备完成',
  teacherPartial: '课程信息已部分准备完成，部分教师信息未能补全。',
  teacherCap: '已达到教师信息补全上限，当前已获取的数据已保留。',
  cancelled: '已停止数据准备，已经加载的信息会保留。',
  listIncomplete: '课程列表未能完整加载，因此未继续补全教师信息。',
  /*
   * The two filter refusals are kept apart because the user's next move differs. `unavailable` means this page exposes no 「有余量」 filter to operate — nothing
   * was clicked — while `failed` means the filter was there and did not take, so the pool would not have been the selectable one and the run stopped rather
   * than prepare something the approval did not cover.
   */
  filterUnavailable: '当前页面无法使用 WHU 的“有余量”筛选，因此未开始准备数据。',
  filterFailed: '未能启用“有余量”筛选，因此未开始准备数据。',
  readFailed: '课程信息重新读取失败。',
  /** A refusal or a transport failure: nothing was started, and this is not a preparation outcome. */
  failed: '无法开始数据准备。',
} as const;

/**
 * The progress line for a phase.
 *
 * Composed from the phase's own sentence plus the numbers that phase actually reported. The wording for the teacher counts is chosen carefully:
 * `considered` is how many panels the controller REACHED, `hydrated` how many it completed, `failed` how many it could not, and `skipped` how many needed no
 * work. Only `hydrationClicks` is ever called a click count, because `attempted` includes panels that could not be examined at all.
 *
 * @param phase - the phase being rendered.
 * @param clicks - batches loaded so far.
 * @param hydration - the hydration report, or `null` before that phase has reported.
 * @returns the line to show.
 */
export function preparationProgressText(phase: PreparationUiPhase, clicks: number, hydration: HydrationReport | null): string | null {
  if (phase === 'starting') return PREPARATION_MESSAGES.starting;
  if (phase === 'filtering_available') return PREPARATION_MESSAGES.filteringAvailable;

  if (phase === 'loading_courses') {
    // The batch line says what is counted: one click adds a batch whose size varies, so "N 门课程" would be a number the extension cannot compute.
    return `${PREPARATION_MESSAGES.loadingCourses} 已展开 ${clicks} 批`;
  }

  if (phase === 'hydrating_teachers') {
    const parts: string[] = [PREPARATION_MESSAGES.hydratingTeachers];
    if (hydration !== null) {
      const queued = hydration.queued;
      const considered = hydration.considered;
      if (typeof considered === 'number' && typeof queued === 'number') {
        parts.push(`已处理 ${considered} / ${queued} 个课程面板`);
      }
      const details: string[] = [];
      if (typeof hydration.hydrated === 'number') details.push(`成功补全 ${hydration.hydrated}`);
      if (typeof hydration.skipped === 'number') details.push(`无需补全 ${hydration.skipped}`);
      if (typeof hydration.failed === 'number') details.push(`失败 ${hydration.failed}`);
      if (details.length > 0) parts.push(details.join(' · '));
    }
    return parts.join(' ');
  }

  if (phase === 'rescanning') return PREPARATION_MESSAGES.rescanning;
  return null;
}

/**
 * Turn a preparation stop reason into what the panel says.
 *
 * @param stopReason - the canonical reason reported by the content script.
 * @returns the sentence to show.
 */
export function preparationFinishText(stopReason: unknown): string {
  switch (stopReason) {
    case 'completed':
    case 'teacher_hydration_completed':
      return PREPARATION_MESSAGES.completed;
    case 'teacher_hydration_partial':
      return PREPARATION_MESSAGES.teacherPartial;
    case 'teacher_hydration_item_cap':
      return PREPARATION_MESSAGES.teacherCap;
    case 'cancelled':
      return PREPARATION_MESSAGES.cancelled;
    case 'course_list_incomplete':
      return PREPARATION_MESSAGES.listIncomplete;
    /*
     * The two filter refusals, kept apart. Both mean nothing was prepared, but they are different facts — the page has no filter to operate versus the filter did
     * not take — and a user deciding what to do next needs to know which.
     */
    case 'availability_filter_unavailable':
      return PREPARATION_MESSAGES.filterUnavailable;
    case 'availability_filter_failed':
      return PREPARATION_MESSAGES.filterFailed;
    case 'read_failed':
      return PREPARATION_MESSAGES.readFailed;
    default:
      // An unrecognised reason is reported as a failure to prepare rather than as success: claiming completion on an unknown verdict is the one direction that
      // could mislead a user about data they are about to rely on.
      return PREPARATION_MESSAGES.failed;
  }
}

/**
 * The final-read sentence, or `null` when no read was reported.
 *
 * `rowCount` is a count of TEACHING-CLASS RECORDS, not of courses: one course can be offered as several teaching classes, so the two numbers differ and the
 * label must say which one it is. A missing final page produces `null` rather than "0 条", because "no read happened" and "the page has nothing" are different
 * statements.
 *
 * @param finalPage - the reported final page, or `undefined`.
 * @returns the sentence to show.
 */
export function finalPageText(finalPage: { rowCount?: unknown } | undefined): string | null {
  if (finalPage === undefined) return null;
  const rowCount = finalPage.rowCount;
  if (typeof rowCount !== 'number' || !Number.isFinite(rowCount)) return null;
  return `最终读取到 ${rowCount} 条教学班记录`;
}

/**
 * The active tab's id, or `null`. Never throws.
 *
 * `chrome` comes from the global scope rather than an import, because this module is bundled into a page that already has it.
 */
async function readActiveTabId(): Promise<number | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const first = Array.isArray(tabs) ? tabs[0] : undefined;
    const id = first?.id;
    // Integer only, the same rule the transport applies.
    return typeof id === 'number' && Number.isInteger(id) ? id : null;
  } catch {
    return null;
  }
}

/** Read one numeric field from a report, or `undefined`. */
function numberField(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Create the controller.
 *
 * @param options - the view sink and, for tests, injectable seams.
 * @returns the controller.
 */
export function createFullPreparationController(options: FullPreparationControllerOptions): FullPreparationController {
  const { onView } = options;
  const queryActiveTabId = options.queryActiveTabId ?? readActiveTabId;
  const sendMessage = options.sendMessage ?? ((message: RuntimeMessage) => chrome.runtime.sendMessage(message));

  /*
   * THE ONLY PERSISTENT STATE.
   *
   * `operationTabId` is what makes cross-tab events safe: an event is applied only when the tab that sent it is the tab this operation belongs to.
   */
  let operationTabId: number | null = null;
  let phase: PreparationUiPhase = 'idle';
  let clicks = 0;
  let hydration: HydrationReport | null = null;
  let finalRowCount: number | null = null;
  let finalListPresent: boolean | null = null;
  /**
   * The canonical reason this run ended, kept beside the sentence it produced.
   *
   * The sentence is for a reader; this is what the run DECIDED. A consumer acting on the outcome — the recommendation handoff deciding whether this completion
   * permits a request — must read the verdict rather than pattern-match wording that could be reworded at any time.
   */
  let finishedStopReason: string | null = null;
  let message: string | null = null;

  function buildView(): PreparationView {
    return {
      phase,
      canStart: phase === 'idle' || phase === 'finished' || phase === 'error',
      // Cancellable during the FILTER too: the run's first phase performs page interactions, so a user who changes their mind must be able to stop it before it
      // reaches the load-more it has not been shown yet.
      canCancel: phase === 'starting' || phase === 'filtering_available' || phase === 'loading_courses' || phase === 'hydrating_teachers' || phase === 'rescanning',
      clicks,
      hydration,
      finalRowCount,
      finalListPresent,
      stopReason: finishedStopReason,
      message,
    };
  }

  function publish(): void {
    onView(buildView());
  }

  // Publish immediately, so the sink never has to invent a state on a panel that opens onto an idle feature.
  publish();

  function set(next: PreparationUiPhase, text: string | null): void {
    phase = next;
    message = text;
    publish();
  }

  /** Apply a status object the content script reported, from either a reply or a finished event. */
  function applyStatus(status: Record<string, unknown>): void {
    const reportedPhase = status.phase;
    absorbReports(status);

    /*
     * The phase mapping. A running preparation is rendered as the phase the CONTENT script is in, because that is the only party that knows; the panel's own
     * `starting` is a label for the moment before the first reply arrives.
     */
    if (reportedPhase === 'filtering_available' || reportedPhase === 'loading_courses' || reportedPhase === 'hydrating_teachers' || reportedPhase === 'rescanning') {
      phase = reportedPhase;
      message = preparationProgressText(phase, clicks, hydration);
      publish();
      return;
    }
    if (reportedPhase === 'idle') {
      set('idle', null);
      return;
    }
    // `finished`, or any phase this panel does not know: the run is over and its reason is what matters.
    // The canonical reason is kept BESIDE the sentence, so a consumer acting on the outcome reads the verdict rather than the wording.
    finishedStopReason = typeof status.stopReason === 'string' ? status.stopReason : null;
    set('finished', preparationFinishText(status.stopReason));
  }

  /**
   * Take the numbers out of the two phase reports a status or event carries.
   *
   * Every path that receives a report goes through here — a reply, a finished event, a phase change and an intermediate progress event — so a live event and a
   * recovered status can never be read differently.
   */
  function absorbReports(source: Record<string, unknown>): void {
    const autoExpand = source.autoExpandStatus;
    if (autoExpand !== null && typeof autoExpand === 'object') {
      const reportedClicks = numberField(autoExpand as Record<string, unknown>, 'clicks');
      if (reportedClicks !== undefined) clicks = reportedClicks;
    }
    const reportedHydration = source.teacherHydrationStatus;
    if (reportedHydration !== null && typeof reportedHydration === 'object') {
      const record = reportedHydration as Record<string, unknown>;
      hydration = {
        queued: numberField(record, 'queued'),
        considered: numberField(record, 'considered'),
        attempted: numberField(record, 'attempted'),
        hydrated: numberField(record, 'hydrated'),
        failed: numberField(record, 'failed'),
        skipped: numberField(record, 'skipped'),
        hydrationClicks: numberField(record, 'hydrationClicks'),
        stopReason: typeof record.stopReason === 'string' ? record.stopReason : undefined,
      };
    }
    const reportedFinal = source.finalPage;
    if (reportedFinal !== null && typeof reportedFinal === 'object') {
      const record = reportedFinal as Record<string, unknown>;
      const rowCount = numberField(record, 'rowCount');
      finalRowCount = rowCount === undefined ? null : rowCount;
      finalListPresent = typeof record.listPresent === 'boolean' ? record.listPresent : null;
    }
  }

  return {
    async start(): Promise<void> {
      // A second start while one is running must not create a second run. The content script refuses it too; this is the panel's half of that agreement.
      if (phase === 'starting' || phase === 'loading_courses' || phase === 'hydrating_teachers' || phase === 'rescanning') return;

      // Read the active tab NOW. Reusing an id captured when the panel opened would send the command to whichever tab was active then.
      const tabId = await queryActiveTabId();
      if (tabId === null) {
        set('error', PREPARATION_MESSAGES.failed);
        return;
      }
      operationTabId = tabId;
      clicks = 0;
      hydration = null;
      finalRowCount = null;
      finalListPresent = null;
      // A new approval clears the previous verdict, so a stale reason can never be read as this run's outcome.
      finishedStopReason = null;
      set('starting', PREPARATION_MESSAGES.starting);

      let response: unknown;
      try {
        response = await sendMessage({ type: PREPARATION_START_MESSAGE, tabId } as RuntimeMessage);
      } catch {
        // The worker was unreachable, so nothing was accepted. Reported rather than retried.
        set('error', PREPARATION_MESSAGES.failed);
        return;
      }

      const record = typeof response === 'object' && response !== null
        ? (response as { ok?: unknown; reply?: unknown; error?: unknown })
        : {};

      if (record.ok !== true) {
        // A forwarding failure or an unusable reply. The session is NOT claimed to be running.
        set('error', typeof record.error === 'string' ? record.error : PREPARATION_MESSAGES.failed);
        return;
      }

      const reply = typeof record.reply === 'object' && record.reply !== null
        ? (record.reply as { accepted?: unknown; status?: unknown })
        : {};
      const status = typeof reply.status === 'object' && reply.status !== null ? (reply.status as Record<string, unknown>) : {};

      if (reply.accepted === false) {
        /*
         * The content script already had a preparation running for this tab. That is not a failure: the run IS in progress, and the honest response is to resume
         * showing it rather than to start a second one or claim an error.
         */
        const reportedPhase = status.phase;
        if (reportedPhase === 'loading_courses' || reportedPhase === 'hydrating_teachers' || reportedPhase === 'rescanning' || reportedPhase === 'finished') {
          applyStatus(status);
          return;
        }
        // Accepted false for any other reason means this tab has nothing to resume.
        set('error', PREPARATION_MESSAGES.failed);
        return;
      }

      applyStatus(status);
    },

    async cancel(): Promise<void> {
      // Nothing to cancel, so nothing is sent: a cancel on an idle panel must not reach the page.
      if (phase !== 'starting' && phase !== 'loading_courses' && phase !== 'hydrating_teachers' && phase !== 'rescanning') return;
      /*
       * The tab is read AGAIN rather than reusing the operation's id, because the request has to reach the tab that owns the run. If the user has since moved to
       * a different tab, the cancel is dropped instead of being sent to whoever is now in front.
       */
      const tabId = await queryActiveTabId();
      if (tabId === null || tabId !== operationTabId) return;
      try {
        // The TOP-LEVEL cancel only. The panel controls the workflow, and the content script routes the request to whichever phase is running.
        await sendMessage({ type: PREPARATION_CANCEL_MESSAGE, tabId } as RuntimeMessage);
      } catch {
        // A failed cancel leaves the run going; the finished event or a later status read is still the authority.
        return;
      }
      /*
       * NOTHING is published here. Writing "cancelled" now would announce a result the content script has not reported — it may still be expanding panels while it
       * notices. The running line therefore stays until the authoritative answer arrives.
       */
    },

    async restore(): Promise<void> {
      const tabId = await queryActiveTabId();
      if (tabId === null) return;

      let response: unknown;
      try {
        response = await sendMessage({ type: PREPARATION_STATUS_MESSAGE, tabId } as RuntimeMessage);
      } catch {
        // Unreachable worker: leave the display as it is rather than inventing a state.
        return;
      }

      const record = typeof response === 'object' && response !== null ? (response as { ok?: unknown; reply?: unknown }) : {};
      if (record.ok !== true) return;
      const reply = typeof record.reply === 'object' && record.reply !== null ? (record.reply as { status?: unknown }) : {};
      const status = reply.status;
      if (typeof status !== 'object' || status === null) return;

      // The recovered run becomes this panel's operation, so later events from that tab are accepted rather than treated as foreign.
      operationTabId = tabId;
      applyStatus(status as Record<string, unknown>);
    },

    onEvent(tabId, event): void {
      /*
       * The isolation rule, in one comparison. An event from another tab is not this run's news: applying it would attribute one page's progress to another,
       * which is exactly the confusion this guard exists to prevent. The tab id comes from the message sender, never from a payload field.
       */
      if (tabId === null || operationTabId === null || tabId !== operationTabId) return;

      const phaseChanged = event.phase_changed;
      if (typeof phaseChanged === 'string') {
        /*
         * The numbers travel WITH the phase change: the content script reports its expansion summary or its hydration summary alongside the new phase, and a
         * panel that took the phase and dropped the numbers would show "正在补全教师信息…" with nothing behind it.
         */
        absorbReports(event);
        if (phaseChanged === 'filtering_available' || phaseChanged === 'loading_courses' || phaseChanged === 'hydrating_teachers' || phaseChanged === 'rescanning') {
          phase = phaseChanged;
          message = preparationProgressText(phase, clicks, hydration);
          publish();
        }
        return;
      }

      // Anything else carrying progress numbers is applied through the same reader a reply uses, so a live event and a recovered status cannot be read
      // differently.
      if (event.phase === 'finished') {
        applyStatus(event);
        return;
      }

      // An intermediate progress report: numbers only, never a phase change.
      absorbReports(event);
      // The phase is unchanged: a running preparation stays where it is until it reports otherwise. `starting` resolves to the run's FIRST phase, which is now
      // the filter rather than the load-more.
      if (phase === 'starting') phase = 'filtering_available';
      message = preparationProgressText(phase, clicks, hydration);
      publish();
    },

    view: buildView,
    operationTabId: () => operationTabId,
  };
}
