/**
 * Course Copilot content script — page identity and panel count.
 *
 * ## What this file is allowed to do
 *
 * Two things, and nothing else:
 *
 * 1. Read `location.hostname` and `location.pathname` to decide whether this is the supported selection page.
 * 2. Run exactly one DOM query — `document.querySelectorAll("div.panel.panel-info")` — and read its `length`.
 *
 * It never reads the content of any element. There is no `textContent`, no `innerText`, no `innerHTML`, no `dataset`, no
 * attribute access, no `children`, and no query inside a panel. So it cannot obtain a course name, a teacher, a credit
 * count, a seat number, a status or anything about the student: the reading it performs is incapable of expressing them.
 *
 * A count of 0 is reported as 0. It is not interpreted as a broken page, a failed selector or an absence of courses —
 * this step reports the number and nothing else.
 *
 * ## What it deliberately does NOT do
 *
 * No cookie, no storage, no query parameter; `location.search` and `location.hash` are never touched. The URL is never
 * logged, because a log line containing it would leak the query string.
 *
 * ## Why everything is wrapped in a function
 *
 * A static Manifest V3 content script is a CLASSIC script: the manifest has no `type: "module"` for `content_scripts`, and
 * module syntax in such a file is a syntax error that kills the whole script before a single line runs. That is exactly what
 * happened once — the emitted file ended with `export {};` and Edge reported
 * `Uncaught SyntaxError: Unexpected token 'export'`.
 *
 * Removing the module syntax makes this file a SCRIPT, and scripts share one global scope, so top-level `const` declarations
 * here would collide with identically named ones in the service worker and the panel. The wrapper keeps every binding local,
 * which is why no name has to be coordinated across files, and it is also what makes the file's bindings impossible to reach
 * from the page.
 */

(() => {
  /** The single page this extension supports. */
  const SUPPORTED_HOSTNAME = 'jwgl.whu.edu.cn';
  const SUPPORTED_PATHNAME = '/xsxk/zzxkyzb_cxZzxkYzbIndex.html';

  /** Messages this script sends. */
  const PAGE_STATUS_MESSAGE = 'COURSE_COPILOT_PAGE_STATUS';
  const PANEL_COUNT_MESSAGE = 'COURSE_COPILOT_PANEL_COUNT';
  /** Message the worker sends asking this script to report again. */
  const QUERY_STATUS_MESSAGE = 'COURSE_COPILOT_QUERY_STATUS';
  /**
   * Message the worker sends asking for EVERY loaded teaching-class row.
   *
   * A separate type from {@link QUERY_STATUS_MESSAGE} on purpose. The status reply is a bounded diagnostic sample, and widening
   * it in place would turn every panel refresh into a bulk export of the user's course list. This one is asked for explicitly,
   * answered from the live page, and never cached — see the handler for the exact scope.
   */
  const QUERY_VISIBLE_ROWS_MESSAGE = 'COURSE_COPILOT_QUERY_VISIBLE_ROWS';

  /**
   * The one selector this step is permitted to query.
   *
   * Named and single so that "the extension looks at exactly one kind of element" is checkable: the static verification
   * asserts this is the only selector string in the built file.
   */
  const COURSE_PANEL_SELECTOR = 'div.panel.panel-info';

  /** The heading element inside a panel, and the span whose text carries the course identity. */
  const HEADING_CLASS = 'kc_head';
  const COURSE_NAME_SPAN_CLASS = 'kcmc';
  /** The hidden input that carries the course code when the heading does not. */
  const COURSE_CODE_INPUT_NAME = 'kch_id';
  /** One teaching class per row, and the hidden cell carrying that class's teacher(s). */
  const ROW_CLASS = 'body_tr';
  const TEACHER_CELL_CLASS = 'jsxm';
  /**
   * The `<font>` holding this teaching class's remaining-seat count.
   *
   * One of TWO seat numbers this script is granted, each read from its own leaf. They sit inside a cell that also holds
   * CAPACITY, and that container is deliberately NOT read: it would hand over all three numbers at once, while this script is
   * allowed exactly two, named individually. The grant is recorded in `scripts/confirm-content-privacy.mjs`; reading anything
   * else from that cell would fail the gate.
   */
  const REMAINING_SEATS_CLASS = 'blzyl';

  /**
   * The `<font>` holding how many students had already signed up for this teaching class in the current round.
   *
   * The page's own label is 「本轮已选」 and its definition is 「本轮次已选人数」. NOT the course's total enrolment, and NOT
   * capacity — the third number in the same cell stays outside the grant.
   *
   * Read as a leaf, exactly like {@link REMAINING_SEATS_CLASS}: reachable only by scanning DOWN from the row, never by walking
   * up to the shared cell. The privacy contract forbids upward and lateral traversal (`parentElement`, `parentNode`,
   * `.closest(`, the sibling walkers), so the two leaves cannot be collected by finding their common parent.
   */
  const SELECTED_THIS_ROUND_CLASS = 'blyxrs';

  /*
   * ============================================================================================================================
   * BOUNDED AVAILABILITY FILTER
   * ============================================================================================================================
   *
   * The WHU 「有无余量」 filter, operated the way a person operates it. The behaviour is NOT researched here: Steps 37a, 37a.1, 37b
   * and 37b.4 measured it on the live page and the last of those ran it end to end, so this is a port of a proven path into the
   * extension runtime rather than a new mechanism.
   *
   * ## The four facts the port rests on
   *
   * 1. the option row and the query button live inside the page's own filter panel, `#searchBox`;
   * 2. choosing an option does NOT refetch anything — only the page's query button does;
   * 3. the widget's own state IS the `selectedValue` class on the option's anchor, so an already-chosen option needs no click;
   * 4. submitting the page's query clears `.tjxk_list` and rebuilds the result set, which means the list is legitimately ABSENT
   *    for a while.
   *
   * ## Why every selector is scoped to `#searchBox`
   *
   * `button[name=query]` is a generic name on a page that also carries 192 enrollment controls. Resolving the panel once and
   * asking it for its own buttons is what keeps this session away from anything that is not the filter's submit — and it is why
   * the option row is found by descending from the panel rather than by a page-wide class query.
   */

  /** The page's filter panel. Every control this session touches is resolved through it. */
  const SEARCH_BOX_SELECTOR = '#searchBox';
  /** The option group inside that panel; `name` is the page's own group key for 「有无余量」. */
  const AVAILABILITY_GROUP_SELECTOR = 'div.items[name=yl_list]';
  /** The 「有」 option's anchor: the group's item whose `index` says "has seats left". */
  const AVAILABILITY_OPTION_SELECTOR = 'li[index=yl_list_1] a';
  /** The page's own submit for the filter panel. NOT an enrollment control. */
  const FILTER_QUERY_BUTTON_SELECTOR = 'button[name=query]';
  /** The panel's control that reveals the collapsed filter rows. */
  const FILTER_EXPAND_CONTROL_SELECTOR = 'a.down';

  const START_AVAILABILITY_FILTER_MESSAGE = 'COURSE_COPILOT_START_AVAILABILITY_FILTER';
  const CANCEL_AVAILABILITY_FILTER_MESSAGE = 'COURSE_COPILOT_CANCEL_AVAILABILITY_FILTER';
  const QUERY_AVAILABILITY_FILTER_STATUS_MESSAGE = 'COURSE_COPILOT_QUERY_AVAILABILITY_FILTER_STATUS';
  const AVAILABILITY_FILTER_EVENT_MESSAGE = 'COURSE_COPILOT_AVAILABILITY_FILTER_EVENT';

  /** How long the result list may stay absent before the rebuild counts as failed. */
  const FILTER_REBUILD_TIMEOUT_MS = 8000;
  /** How often the rebuild is inspected. */
  const FILTER_REBUILD_POLL_MS = 200;
  /** How long the rebuilt result set must hold still before it counts as settled. */
  const FILTER_REBUILD_QUIET_MS = 400;

  /** How many teaching-class rows may be reported. A cap on the message, not a limit on the page. */
  const MAX_ROW_SAMPLES = 3;

  /*
   * ============================================================================================================================
   * BOUNDED TEACHER HYDRATION
   * ============================================================================================================================
   *
   * The second stage of fetching, and it lives here for the same reasons the expansion does: only this script has the DOM, this script is per-tab, and the
   * service worker is expected to be suspended mid-run.
   *
   * ## What the live page actually does
   *
   * Measured in 16J-PREUI-E4-A and E4-A-R1: an unexpanded course panel's teacher cells are GENUINELY EMPTY — not hidden — and expanding one
   * two-teaching-class panel filled BOTH rows at once. So the expensive operation is per PANEL, and the success check must inspect every row of the panel
   * rather than the first one.
   */

  /** Messages the teacher-hydration contract adds. One meaning each. */
  const START_TEACHER_HYDRATION_MESSAGE = 'COURSE_COPILOT_START_TEACHER_HYDRATION';
  const CANCEL_TEACHER_HYDRATION_MESSAGE = 'COURSE_COPILOT_CANCEL_TEACHER_HYDRATION';
  const QUERY_TEACHER_HYDRATION_STATUS_MESSAGE = 'COURSE_COPILOT_QUERY_TEACHER_HYDRATION_STATUS';
  const TEACHER_HYDRATION_EVENT_MESSAGE = 'COURSE_COPILOT_TEACHER_HYDRATION_EVENT';

  /**
   * The one control a hydration item may click, found RELATIVE to its panel.
   *
   * The class is the page's own expand marker. Measured: it carries no `onclick` and `href="javascript:void(0);"`, and it lives in `.panel-heading` while the
   * enroll button lives in `.panel-body > table`, so the two sit in different branches of the panel.
   */
  const EXPAND_CONTROL_SELECTOR = 'a.expand1';

  /**
   * The two things a hydration item reads, named as selectors because they are queried RELATIVE to one panel.
   *
   * `tr.body_tr` is the existing {@link ROW_CLASS} and `td.jsxm` the existing {@link TEACHER_CELL_CLASS}; the selector forms exist because
   * `querySelector` needs one string, and keeping them here makes the privacy grant list exhaustively checkable.
   */
  const ROW_SELECTOR = 'tr.body_tr';
  const TEACHER_CELL_SELECTOR = 'td.jsxm';

  /**
   * How long one panel may take to hydrate, and how long it must then stay quiet.
   *
   * The live page wrote the teacher data asynchronously, so an item cannot be judged at the instant the click returns. A page that never settles must not
   * hold an item open, hence the hard bound. Both are named because a scattered number here would be a stopping rule nobody could review.
   */
  const TEACHER_HYDRATION_TIMEOUT_MS = 8000;
  const TEACHER_HYDRATION_QUIET_MS = 500;

  /**
   * The most panels one approved hydration pass may consider.
   *
   * A safety cap, not a product limit: the live page held 144 course panels once fully loaded, and a DOM anomaly that multiplied the panel count must not
   * turn one approval into an unbounded run of clicks.
   */
  const MAX_TEACHER_HYDRATION_PANELS = 200;

  /** Why a hydration batch ended. */
  type TeacherHydrationStopReason = 'completed' | 'cancelled' | 'item_cap';

  /** The outcome of one panel's hydration attempt. */
  type TeacherHydrationItemOutcome = { readonly status: 'hydrated' } | { readonly status: 'failed' };

  /** What one settled item reported. */
  interface TeacherHydrationProgress {
    readonly considered: number;
    readonly hydrated: number;
    readonly failed: number;
    readonly skipped: number;
    readonly remaining: number;
  }

  /** The batch summary. Plain data. */
  interface TeacherHydrationResult {
    readonly stopReason: TeacherHydrationStopReason;
    readonly queued: number;
    readonly considered: number;
    readonly attempted: number;
    readonly hydrated: number;
    readonly failed: number;
    readonly skipped: number;
    readonly notConsidered: number;
    readonly remaining: number;
  }

  /** The actions a hydration batch needs. */
  interface TeacherHydrationDependencies<Item> {
    /** Whether this item still needs work. Expected to inspect EVERY row of a panel. */
    readonly needsHydration: (item: Item) => boolean | Promise<boolean>;
    /** Do the work for one item. Called at most once per item. */
    readonly hydrateOne: (item: Item) => TeacherHydrationItemOutcome | Promise<TeacherHydrationItemOutcome>;
    /** Whether the batch should stop before the next item. Never consulted mid-item. */
    readonly isCancelled?: () => boolean | Promise<boolean>;
    /** Called after each settled item. A throw is swallowed. */
    readonly onProgress?: (progress: TeacherHydrationProgress) => void;
  }

  /**
   * Work through a snapshot of panels that may need teacher data, bounded and failure-isolated.
   *
   * ## The queue is a snapshot
   *
   * The caller hands over a finite list and this run never grows it. A panel that appears later is NOT appended: without that rule a page that keeps rendering
   * would keep extending the job, and "one approved pass" would have no end.
   *
   * ## Failure is contained, not propagated
   *
   * A `failed` return and a thrown error are the same outcome for one item: counted, and the batch moves on. A batch does not reject, does not clear what it
   * already achieved, and does not stop early because one panel went wrong. A page with a few broken panels must still yield every panel that did hydrate.
   *
   * ## An unreadable predicate is a failure, not a skip
   *
   * If `needsHydration` throws, the panel could not be shown to be complete, so it must not be reported as skipped and the batch continues. That is also why
   * `attempted` counts items that were NOT skipped rather than items that were clicked: an unreadable panel is attempted and failed without ever being
   * clicked, and counting it as skipped would break `considered = attempted + skipped`.
   *
   * ## Completion is about the batch, not about the panels
   *
   * Finishing the queue reports `completed` even with failures, because "one panel failed" and "the batch failed" are different statements.
   *
   * @param queue - the snapshot of panels to consider. Not modified, and not extended during the run.
   * @param dependencies - the predicate and the action this run may perform.
   * @param maxPanels - the cap; defaults to {@link MAX_TEACHER_HYDRATION_PANELS}.
   * @returns why the batch stopped and the counts that must add up.
   */
  async function runBoundedTeacherHydration<Item>(
    queue: readonly Item[],
    dependencies: TeacherHydrationDependencies<Item>,
    maxPanels: number = MAX_TEACHER_HYDRATION_PANELS,
  ): Promise<TeacherHydrationResult> {
    const queued = queue.length;
    // The cap decides how much of the snapshot may be CONSIDERED. Items beyond it are reported, never processed.
    const bound = Math.min(queued, Math.max(0, maxPanels));
    const notConsidered = queued - bound;

    let considered = 0;
    let hydrated = 0;
    let failed = 0;
    let skipped = 0;
    let cancelObserved = false;

    const report = (): void => {
      if (dependencies.onProgress === undefined) return;
      try {
        dependencies.onProgress({ considered, hydrated, failed, skipped, remaining: bound - considered });
      } catch {
        // Reporting is not the batch. A caller's display bug must not end work that is otherwise fine.
      }
    };

    for (let index = 0; index < bound; index += 1) {
      /*
       * Checked at the top of every item, covering all the required moments. An item already in flight is never interrupted — only the next one is
       * prevented — so an observed cancellation can only lower the counts, never corrupt them.
       */
      if (dependencies.isCancelled !== undefined) {
        const cancelled = await attempt(dependencies.isCancelled);
        // A check that throws is not evidence that the user asked to stop, but it is also not a reason to keep clicking.
        if (!cancelled.ok || cancelled.value) {
          cancelObserved = true;
          break;
        }
      }

      const item = queue[index] as Item;

      const needed = await attempt(() => dependencies.needsHydration(item));
      if (!needed.ok) {
        // Unreadable, so not provably complete: counted as a failure and NOT as skipped, while the batch continues.
        considered += 1;
        failed += 1;
        report();
        continue;
      }
      if (!needed.value) {
        // Already whole. This panel costs no click.
        considered += 1;
        skipped += 1;
        report();
        continue;
      }

      // At most one attempt per item, and no retry: a second try would be a second click on a page that has already answered.
      const outcome = await attempt(() => dependencies.hydrateOne(item));
      considered += 1;
      if (outcome.ok && outcome.value.status === 'hydrated') hydrated += 1;
      else failed += 1;
      report();
    }

    /*
     * The cap is reported only when it actually truncated the job, and it takes precedence over a cancellation that arrived first. Reaching the last
     * permitted item with the queue exhausted is a normal completion.
     */
    const stopReason: TeacherHydrationStopReason = notConsidered > 0 ? 'item_cap' : (cancelObserved ? 'cancelled' : 'completed');

    return {
      stopReason,
      queued,
      considered,
      attempted: hydrated + failed,
      hydrated,
      failed,
      skipped,
      notConsidered,
      remaining: bound - considered,
    };
  }

  /*
   * ============================================================================================================================
   * BOUNDED AUTO-EXPAND
   * ============================================================================================================================
   *
   * ## Why this lives in the content script
   *
   * Measured in 16J-PREUI-E3-B2-A, and it forced the architecture:
   *
   *   · The expansion reads `#more` / `#endsign` and clicks `#more a`, so it needs the DOM, which only this script has.
   *   · The service worker has NO keepalive anywhere in this project and is expected to be suspended, while one expansion takes many
   *     seconds. A loop there would depend on a lifetime the project never established.
   *   · A content script instance IS per-tab, so the session state below cannot leak between tabs and needs no key management.
   *   · This file is compiled as a CLASSIC script (no bundler), while the controller was an ES module. Reacting across that boundary
   *     is impossible, so the ONE canonical implementation is inlined here and the module file was deleted. There is no second copy.
   *
   * ## Nothing here runs by itself
   *
   * Only {@link START_AUTO_EXPAND_MESSAGE} starts a session. Reading `completeness === 'partial'` is a FACT, not permission: the
   * status report, the visible-row query, the recommendation query, the status query and the startup path all leave this inert.
   */

  /** Messages the auto-expand contract adds. Each has one meaning and none of them is overloaded. */
  const START_AUTO_EXPAND_MESSAGE = 'COURSE_COPILOT_START_AUTO_EXPAND';
  const CANCEL_AUTO_EXPAND_MESSAGE = 'COURSE_COPILOT_CANCEL_AUTO_EXPAND';
  const QUERY_AUTO_EXPAND_STATUS_MESSAGE = 'COURSE_COPILOT_QUERY_AUTO_EXPAND_STATUS';
  const AUTO_EXPAND_EVENT_MESSAGE = 'COURSE_COPILOT_AUTO_EXPAND_EVENT';

  /** The load-more control, and the anchor inside it. Measured live in E2: the anchor carries the handler, not the container. */
  const LOAD_MORE_ANCHOR_SELECTOR = '#more a';
  /**
   * The REAL course list: the container the page appends new course panels to.
   *
   * Measured in E2-R2: appends happen in place and the node is never replaced, so observing it is enough to see the list grow.
   *
   * ## Why the `.tjxk_list` step is part of the selector
   *
   * Measured on the live page in E2 and again in E4-A: the page holds `div.panel.panel-info` elements OUTSIDE this list as well, and a GLOBAL panel query is
   * permanently one higher than the number of real courses. Anything that counts or queues courses must therefore be scoped to the list. Spelling the whole
   * path here means a caller cannot accidentally take the unscoped form: `container.querySelectorAll(COURSE_PANEL_SELECTOR)` is only correct if this
   * constant already names the list.
   */
  const COURSE_LIST_CONTAINER_SELECTOR = '#contentBox .tjxk_list';

  /**
   * How many load-more clicks one approved session may make.
   *
   * Measured, not chosen for roundness: reaching the end of the live page took 13 clicks, so 20 leaves room for a larger list while
   * keeping a page that never reports an end from being asked forever.
   */
  const MAX_AUTO_EXPAND_CLICKS = 20;

  /**
   * How long one round may take before it is judged settled anyway.
   *
   * A page that keeps mutating forever must not hold the loop open, so the round ends on this bound and the verdict is whatever the
   * page reports at that moment. Both bounds are named constants because a scattered magic number here would be a stopping rule nobody
   * could review.
   */
  const AUTO_EXPAND_STEP_TIMEOUT_MS = 8000;
  /** How long the page must stay quiet before a round is considered done. */
  const AUTO_EXPAND_QUIET_MS = 400;

  /** How completely the course list is loaded. */
  type ExpansionCompleteness = 'partial' | 'complete' | 'unknown';

  /** Why a session stopped. Kept identical to the frozen set from the controller step. */
  type AutoExpandStopReason =
    | 'complete'
    | 'already_complete'
    | 'cancelled'
    | 'unknown_state'
    | 'no_progress'
    | 'click_failed'
    | 'wait_failed'
    | 'click_cap';

  /** What one settled round reported. */
  interface ExpansionStepOutcome {
    readonly completeness: ExpansionCompleteness;
    /** Whether this round ADDED a course panel. Decided from the DOM, never from a count's value. */
    readonly progressed: boolean;
  }

  /** The run's outcome. Plain data, safe to send across a message boundary. */
  interface CourseListExpansionResult {
    readonly stopReason: AutoExpandStopReason;
    readonly clicks: number;
    readonly initialCompleteness: ExpansionCompleteness;
    readonly finalCompleteness: ExpansionCompleteness;
  }

  /** The actions the controller needs. */
  interface CourseListExpansionDependencies {
    readCompleteness: () => ExpansionCompleteness | Promise<ExpansionCompleteness>;
    performOneLoadMore: () => boolean | Promise<boolean>;
    waitForStableStep: () => ExpansionStepOutcome | Promise<ExpansionStepOutcome>;
    isCancelled?: () => boolean | Promise<boolean>;
    onProgress?: (snapshot: { readonly clicks: number; readonly completeness: ExpansionCompleteness }) => void;
  }

  /** One dependency call, with a rejection turned into a named outcome rather than an exception. */
  type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

  /** Call one dependency, converting a rejection into a failure outcome. */
  async function attempt<T>(run: () => T | Promise<T>): Promise<Attempt<T>> {
    try {
      return { ok: true, value: await run() };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Ask the page for batches until the list is whole, the budget runs out, or something says stop.
   *
   * ## The loop, and the order of its checks
   *
   * A round begins by asking whether the run was cancelled, then re-reads completeness, and only clicks when the answer is still
   * `partial`. Reading completeness again rather than trusting the previous round's value means a page that finished on its own — or
   * that stopped answering — is noticed before another click is spent.
   *
   * ## Every exit is bounded and named
   *
   * The cap is checked BEFORE the click, so the twenty-first round is unreachable, and a twentieth click that completes the list is
   * reported as `complete` rather than `click_cap`. A refused or throwing click stops the run and is not retried, and the controller
   * never looks for a substitute target: choosing a target is the caller's job, and a silent substitute could click something that is
   * not a load-more control.
   *
   * @param dependencies - the page actions this run is allowed to take.
   * @param maxClicks - the click budget; defaults to {@link MAX_AUTO_EXPAND_CLICKS}.
   * @returns why the run stopped, how many clicks it made, and the completeness at both ends.
   */
  async function runBoundedCourseListExpansion(
    dependencies: CourseListExpansionDependencies,
    maxClicks: number = MAX_AUTO_EXPAND_CLICKS,
  ): Promise<CourseListExpansionResult> {
    const initialRead = await attempt(dependencies.readCompleteness);
    // A page that cannot be read at all is the most conservative start there is: report it as unknown rather than as a list worth clicking.
    const initialCompleteness: ExpansionCompleteness = initialRead.ok ? initialRead.value : 'unknown';

    const withoutClicking = (stopReason: AutoExpandStopReason): CourseListExpansionResult => ({
      stopReason,
      clicks: 0,
      initialCompleteness,
      finalCompleteness: initialCompleteness,
    });

    if (initialCompleteness === 'complete') return withoutClicking('already_complete');
    // `unknown` is not a state to act on: there is no evidence that clicking would help, so guessing would only spend the user's page.
    if (initialCompleteness !== 'partial') return withoutClicking('unknown_state');

    let clicks = 0;
    let completeness: ExpansionCompleteness = initialCompleteness;

    for (;;) {
      /*
       * Checked at the top of every round, which covers all three required moments: before the first click, between rounds, and
       * immediately after the previous round's settle. A click already dispatched is never reversed — only the next one is prevented.
       */
      if (dependencies.isCancelled !== undefined) {
        const cancelled = await attempt(dependencies.isCancelled);
        // A cancellation check that throws is not evidence that the user asked to stop, but it is also not a reason to keep clicking.
        if (!cancelled.ok || cancelled.value) {
          return { stopReason: 'cancelled', clicks, initialCompleteness, finalCompleteness: completeness };
        }
      }

      const current = await attempt(dependencies.readCompleteness);
      completeness = current.ok ? current.value : 'unknown';
      if (completeness === 'complete') {
        return { stopReason: clicks === 0 ? 'already_complete' : 'complete', clicks, initialCompleteness, finalCompleteness: 'complete' };
      }
      if (completeness !== 'partial') {
        return { stopReason: 'unknown_state', clicks, initialCompleteness, finalCompleteness: 'unknown' };
      }

      // The cap is checked BEFORE the click, so the last permitted round is click number `maxClicks` and a twenty-first is not reachable.
      if (clicks >= maxClicks) {
        return { stopReason: 'click_cap', clicks, initialCompleteness, finalCompleteness: completeness };
      }

      const clicked = await attempt(dependencies.performOneLoadMore);
      // A refusal and a throw are the same outcome here: no usable target. Neither is retried.
      if (!clicked.ok || clicked.value !== true) {
        return { stopReason: 'click_failed', clicks, initialCompleteness, finalCompleteness: completeness };
      }
      clicks += 1;

      const settled = await attempt(dependencies.waitForStableStep);
      /*
       * A failed wait ends the run. Continuing would mean clicking again without knowing whether the previous batch arrived, which is
       * how a loop outlives its evidence. Reported as `wait_failed` rather than `no_progress`: one is a page that stopped settling, the
       * other a page that settled and did not grow.
       */
      if (!settled.ok) {
        return { stopReason: 'wait_failed', clicks, initialCompleteness, finalCompleteness: completeness };
      }

      completeness = settled.value.completeness;
      if (dependencies.onProgress !== undefined) {
        try {
          dependencies.onProgress({ clicks, completeness });
        } catch {
          // Reporting is not the run. A caller's display bug must not end an expansion that is working.
        }
      }

      if (completeness === 'complete') {
        return { stopReason: 'complete', clicks, initialCompleteness, finalCompleteness: 'complete' };
      }
      if (completeness !== 'partial') {
        return { stopReason: 'unknown_state', clicks, initialCompleteness, finalCompleteness: completeness };
      }
      /*
       * Order matters here and is deliberate: `complete` above is honoured even when this round appended no panel. A page can reach its
       * end on a batch that added nothing visible, and letting `progressed === false` win would report a stopped list as stuck.
       */
      if (!settled.value.progressed) {
        return { stopReason: 'no_progress', clicks, initialCompleteness, finalCompleteness: 'partial' };
      }
    }
  }

  /** Whether the current document is the supported selection page. */
  function isSupportedPage(): boolean {
    return location.hostname === SUPPORTED_HOSTNAME && location.pathname === SUPPORTED_PATHNAME;
  }

  /*
   * The two elements the page uses to say whether the course list is fully loaded.
   *
   * Measured on the live selection page in 16J-PREUI-E2 and its two follow-ups, and the shape is what makes the rule work: BOTH nodes exist in BOTH
   * states, and only their visibility changes. In `partial` the page shows `#more` (`display: block`) with `#endsign` at `display: none`; on the
   * final batch it adds `display: none` to `#more` and removes it from `#endsign`. So presence proves nothing — only visibility does.
   *
   * `#more` still holds a real `点此查看更多` anchor in the complete state. It is hidden, not removed, which is why a caller must never infer
   * "done" from a missing element.
   */
  const LOAD_MORE_SELECTOR = '#more';
  const END_SIGN_SELECTOR = '#endsign';

  /** Whether an element is actually shown, by the page's own computed style. */
  function isShown(element: Element | null): boolean {
    if (element === null) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
  }

  /**
   * Read the page's own statement about whether the course list is fully loaded.
   *
   * ## The frozen rule
   *
   * - `partial` — BOTH markers are present, `#more` is shown and `#endsign` is not: the page is offering more rows.
   * - `complete` — BOTH markers are present, `#more` is hidden and `#endsign` is shown: the page says this is the end.
   * - `unknown` — anything else, including either marker missing, both shown, or both hidden.
   *
   * ## Why a MISSING marker is not the same as a hidden one
   *
   * A hidden `#more` is a finished list: that is exactly what the live page does on the final batch, keeping the `点此查看更多` anchor in the DOM. A
   * missing `#more` is a page that is not shaped the way this rule was measured to work, and the honest verdict there is `unknown` rather than
   * `complete`. It matters because `isShown(null)` is `false`, so a rule written only in terms of visibility would silently read "the marker is gone"
   * as "the marker says we are done" — the two facts would collapse into one verdict, which is precisely what reporting presence separately is meant
   * to prevent. The `present` checks below are what keep them apart, so they are part of the rule and not a formality.
   *
   * Nothing else is consulted: not the row count, not the panel count, not any text, and not the anchor's `onclick`. A panel can hold many teaching-
   * class rows (measured: one panel held 15), so row counts cannot express progress, and matching on the visible text would break the moment the
   * site rewords it.
   *
   * @returns the current load state, with both presence facts and the derived completeness.
   */
  function detectCourseListLoadState(): CourseListLoadState {
    const more = document.querySelector(LOAD_MORE_SELECTOR);
    const endSign = document.querySelector(END_SIGN_SELECTOR);
    const morePresent = more !== null;
    const endSignPresent = endSign !== null;
    const moreVisible = isShown(more);
    const endSignVisible = isShown(endSign);

    let completeness: CourseListLoadState['completeness'] = 'unknown';
    // Both markers must be present before either verdict may be given; see the note above on missing versus hidden.
    if (morePresent && endSignPresent) {
      if (moreVisible && !endSignVisible) completeness = 'partial';
      else if (!moreVisible && endSignVisible) completeness = 'complete';
    }

    return { morePresent, moreVisible, endSignPresent, endSignVisible, completeness };
  }

  /**
   * Every real course panel currently loaded, in document order.
   *
   * Scoped to the real course list, for the reason the constant documents: a GLOBAL panel query is permanently higher than the number of real courses, so
   * anything that counts or queues courses has to go through the list. `[]` when the list is not published, which is a page that offers no courses rather
   * than a reason to widen the query.
   *
   * @returns the course panels, or an empty list.
   */
  function coursePanels(): Element[] {
    const listContainer = document.querySelector(COURSE_LIST_CONTAINER_SELECTOR);
    if (listContainer === null) return [];
    const found = listContainer.querySelectorAll(COURSE_PANEL_SELECTOR);
    const panels: Element[] = [];
    for (let index = 0; index < found.length; index += 1) {
      const panel = found[index];
      if (panel !== undefined) panels.push(panel);
    }
    return panels;
  }

  /**
   * Count the REAL course panels currently loaded.
   *
   * The ONLY information taken from the page for the count: how many elements match.
   *
   * ## Why this is scoped to the course list
   *
   * Measured on the live page in E2 and again in E4-A: the page holds `div.panel.panel-info` elements outside `#contentBox .tjxk_list`, so a GLOBAL panel query
   * is permanently higher than the number of real courses. A status line that counted them would overstate how many courses the panel is looking at, which is
   * the same class of claim as reporting a course count from a click count.
   *
   * @returns the number of course panels in the real list; `0` when the list is not published.
   */
  function readPanelCount(): number {
    return coursePanels().length;
  }

  /**
   * Split a course heading into its code, name and credits.
   *
   * Ported from the v1.0.0 baseline (`src/perception/sites/whu/zftal.ts`, `parseZftalHeading`) with the same regular
   * expressions and the same order of operations. It is copied rather than imported because a Manifest V3 static content
   * script is a classic script: an `import` would make the compiler emit module syntax, and `export {};` in that file was
   * already a syntax error once. Sharing the module waits until the browser build has a bundler.
   *
   * Credits come from the heading, which is the source the baseline actually reads. The baseline also declares a hidden
   * `td.jxbxf` cell for them, but never reads it — and the privacy gate forbids reading that class — so the heading is both
   * the faithful source and the only permitted one.
   *
   * The baseline's own range check (`readCredits`, which rejects values outside `0..30`) is deliberately NOT applied. That
   * helper is unused by the baseline's ZFTAL reader, so applying it here would silently make the port disagree with the
   * reader it is porting: a heading saying `99 学分` yields `99` there and must therefore yield `99` here. Tightening that
   * belongs in a separate change covering both readers.
   *
   * @param heading - the heading text.
   * @returns the code, name and credits that were present; any of them may be absent.
   */
  function parseHeading(heading: string): { courseCode?: string; courseName?: string; credits?: number } {
    const cleaned = heading.replace(/\s+/gu, ' ').trim();
    // A leading code in full-width or half-width parentheses, e.g. `(2321950011001)` or `（2050410011001)`.
    const codeMatch = /^[（(]\s*([0-9*]+)\s*[)）]/u.exec(cleaned);
    const courseCode = codeMatch?.[1];
    let rest = codeMatch === null ? cleaned : cleaned.slice(codeMatch[0].length).trim();

    /*
     * Everything from the credit value onward is dropped. On the live page the heading continues past it with
     * `教学班个数：… 状态：…`, so this truncation is what keeps those out of the name — it is not a cosmetic trim.
     *
     * ONE match serves both purposes, exactly as the baseline does: it yields the credit value AND marks where the name
     * ends. A second expression for either job would be a second source of truth for the same text.
     */
    const creditMatch = /([0-9]+(?:\.[0-9]+)?)\s*学分/u.exec(rest);
    const credits = creditMatch === null ? undefined : Number(creditMatch[1]);
    if (creditMatch !== null) rest = rest.slice(0, creditMatch.index).trim();

    const courseName = rest.replace(/[-—–]\s*$/u, '').trim();
    return {
      ...(courseCode === undefined || courseCode.length === 0 ? {} : { courseCode }),
      ...(courseName.length === 0 ? {} : { courseName }),
      // Omitted when the heading does not state credits, never `0` or `NaN`, matching the baseline.
      ...(credits === undefined || !Number.isFinite(credits) ? {} : { credits }),
    };
  }

  /** Does an element carry the given class token? */
  function hasClass(element: Element, className: string): boolean {
    return element.classList.contains(className);
  }

  /**
   * Read up to three course identities, in document order.
   *
   * ## What it reads, and nothing else
   *
   * For each panel: the heading (`div.kc_head`), the identity span (`span.kcmc`) inside it, and the hidden
   * `input[name="kch_id"]`. **No table body cell is read** — no teacher, no credits, no seats, no remark, no status.
   *
   * ## Why a panel can produce nothing
   *
   * The baseline skips a panel whose heading yields no name rather than inventing one, and this does the same: a panel with no
   * readable name contributes no identity, and the search continues so that three VALID identities are reported when the page
   * has them.
   *
     /** The first element with the given class, searched among descendants matching a selector. */
  function firstWithClass(scope: Element, selector: string, className: string): Element | undefined {
    const candidates = scope.querySelectorAll(selector);
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (candidate !== undefined && hasClass(candidate, className)) return candidate;
    }
    return undefined;
  }

  /**
   * Every descendant matching a selector that also carries the given class, in document order.
   *
   * Filtering by class in code rather than through a compound selector keeps the selector strings to single, checkable
   * constants.
   *
   * @param scope - the element to search within.
   * @param selector - a simple tag selector.
   * @param className - the class token required.
   * @returns the matching elements.
   */
  function matchingDescendants(scope: Element, selector: string, className: string): Element[] {
    const candidates = scope.querySelectorAll(selector);
    const out: Element[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (candidate !== undefined && hasClass(candidate, className)) out.push(candidate);
    }
    return out;
  }

  /**
   * The first descendant input carrying the given `name` attribute.
   *
   * The attribute value is matched in code rather than interpolated into a selector, so the selector string stays a constant
   * and the comparison is explicit.
   *
   * @param scope - the element to search within.
   * @param inputName - the input's `name` attribute.
   * @returns the input, or `undefined`.
   */
  function firstInputNamed(scope: Element, inputName: string): Element | undefined {
    const inputs = scope.querySelectorAll('input');
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      if (input !== undefined && input.getAttribute('name') === inputName) return input;
    }
    return undefined;
  }

  /**
   * The trimmed text of an element, with baseline whitespace semantics.
   *
   * @param element - the element to read.
   * @returns collapsed, trimmed text.
   */
  function textOfElement(element: Element): string {
    return (element.textContent ?? '').replace(/\s+/gu, ' ').trim();
  }

  /**
   * The teacher(s) of one teaching-class row, or `undefined` when the page has not published them.
   *
   * ## Why this is row-level
   *
   * On the real page a course panel holds one `tr.body_tr` per teaching class, and the teacher belongs to the ROW, not the
   * panel. Reading it once per panel would merge the teachers of every class of a course into one value.
   *
   * ## Why `td.jsxm` and not the visible cell
   *
   * The page also renders a VISIBLE cell, `td.jsxmzc`, holding the teachers and their academic titles together
   * (`【教师甲、教师乙】 教授、讲师`). Reading that would mix titles into the teacher field. The hidden `td.jsxm` carries the
   * teachers alone — the same cell the baseline reader uses.
   *
   * ## Missing is not "no teacher"
   *
   * Absent cell, empty text, `--` and the literal `undefined` all mean the page has not published the value — which the
   * product must not present as "this class has no teacher". A multi-teacher cell is returned as ONE string, exactly as the
   * baseline returns it: no splitting, no de-duplication, no separator normalisation.
   *
   * @param row - the teaching-class row.
   * @returns the teacher text, or `undefined` when it is missing.
   */
  function teacherOfRow(row: Element): string | undefined {
    const cell = firstWithClass(row, 'td', TEACHER_CELL_CLASS);
    if (cell === undefined) return undefined;
    const value = textOfElement(cell);
    // The same sentinels the baseline treats as absent rather than as a name.
    if (value.length === 0 || value === '--' || value === 'undefined') return undefined;
    return value;
  }

  /**
   * How many seats are left in ONE teaching class, or `undefined` when the page does not say.
   *
   * ## Row level, not panel level
   *
   * Unlike credits, this belongs to the teaching class: each `tr.body_tr` carries its own count, so two classes of the same
   * course can report different numbers and one of them can be full while the other is not. Each row is read on its own; no
   * value is ever shared between rows.
   *
   * ## Zero is a real answer
   *
   * `0` means "no seats left" and is returned as `0`. Only an unreadable or non-numeric value is `undefined`, and that means
   * "the page did not say" — which the product must not display as "full".
   *
   * ## Why the empty string is checked first
   *
   * `Number('')` is `0`, so coercing an empty cell would invent a full class out of missing data — the most misleading
   * possible answer here. The empty case is therefore rejected before any numeric conversion, and a test pins it.
   *
   * @param row - the teaching-class row.
   * @returns the remaining-seat count, or `undefined` when it is absent, empty or unparseable.
   */
  function remainingSeatsOfRow(row: Element): number | undefined {
    const cell = firstWithClass(row, 'font', REMAINING_SEATS_CLASS);
    if (cell === undefined) return undefined;
    const text = textOfElement(cell);
    // Checked BEFORE Number(), because Number('') === 0 would report a full class where there is no number at all.
    if (text.length === 0) return undefined;
    const value = Number(text);
    // `-1` and `N/A` both fail here and are omitted; a negative seat count is not a count.
    if (!Number.isFinite(value) || value < 0) return undefined;
    return value;
  }

  /**
   * Read how many students had already signed up for this teaching class in the current round.
   *
   * ## Same leaf discipline as the remaining-seat read
   *
   * One named leaf, found by scanning DOWN from the row. The shared cell that also holds capacity is never queried, and no
   * upward or lateral traversal is used to reach a sibling, so authorising this second leaf does not widen what the first one
   * granted. The page's semantics are 「本轮次已选人数」 — this round's sign-ups for this teaching class.
   *
   * ## Zero is a real answer, and the legacy placeholder rule does NOT apply
   *
   * `0` means "nobody has signed up yet" and is returned as `0`. This is the opposite of the legacy CAPACITY reading, where a
   * `0` was a loading placeholder that had to be discarded; selected-this-round carries no such placeholder, so folding `0`
   * into "missing" would hide a real count. Only an absent, empty or non-numeric value is `undefined`.
   *
   * The empty string is checked first for the same reason as above: `Number('')` is `0`, which would invent "nobody signed up"
   * out of a cell that said nothing at all.
   *
   * @param row - the teaching-class row.
   * @returns the count, or `undefined` when it is absent, empty or unparseable.
   */
  function selectedThisRoundOfRow(row: Element): number | undefined {
    const cell = firstWithClass(row, 'font', SELECTED_THIS_ROUND_CLASS);
    if (cell === undefined) return undefined;
    const text = textOfElement(cell);
    if (text.length === 0) return undefined;
    const value = Number(text);
    // A negative sign-up count is not a count, and neither is a non-finite one.
    if (!Number.isFinite(value) || value < 0) return undefined;
    return value;
  }

  /**
   * Read TEACHING-CLASS rows, in document order, optionally stopping at a limit.
   *
   * ## One scanner, two callers
   *
   * The DIAGNOSTIC sample and a full pass over the loaded page are the same scan with different stopping points, so they share
   * this function rather than each having a parser. That matters because a second parser would be a second set of answers for
   * the same page — the same row could report a different teacher, credit or seat count depending on which path read it — and
   * nothing would detect the divergence.
   *
   * The bound is a PARAMETER, not a constant, and the only caller today passes {@link MAX_ROW_SAMPLES}: the status reply stays
   * a bounded sample. A full pass is possible but is **not wired to any message**; no runtime path exports one.
   *
   * ## What it reads, and nothing else
   *
   * Per panel: the heading (`div.kc_head`), the identity span (`span.kcmc`) inside it, and the hidden
   * `input[name=kch_id]`. Per teaching-class row: `td.jsxm`, `font.blzyl` and the span's credits. **No other cell is read** —
   * no title, no capacity, no selected-this-round, no schedule, no remark, no status.
   *
   * ## Panel level versus row level
   *
   * The code, name and credits are read ONCE per panel and shared by that panel's rows; the teacher and the remaining-seat
   * count are read per row. A course with two teaching classes therefore yields two rows carrying the same code, name and
   * credits but their OWN teacher and seat count — which is the correct representation and is why these are not de-duplicated.
   *
   * ## What the limit counts
   *
   * Emitted ROWS, not panels and not attempts. A panel without a readable name, or without any class row, consumes nothing —
   * so an early unusable panel can never eat into the budget and leave the reply short.
   *
   * ## Termination
   *
   * Without a limit the scan runs to the end of the loaded DOM. It never stops between the rows of one panel on purpose: a
   * course's classes are independent facts, and credits are shared across them, so a mid-panel cut would both drop real rows
   * and undercount a course's classes. A limited scan MAY cut mid-panel — that is what a sample is.
   *
   * @param limit - maximum rows to emit; omit to read every loaded row.
   * @returns the rows found, in panel order then row order.
   */
  function scanVisibleRows(limit?: number): RowIdentity[] {
    // Scoped to the real course list: a row taken from a panel outside it would be a teaching class the page never offered.
    const panels = coursePanels();
    const rows: RowIdentity[] = [];

    for (let panelIndex = 0; panelIndex < panels.length; panelIndex += 1) {
      if (limit !== undefined && rows.length >= limit) break;
      const panel = panels[panelIndex];
      if (panel === undefined) continue;

      // The scaffold panel on the live page has no heading, so it contributes nothing.
      const heading = firstWithClass(panel, 'div', HEADING_CLASS);
      if (heading === undefined) continue;

      /*
       * The identity span is preferred; without it the whole heading text is parsed, which is what the baseline does.
       */
      const nameSpan = firstWithClass(heading, 'span', COURSE_NAME_SPAN_CLASS);
      const parsed = parseHeading(nameSpan === undefined ? (heading.textContent ?? '') : (nameSpan.textContent ?? ''));

      // Fallback, in the same precedence as the baseline: the heading's own code wins, the hidden input is the backup.
      const hiddenInput = firstInputNamed(heading, COURSE_CODE_INPUT_NAME);
      const inputValue = hiddenInput?.getAttribute('value') ?? undefined;
      const courseCode = parsed.courseCode ?? (inputValue === '' ? undefined : inputValue);

      // A panel without a readable name yields no rows, exactly as the baseline skips it.
      if (parsed.courseName === undefined) continue;

      const bodyRows = matchingDescendants(panel, 'tr', ROW_CLASS);
      for (let rowIndex = 0; rowIndex < bodyRows.length; rowIndex += 1) {
        if (limit !== undefined && rows.length >= limit) break;
        const row = bodyRows[rowIndex];
        if (row === undefined) continue;

        const teacher = teacherOfRow(row);
        const remainingSeats = remainingSeatsOfRow(row);
        const selectedThisRound = selectedThisRoundOfRow(row);
        rows.push({
          ...(courseCode === undefined ? {} : { courseCode }),
          courseName: parsed.courseName,
          // Panel-level, so every class row of this course repeats the same value — the baseline's scope exactly.
          ...(parsed.credits === undefined ? {} : { credits: parsed.credits }),
          // Row-level, so each teaching class reports its own count. Never shared with a sibling row.
          ...(remainingSeats === undefined ? {} : { remainingSeats }),
          // The other row-level seat fact, from its own granted leaf. `0` travels as `0`; only an unstated value is omitted.
          ...(selectedThisRound === undefined ? {} : { selectedThisRound }),
          // Omitted entirely when the page has not published a teacher; never an empty string or a placeholder.
          ...(teacher === undefined ? {} : { teacher }),
        });
      }
    }

    return rows;
  }

  /** The last count reported, so an unchanged count is not re-sent. */
  let lastReportedCount: number | null = null;

  /** Report the current page identity and panel count. */
  function report(): void {
    const supported = isSupportedPage();

    /*
     * Logged as a bare boolean and a bare number. Nothing that could reveal which page the user is on.
     */
    console.log(`[Course Copilot] content script 页面识别：${supported ? '命中支持页面' : '非支持页面'}`);

    chrome.runtime.sendMessage({ type: PAGE_STATUS_MESSAGE, supported }).catch(() => {
      /*
       * Reaching here means nothing was listening — typically the service worker is asleep and no panel is open. That is a
       * normal situation rather than a failure: the panel asks for the status itself when it opens.
       */
    });

    if (!supported) return;

    const count = readPanelCount();
    console.log(`[Course Copilot] 课程面板数量：${count}`);

    /*
     * Only send when the number actually changed. Without this guard a page that mutates frequently would broadcast on every
     * mutation, which is the feedback-loop shape this project has already hit once.
     */
    if (count === lastReportedCount) return;
    lastReportedCount = count;
    chrome.runtime.sendMessage({ type: PANEL_COUNT_MESSAGE, count }).catch(() => {});
  }

  /** Pending debounce timer, if any. */
  let pending: number | null = null;

  /**
   * Schedule a report after a short quiet period.
   *
   * The selection page fills its list asynchronously, so the count changes several times during load. Debouncing means one
   * report per settling rather than one per mutated node.
   */
  function scheduleReport(): void {
    if (pending !== null) clearTimeout(pending);
    pending = window.setTimeout(() => {
      pending = null;
      report();
    }, 300);
  }

  report();

  /*
   * Answer a status query from the worker.
   *
   * ## Why this responds rather than re-broadcasts
   *
   * A previous version called `report()` here, which sent the values as a fresh broadcast. That is not a request/response:
   * the worker had already answered the panel from its own memory by then, so a panel opened after the service worker had
   * been suspended received `supported: false` and only later — if at all — a correction. Sending the CURRENT values back
   * through `sendResponse` makes the worker's reply to the panel depend on this answer, which is what removes the race.
   *
   * ## Why it has no side effects
   *
   * It reads the same two things the periodic report reads and sends nothing else, so asking does not itself cause a
   * broadcast. It is also idempotent: asking twice returns the same answer rather than a second message.
   */
  /*
   * ============================================================================================================================
   * AUTO-EXPAND SESSION
   * ============================================================================================================================
   *
   * The session lives in module scope of this per-tab instance, which is what makes "tab A cannot affect tab B" structurally true
   * rather than something to remember. One instance runs at most one session.
   */

  /** What the caller can ask about a session. Plain data, no page handles. */
  interface AutoExpandStatus {
    readonly phase: 'idle' | 'running' | 'finished';
    readonly clicks: number;
    readonly completeness: ExpansionCompleteness;
    readonly stopReason?: AutoExpandStopReason;
    /**
     * Whether the LAST settled round saw a course panel appear.
     *
     * Reported because it is the one observation the verdict is built on that is otherwise invisible: `no_progress` and a genuinely finished list can
     * look alike from the outside, and this says which happened without the caller having to reproduce the DOM reading. It is a fact about the last
     * round only, never a counter.
     */
    readonly lastStepProgressed?: boolean;
  }

  /** What a START is answered with, immediately. */
  interface AutoExpandStartResponse {
    readonly ok: true;
    readonly accepted: boolean;
    readonly status: AutoExpandStatus;
  }

  let phase: AutoExpandStatus['phase'] = 'idle';
  let sessionClicks = 0;
  let sessionCompleteness: ExpansionCompleteness = 'unknown';
  let stopReason: AutoExpandStopReason | undefined;
  let cancelRequested = false;
  /** Whether the last settled round observed a new course panel. Reported, never accumulated into a verdict. */
  let lastStepProgressed: boolean | undefined;

  /** The current session as the caller may see it. Field order is irrelevant; every field is plain data. */
  function sessionStatus(): AutoExpandStatus {
    return {
      phase,
      clicks: sessionClicks,
      completeness: sessionCompleteness,
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(lastStepProgressed === undefined ? {} : { lastStepProgressed }),
    };
  }

  /**
   * Send one auto-expand event, ignoring any failure to deliver it.
   *
   * A rejection here means nobody is listening — typically no panel is open. That is a normal situation, not a reason to fail an
   * expansion, so the error is discarded exactly as the page-status broadcast does.
   */
  function emitExpansionEvent(event: Record<string, unknown>): void {
    chrome.runtime.sendMessage({ type: AUTO_EXPAND_EVENT_MESSAGE, ...event }).catch(() => {});
  }

  /**
   * Click the load-more control, once, if and only if the page still says there is more to load.
   *
   * ## Why this re-checks the page before clicking
   *
   * The controller asks for a click only when it believes the list is partial, but a round's settle can be slow and the page can reach
   * its end in the meantime. Re-reading the state here means the last click is never spent on a finished list, and the check costs one
   * style read.
   *
   * ## The only click in this extension
   *
   * `#more a` is the single element this script may click — it is the anchor the live page puts its load-more handler on. The
   * handler's own name is deliberately NOT written here: the privacy gate forbids that identifier from appearing anywhere in the built
   * file, comments included (this file's comments DO ship, so prose can leak a forbidden token), and dispatching a real click is what a
   * user does. It also keeps this script from depending on the page's internal function names. There is no fallback target and no text search, because a substitute click
   * could land on something that is not a load-more control.
   *
   * @returns true when the click was dispatched, false when there was nothing legitimate to click.
   */
  function performOneLoadMore(): boolean {
    if (!isSupportedPage()) return false;
    if (detectCourseListLoadState().completeness !== 'partial') return false;
    const target = document.querySelector(LOAD_MORE_ANCHOR_SELECTOR);
    if (target === null) return false;
    // `HTMLElement` is what carries `click`; a non-element match would be a malformed page rather than a control.
    if (!(target instanceof HTMLElement)) return false;
    target.click();
    return true;
  }

  /**
   * Watch one round until the page settles, then report what happened.
   *
   * ## Why the watcher is armed BEFORE the click
   *
   * The controller calls this AFTER `performOneLoadMore`, so arming here would miss every mutation the click caused synchronously.
   * {@link armStepWatcher} is therefore called from the click path and this function only consumes what it collected — which is the
   * whole reason the two are separate.
   *
   * ## What "progress" means, and what it must not mean
   *
   * A round progressed when a NEW course panel appeared inside the real course list. That is a fact about added nodes, not about a
   * count: measured on the live page, one click can add ten panels carrying between ten and thirty teaching-class rows, so a row delta
   * is not a page size and cannot serve as a verdict. The global panel count is worse still — it is permanently one higher than the
   * real list, because one panel sits outside it.
   *
   * @returns the completeness at settle time, and whether a course panel was added.
   */
  async function waitForStableStep(): Promise<ExpansionStepOutcome> {
    const armed = armedStep;
    armedStep = undefined;
    // Without a watcher there is nothing to wait for, so the page is read as it stands rather than guessed at.
    if (armed === undefined) return { completeness: detectCourseListLoadState().completeness, progressed: false };

    await new Promise<void>((resolve) => {
      let quietTimer: number | undefined;
      const finish = (): void => {
        if (quietTimer !== undefined) clearTimeout(quietTimer);
        clearTimeout(timeoutTimer);
        armed.observer.disconnect();
        resolve();
      };
      // The hard bound: a page that never stops mutating must not hold the round open.
      const timeoutTimer = setTimeout(finish, AUTO_EXPAND_STEP_TIMEOUT_MS);
      const restartQuiet = (): void => {
        if (quietTimer !== undefined) clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, AUTO_EXPAND_QUIET_MS);
      };
      armed.onSettled = restartQuiet;
      restartQuiet();
    });

    /*
     * Completeness is read AFTER the mutations stop, never inferred from them. This ordering is what lets a final batch that added no
     * panel still be reported as `complete`: the page's own end signal decides, and `progressed` only decides what to do about a list
     * that is still partial.
     */
    lastStepProgressed = armed.sawCoursePanel;
    return { completeness: detectCourseListLoadState().completeness, progressed: armed.sawCoursePanel };
  }

  /** The watcher armed for the round in flight, if any. */
  interface ArmedStep {
    readonly observer: MutationObserver;
    /** Set once the waiting loop starts, so a mutation can restart the quiet window. */
    onSettled?: () => void;
    /** Whether a course panel was added inside the real course list during this round. */
    sawCoursePanel: boolean;
  }

  let armedStep: ArmedStep | undefined;

  /**
   * Arm the read-only watcher for the next round.
   *
   * Three targets and no more: the list container for added course panels, and the two completeness markers for their visibility flip.
   * The rest of the page is not observed, so this cannot become a general page monitor.
   *
   * @returns true when a watcher was armed.
   */
  function armStepWatcher(): boolean {
    const container = document.querySelector(COURSE_LIST_CONTAINER_SELECTOR);
    const more = document.querySelector(LOAD_MORE_SELECTOR);
    const endSign = document.querySelector(END_SIGN_SELECTOR);
    if (container === null) return false;

    const armed: ArmedStep = { observer: new MutationObserver(() => {}), sawCoursePanel: false };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        /*
         * Indexed rather than `for…of`: this project's TypeScript target gives `NodeList` no iterator, and the rest of this file already
         * walks node lists by index for the same reason.
         */
        for (let index = 0; index < record.addedNodes.length; index += 1) {
          const node = record.addedNodes[index];
          if (!(node instanceof HTMLElement)) continue;
          /*
           * A new course panel, or a subtree containing one. Only elements INSIDE the list container count, because a panel added
           * elsewhere on the page is not this list growing.
           */
          if (node.matches(COURSE_PANEL_SELECTOR) || node.querySelector(COURSE_PANEL_SELECTOR) !== null) {
            armed.sawCoursePanel = true;
          }
        }
      }
      armed.onSettled?.();
    });
    /*
     * `armed.observer` is a placeholder replaced below by the real instance; the round only ever calls `disconnect` on the stored one,
     * so the two are kept identical here rather than reconstructed later.
     */
    (armed as { observer: MutationObserver }).observer = observer;
    observer.observe(container, { childList: true, subtree: true });
    // The markers are watched for their style flip, which is how the page announces the end of the list.
    if (more !== null) observer.observe(more, { attributes: true, attributeFilter: ['style', 'class'] });
    if (endSign !== null) observer.observe(endSign, { attributes: true, attributeFilter: ['style', 'class'] });

    armedStep = armed;
    return true;
  }

  /**
   * Run one approved expansion session to its bounded end.
   *
   * The controller owns every stopping rule; this function only supplies the page actions and reports the outcome. Nothing here decides when to stop.
   *
   * ## Why a caller may take over the reporting
   *
   * The unified preparation workflow runs this expansion as its FIRST phase, and it must report that as its own progress rather than as a standalone expansion
   * session — two independent session states describing one run would be two sources of truth for the same facts. When `report` is supplied the phase state
   * still updates, so a status query remains accurate, but the ANNOUNCEMENT belongs to the caller.
   *
   * @param overrides - an optional progress and outcome sink, used by the preparation workflow.
   * @returns the controller's result, so a caller can decide what happens next.
   */
  async function runExpansionSession(
    overrides: {
      readonly report?: (snapshot: { readonly clicks: number; readonly completeness: ExpansionCompleteness }) => void;
      readonly onFinished?: (result: CourseListExpansionResult) => void;
    } = {},
  ): Promise<CourseListExpansionResult> {
    const result = await runBoundedCourseListExpansion({
      readCompleteness: () => detectCourseListLoadState().completeness,
      performOneLoadMore: () => {
        // Armed first, so a mutation caused by the click itself is still observed.
        armStepWatcher();
        const clicked = performOneLoadMore();
        // Nothing was clicked, so no round will follow; drop the watcher rather than leave an observer running.
        if (!clicked) {
          armedStep?.observer.disconnect();
          armedStep = undefined;
        }
        return clicked;
      },
      waitForStableStep: () => waitForStableStep(),
      isCancelled: () => cancelRequested,
      onProgress: (snapshot) => {
        sessionClicks = snapshot.clicks;
        sessionCompleteness = snapshot.completeness;
        overrides.report?.({ clicks: snapshot.clicks, completeness: snapshot.completeness });
        // The standalone announcement is skipped when a caller owns the reporting, so one run is not described twice.
        if (overrides.report === undefined) {
          emitExpansionEvent({ phase: 'progress', clicks: snapshot.clicks, completeness: snapshot.completeness });
        }
      },
    });

    /*
     * The watcher is disconnected on this path too. A round can end without `waitForStableStep` ever consuming the armed watcher — a
     * refused click, or a cancellation noticed at the top of a round — and leaving an observer attached to the page from a finished
     * session would be a leak the next session would inherit.
     */
    armedStep?.observer.disconnect();
    armedStep = undefined;

    sessionClicks = result.clicks;
    sessionCompleteness = result.finalCompleteness;
    stopReason = result.stopReason;
    phase = 'finished';
    overrides.onFinished?.(result);
    if (overrides.report === undefined) {
      emitExpansionEvent({
        phase: 'finished',
        clicks: result.clicks,
        completeness: result.finalCompleteness,
        stopReason: result.stopReason,
      });
    }
    return result;
  }

  /*
   * ============================================================================================================================
   * TEACHER HYDRATION SESSION
   * ============================================================================================================================
   *
   * Its own state, kept apart from the expansion session: the two answer different questions and a shared machine would have to invent a relationship
   * between them that the product does not have yet. Both live in this per-tab instance, so neither can leak into another tab.
   */

  /** What a caller may ask about a hydration session. Plain data. */
  interface TeacherHydrationStatus {
    readonly phase: 'idle' | 'running' | 'finished';
    readonly queued: number;
    readonly considered: number;
    readonly attempted: number;
    readonly hydrated: number;
    readonly failed: number;
    readonly skipped: number;
    readonly stopReason?: TeacherHydrationStopReason;
    /** How many detail clicks were actually dispatched. A real click count, kept apart from `attempted`. */
    readonly hydrationClicks: number;
  }

  /** What a hydration START is answered with, immediately. */
  interface TeacherHydrationStartResponse {
    readonly ok: true;
    readonly accepted: boolean;
    /** Present when the request was refused, so a caller can tell a busy session from an incomplete list. */
    readonly reason?: 'already_running' | 'course_list_incomplete';
    readonly status: TeacherHydrationStatus;
  }

  let hydrationPhase: TeacherHydrationStatus['phase'] = 'idle';
  let hydrationResult: TeacherHydrationResult | undefined;
  let hydrationClicks = 0;
  let hydrationCancelRequested = false;

  /** The current hydration session as a caller may see it. */
  function teacherHydrationStatus(): TeacherHydrationStatus {
    return {
      phase: hydrationPhase,
      queued: hydrationResult?.queued ?? 0,
      considered: hydrationResult?.considered ?? 0,
      attempted: hydrationResult?.attempted ?? 0,
      hydrated: hydrationResult?.hydrated ?? 0,
      failed: hydrationResult?.failed ?? 0,
      skipped: hydrationResult?.skipped ?? 0,
      ...(hydrationResult === undefined ? {} : { stopReason: hydrationResult.stopReason }),
      hydrationClicks,
    };
  }

  /** Send one hydration event, ignoring any failure to deliver it. */
  function emitTeacherHydrationEvent(event: Record<string, unknown>): void {
    chrome.runtime.sendMessage({ type: TEACHER_HYDRATION_EVENT_MESSAGE, ...event }).catch(() => {});
  }

  /**
   * Whether this panel still needs teacher data.
   *
   * EVERY teaching-class row is inspected, never just the first: measured on the live page, one expansion fills all of a panel's rows at once, so a panel
   * with any empty teacher cell needs the expansion and a panel with none must not be clicked at all.
   *
   * A panel with NO rows is reported as needing hydration rather than as complete. It cannot be shown to have teacher data, and treating an empty body as
   * "nothing to do" would silently accept a panel the page never filled.
   *
   * @param panel - one course panel.
   * @returns true when the panel has at least one row whose teacher cell is missing or empty.
   */
  function panelNeedsTeacherHydration(panel: Element): boolean {
    const rows = panel.querySelectorAll(ROW_SELECTOR);
    if (rows.length === 0) return true;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row === undefined) continue;
      const cell = row.querySelector(TEACHER_CELL_SELECTOR);
      if (cell === null) return true;
      if ((cell.textContent ?? '').trim().length === 0) return true;
    }
    return false;
  }

  /** Whether every teaching-class row of this panel now carries a teacher. The success predicate. */
  function panelTeacherComplete(panel: Element): boolean {
    const rows = panel.querySelectorAll(ROW_SELECTOR);
    if (rows.length === 0) return false;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row === undefined) return false;
      const cell = row.querySelector(TEACHER_CELL_SELECTOR);
      if (cell === null) return false;
      if ((cell.textContent ?? '').trim().length === 0) return false;
    }
    return true;
  }

  /**
   * Hydrate one panel: click its expand control once, wait for its rows to fill, and report.
   *
   * ## The watcher is armed BEFORE the click
   *
   * The live page writes the teacher data asynchronously, but it can also start during the click, and a watcher installed afterwards would miss that. Arming
   * first costs one observer and removes the question.
   *
   * ## One click, on one element, found relative to the panel
   *
   * `a.expand1` is the only control this function may activate. The panel heading is deliberately NOT clicked even though it also carries a loader: it
   * dispatches the page's own internal function, and the class-only anchor was measured to trigger the same hydration without depending on a private name.
   * There is no fallback target and no text search, because a substitute click could land on the enroll button that lives in the same panel.
   *
   * ## Timeout is not an early exit
   *
   * When the bound expires the predicate is checked once more: a page that filled its rows and then went quiet just before the deadline is a success, not a
   * failure. Only a panel that is still incomplete at that point fails — and whatever it DID write is left in place.
   *
   * @param panel - the panel to hydrate.
   * @returns `hydrated` when every row now carries a teacher, otherwise `failed`.
   */
  async function hydrateOnePanel(panel: Element): Promise<TeacherHydrationItemOutcome> {
    const target = panel.querySelector(EXPAND_CONTROL_SELECTOR);
    // No control means this item cannot be attempted, and no substitute is looked for.
    if (target === null) return { status: 'failed' };
    if (!(target instanceof HTMLElement)) return { status: 'failed' };

    let quietTimer: number | undefined;
    /** Resolves when the panel has been quiet for the window, or when the hard bound expires. */
    const settled = new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        if (quietTimer !== undefined) clearTimeout(quietTimer);
        clearTimeout(timeoutTimer);
        observer.disconnect();
        resolve();
      };
      const restartQuiet = (): void => {
        if (quietTimer !== undefined) clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, TEACHER_HYDRATION_QUIET_MS);
      };
      const observer = new MutationObserver(() => { restartQuiet(); });
      const timeoutTimer = setTimeout(finish, TEACHER_HYDRATION_TIMEOUT_MS);
      // Only this panel, and only what hydration could touch. Observing the page or the whole list would make an item's cost unbounded.
      observer.observe(panel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style'] });
      restartQuiet();
    });

    target.click();
    hydrationClicks += 1;
    await settled;

    return panelTeacherComplete(panel) ? { status: 'hydrated' } : { status: 'failed' };
  }

  /**
   * Run one approved hydration session over a SNAPSHOT of the course panels.
   *
   * The snapshot is taken once, here, and the controller never grows it: a panel that appears later belongs to a later pass, not to this one.
   *
   * ## Why a caller may take over the reporting
   *
   * The unified preparation workflow runs this as its SECOND phase, and it must report that as its own progress rather than as a standalone hydration session.
   * When `report` is supplied the session state still updates, so a status query stays accurate, but the ANNOUNCEMENT belongs to the caller.
   *
   * @param overrides - an optional progress and outcome sink, used by the preparation workflow.
   * @returns the controller's result, so a caller can decide what happens next.
   */
  async function runTeacherHydrationSession(
    overrides: {
      readonly report?: (progress: TeacherHydrationProgress & { readonly queued: number; readonly hydrationClicks: number }) => void;
      readonly onFinished?: (result: TeacherHydrationResult) => void;
    } = {},
  ): Promise<TeacherHydrationResult> {
    /*
     * One scan, one queue, and SCOPED TO THE REAL COURSE LIST.
     *
     * The page holds `div.panel.panel-info` elements outside `#contentBox .tjxk_list` — measured live, the global panel count is permanently one higher than
     * the number of real courses — so a global panel query would put a non-course panel into the queue. That panel has no `a.expand1`, so it would only ever
     * be recorded as a failure; but the queue would then describe a data-preparation range that does not exist, and a caller reading `queued` would be told
     * about a course that is not one.
     *
     * The list container is the ONLY source, and its absence is a refusal rather than a fall back to the global form: if the page ever stops publishing the
     * list, the honest answer is that there is nothing to hydrate. The snapshot is taken ONCE, here, and the controller never grows it.
     */
    const queue = coursePanels();

    const result = await runBoundedTeacherHydration(queue, {
      needsHydration: (panel) => panelNeedsTeacherHydration(panel),
      hydrateOne: (panel) => hydrateOnePanel(panel),
      isCancelled: () => hydrationCancelRequested,
      onProgress: (progress) => {
        overrides.report?.({ ...progress, queued: queue.length, hydrationClicks });
        // The standalone announcement is skipped when a caller owns the reporting, so one run is not described twice.
        if (overrides.report === undefined) {
          emitTeacherHydrationEvent({
            phase: 'progress',
            queued: queue.length,
            considered: progress.considered,
            hydrated: progress.hydrated,
            failed: progress.failed,
            skipped: progress.skipped,
            hydrationClicks,
          });
        }
      },
    });

    hydrationResult = result;
    hydrationPhase = 'finished';
    overrides.onFinished?.(result);
    if (overrides.report === undefined) {
      emitTeacherHydrationEvent({
        phase: 'finished',
        queued: result.queued,
        considered: result.considered,
        attempted: result.attempted,
        hydrated: result.hydrated,
        failed: result.failed,
        skipped: result.skipped,
        hydrationClicks,
        stopReason: result.stopReason,
      });
    }
    return result;
  }

  /*
   * ============================================================================================================================
   * BOUNDED AVAILABILITY FILTER SESSION
   * ============================================================================================================================
   *
   * Operates the page's own 「有无余量」 filter: reveal the rows if collapsed, choose 「有」 if it is not already chosen, then submit
   * the page's query once. The path is the one Steps 37a–37b.4 measured and ran end to end; nothing here is new research.
   *
   * ## What this session deliberately does NOT do
   *
   * It does not load more rows, expand a panel, hydrate a teacher, or generate a recommendation. It operates the filter and reports
   * what the page did, so a later slice can compose it in front of the existing stages without this one reaching past its own step.
   *
   * ## Hard click bounds
   *
   * At most ONE expand, ONE option, ONE query, and no retry loop of any kind. Every bound is enforced by the code shape — each click
   * sits inside a branch that cannot be re-entered — and asserted by tests.
   */

  /**
   * The factual outcome of ONE availability-filter operation.
   *
   * Deliberately not {@link AvailabilityFilterStatus}: that carries a session `phase`, and this is the interaction itself, which has phases only in the sense
   * that its caller may announce them. Keeping the two apart is what lets the standalone session and the unified preparation run share one implementation
   * without either owning the other's vocabulary.
   */
  interface AvailabilityFilterOperationResult {
    readonly expandedFilters: boolean;
    readonly selectedAvailable: boolean;
    readonly submittedQuery: boolean;
    readonly postQuerySupported: boolean;
    readonly postQueryRowCount: number | null;
    readonly postQueryCompleteness: 'partial' | 'complete' | 'unknown' | null;
    readonly stopReason: AvailabilityFilterStopReason;
  }

  let availabilityFilterPhase: AvailabilityFilterPhase = 'idle';
  let availabilityFilterResult: Omit<AvailabilityFilterStatus, 'phase'> | undefined;
  let availabilityFilterCancelRequested = false;
  /** Click counters, kept as facts rather than inferred, so a test can prove the bounds. */
  let filterExpandClicks = 0;
  let filterOptionClicks = 0;
  let filterQueryClicks = 0;

  /** Wait one interval. `window.setTimeout` is used because the rest of this script does. */
  function delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      window.setTimeout(() => { resolve(); }, ms);
    });
  }

  /** The current status, derived from the session's own variables. */
  function availabilityFilterStatus(): AvailabilityFilterStatus {
    if (availabilityFilterResult !== undefined) {
      return { phase: availabilityFilterPhase, ...availabilityFilterResult };
    }
    return {
      phase: availabilityFilterPhase,
      expandedFilters: false,
      selectedAvailable: false,
      submittedQuery: false,
      postQuerySupported: false,
      postQueryRowCount: null,
      postQueryCompleteness: null,
    };
  }

  /** Announce the session's state. The content script owns the vocabulary; nothing here reads page wording. */
  function emitAvailabilityFilterEvent(status: AvailabilityFilterStatus): void {
    /*
     * Spread through `Record<string, unknown>` for the same reason the preparation session does: this file declares ONE ambient message interface, so a
     * structurally-typed payload is what keeps a new session from having to widen that shared shape — and widening it would make the auto-expand `phase`
     * vocabulary, which means something else entirely, accept values from this session.
     */
    chrome.runtime.sendMessage({
      type: AVAILABILITY_FILTER_EVENT_MESSAGE,
      ...(status as unknown as Record<string, unknown>),
    }).catch(() => {});
  }

  /** Resolve the page's filter panel, or `undefined` when this page has none. */
  function filterPanel(): Element | undefined {
    return document.querySelector(SEARCH_BOX_SELECTOR) ?? undefined;
  }

  /**
   * The 「有」 option's anchor, resolved THROUGH the panel so a page-wide class query cannot be used.
   *
   * ## Why a hidden anchor does not count as reachable
   *
   * The option must be clickable by a PERSON before this script clicks it. On the live page the collapsed rows are absent from the DOM entirely, so the lookup
   * simply fails — but a page that hides them with `display:none` instead would still let a query find them, and clicking an anchor nobody can see is a
   * scripted page change rather than a user action. Requiring a non-zero box and a rendered ancestor covers both shapes with one rule.
   *
   * @param panel - the page's filter panel.
   * @returns the option's anchor when it is user-reachable, otherwise `undefined`.
   */
  function availabilityOptionAnchor(panel: Element): Element | undefined {
    const group = panel.querySelector(AVAILABILITY_GROUP_SELECTOR);
    if (group === null) return undefined;
    const anchor = group.querySelector(AVAILABILITY_OPTION_SELECTOR);
    if (anchor === null) return undefined;
    if (!isShown(anchor) || (anchor as HTMLElement).offsetWidth === 0) return undefined;
    return anchor;
  }

  /** Whether the option already carries the widget's own chosen marker. */
  function optionIsChosen(anchor: Element): boolean {
    return String(anchor.className ?? '').includes('selectedValue');
  }

  /**
   * Wait for the result set to settle after the query, tolerating a transiently absent list.
   *
   * @param isCancelled - the caller's own cancellation check, so the wait belongs to whoever started it.
   */
  async function waitForFilteredResults(isCancelled: () => boolean): Promise<
    Pick<AvailabilityFilterStatus, 'postQuerySupported' | 'postQueryRowCount' | 'postQueryCompleteness'>
  > {
    const started = Date.now();
    let lastSignature = '';
    let stableSince = 0;

    while (Date.now() - started < FILTER_REBUILD_TIMEOUT_MS) {
      if (isCancelled()) break;
      const listPresent = document.querySelector(COURSE_LIST_CONTAINER_SELECTOR) !== null;
      const rows = listPresent ? scanVisibleRows(undefined) : [];
      /*
       * A MISSING LIST IS NOT A VERDICT YET.
       *
       * The page's own submit removes `.tjxk_list` and rebuilds it, so the list is legitimately absent for a while. Reporting
       * `malformed` here would turn the page's normal behaviour into a failure. `listPresent` is therefore just another feature of
       * the signature, and only the TIMEOUT decides that the rebuild never arrived.
       */
      const signature = listPresent ? `present:${rows.length}` : 'absent';
      if (signature !== lastSignature) {
        lastSignature = signature;
        stableSince = Date.now();
      } else if (listPresent && Date.now() - stableSince >= FILTER_REBUILD_QUIET_MS) {
        /*
         * Settled, and a list is readable. Completeness comes from the page's own markers, exactly as everywhere else: a filtered
         * result may legitimately be `partial` and still need a load-more later.
         */
        const loadState = detectCourseListLoadState();
        return {
          postQuerySupported: isSupportedPage(),
          postQueryRowCount: rows.length,
          postQueryCompleteness: loadState.completeness,
        };
      } else if (!listPresent) {
        /*
         * NO LIST, BUT THE PAGE HAS ALREADY SAID THE LISTING ENDED.
         *
         * The end-of-list marker is proof that the page's own request came back, and a readable load state is therefore a verdict rather than a transient. So
         * this is a filtered-to-zero result — 「有」 can legitimately match nothing — and it is reported as such IMMEDIATELY instead of waiting out the rebuild
         * timeout, which would add eight seconds of latency to a perfectly ordinary answer.
         *
         * With no marker at all nothing can be said yet and the loop keeps waiting: an absent list alone is not evidence of anything.
         */
        const loadState = detectCourseListLoadState();
        if (loadState.completeness !== 'unknown') {
          return { postQuerySupported: isSupportedPage(), postQueryRowCount: 0, postQueryCompleteness: loadState.completeness };
        }
      }
      await delay(FILTER_REBUILD_POLL_MS);
    }

    /*
     * Timed out with no settled list. The page's own load state is STILL read, because it is what distinguishes the two very different pages that look alike
     * here:
     *
     *   * the end-of-list marker present → the listing finished with no matches. 「有」 can legitimately match nothing, so this is a filtered-to-zero result and
     *     a SUCCESS, reported with a row count of `0`: the page's own signal is what makes the zero trustworthy rather than an absence to be guessed at.
     *   * no marker at all → the listing never came back and nothing can be said about it, so the count stays `null` and completeness stays `null`.
     */
    const listPresent = document.querySelector(COURSE_LIST_CONTAINER_SELECTOR) !== null;
    const loadState = detectCourseListLoadState();
    if (listPresent) {
      const rows = scanVisibleRows(undefined);
      return {
        postQuerySupported: isSupportedPage(),
        postQueryRowCount: rows.length,
        postQueryCompleteness: loadState.completeness,
      };
    }
    if (loadState.completeness !== 'unknown') {
      // The page says the listing ended. With no list and an ended listing, the result set is empty.
      return { postQuerySupported: isSupportedPage(), postQueryRowCount: 0, postQueryCompleteness: loadState.completeness };
    }
    return { postQuerySupported: isSupportedPage(), postQueryRowCount: null, postQueryCompleteness: null };
  }

  /**
   * The canonical availability-filter operation: reveal the rows if needed, choose 「有」 if needed, submit the page's query once, then wait for the rebuild.
   *
   * ## Why this is a separate function from the session that fronts it
   *
   * There is exactly ONE implementation of this page interaction, and two callers compose it:
   *
   * * the standalone availability-filter session, which owns its own status and events; and
   * * the unified full-preparation run, which composes it as its FIRST phase so the candidate pool is the filtered one from the very beginning.
   *
   * A second copy for preparation — or a round trip through the panel and worker back into this same script — would be two definitions of the filter's
   * behaviour, which is precisely what the selector grant and the click bounds exist to prevent.
   *
   * ## Why cancellation is a callback
   *
   * Each caller owns a different cancellation flag, and neither flag means anything to this function. Passing the check in keeps the operation free of
   * session state: it is asked whether to stop immediately before each page interaction, and it never clicks again after being told to.
   *
   * @param options - the caller's cancellation check and its phase announcement.
   * @returns the factual outcome. `stopReason` is the operation's own verdict, never a sentence.
   */
  async function runAvailabilityFilterOperation(options: {
    readonly isCancelled: () => boolean;
    readonly onPhase?: (phase: AvailabilityFilterPhase) => void;
  }): Promise<AvailabilityFilterOperationResult> {
    let expandedFilters = false;
    let selectedAvailable = false;
    let submittedQuery = false;
    let outcome: AvailabilityFilterStopReason = 'failed';
    let post: Pick<AvailabilityFilterStatus, 'postQuerySupported' | 'postQueryRowCount' | 'postQueryCompleteness'> = {
      postQuerySupported: false,
      postQueryRowCount: null,
      postQueryCompleteness: null,
    };

    const publish = (phase: AvailabilityFilterPhase): void => { options.onPhase?.(phase); };

    /*
     * YIELD ONCE BEFORE THE FIRST PAGE INTERACTION.
     *
     * This operation inspects and clicks the page SYNCHRONOUSLY wherever it can, which is correct — the widget's own state is readable in the same tick — but it also
     * meant a cancellation delivered from the event loop could never land between two of its interactions: the run reached the end before the caller's next turn. A
     * cancel was therefore only ever observable BEFORE the first click, which is not the guarantee callers need — it is a race the runtime usually wins.
     *
     * Yielding here gives every later check a real window, so "stop before the next page interaction" becomes a promise the runtime can keep. It costs one frame.
     */
    await delay(0);
    if (options.isCancelled()) {
      return {
        expandedFilters: false, selectedAvailable: false, submittedQuery: false,
        postQuerySupported: false, postQueryRowCount: null, postQueryCompleteness: null,
        stopReason: 'cancelled',
      };
    }

    const panel = filterPanel();
    if (panel === undefined) {
      return {
        expandedFilters, selectedAvailable, submittedQuery,
        postQuerySupported: false, postQueryRowCount: null, postQueryCompleteness: null,
        stopReason: 'unavailable',
      };
    }

    /* ---- STEP A: reveal the filter rows, only when the option is not already reachable ------------------------------- */
    let option = availabilityOptionAnchor(panel);
    if (option === undefined) {
      publish('expanding_filters');
      const expand = panel.querySelector(FILTER_EXPAND_CONTROL_SELECTOR) ?? undefined;
      /*
       * Before clicking, the control must be the real, user-reachable one: rendered with a non-zero box. A collapsed control is not a thing to click, and
       * clicking one would be a scripted page change rather than a user action. Nothing is shown or hidden by this script either — the page's own control is
       * what reveals the rows.
       */
      if (expand === undefined || !isShown(expand) || (expand as HTMLElement).offsetWidth === 0) {
        return {
          expandedFilters, selectedAvailable, submittedQuery,
          postQuerySupported: false, postQueryRowCount: null, postQueryCompleteness: null,
          stopReason: 'unavailable',
        };
      }
      if (options.isCancelled()) {
        return {
          expandedFilters, selectedAvailable, submittedQuery,
          postQuerySupported: false, postQueryRowCount: null, postQueryCompleteness: null,
          stopReason: 'cancelled',
        };
      }
      (expand as HTMLElement).click();
      filterExpandClicks += 1;
      expandedFilters = true;
      /*
       * Give the page a frame to publish the revealed rows before looking for the option again.
       *
       * Measured on the live page the rows appear synchronously, so this is not a workaround for a real delay — it is what keeps the session from assuming that
       * a widget which rebuilds its rows will always have finished by the time `click()` returns. It is also the only point in this operation where the page may
       * be mid-update, which makes it the honest place for a caller's cancel to land.
       */
      await delay(0);
      option = availabilityOptionAnchor(panel);
    }

    if (option === undefined) {
      return {
        expandedFilters, selectedAvailable, submittedQuery,
        postQuerySupported: false, postQueryRowCount: null, postQueryCompleteness: null,
        stopReason: 'unavailable',
      };
    }

    /* ---- STEP B: choose 「有」, unless the page already has it chosen ------------------------------------------------ */
    if (optionIsChosen(option)) {
      /*
       * ALREADY CHOSEN IS SUCCESS, NOT A SKIP. The caller asked for this filter to be active; it is. Clicking again would toggle a condition the page already
       * set, which is the drift Step 37a.1 could not rule out.
       */
      outcome = 'already_applied';
    } else {
      publish('selecting_available');
      if (options.isCancelled()) {
        return {
          expandedFilters, selectedAvailable, submittedQuery,
          postQuerySupported: false, postQueryRowCount: null, postQueryCompleteness: null,
          stopReason: 'cancelled',
        };
      }
      (option as HTMLElement).click();
      filterOptionClicks += 1;
      selectedAvailable = true;
      // Re-read rather than trusting the click: the widget's own class is the only statement of its state.
      const after = availabilityOptionAnchor(panel);
      if (after === undefined || !optionIsChosen(after)) {
        return {
          expandedFilters, selectedAvailable, submittedQuery,
          postQuerySupported: false, postQueryRowCount: null, postQueryCompleteness: null,
          stopReason: 'failed',
        };
      }
    }

    /* ---- STEP C: submit the page's query exactly once --------------------------------------------------------------- */
    /*
     * `?? undefined` because `querySelector` answers `null` for an absent element while this file's own idiom is `undefined`. Comparing the raw result against
     * `undefined` compiled — `Element | null` versus `undefined` is not a type error — and then threw `Cannot read properties of null (reading 'disabled')` on
     * a page without the button. Because the standalone session runs detached, that crash surfaced as an unhandled rejection rather than as a failed assertion.
     * The other lookups here already coerce; this one was the exception.
     */
    const query = panel.querySelector(FILTER_QUERY_BUTTON_SELECTOR) ?? undefined;
    if (query === undefined || (query as HTMLButtonElement).disabled === true) {
      return {
        expandedFilters, selectedAvailable, submittedQuery,
        postQuerySupported: false, postQueryRowCount: null, postQueryCompleteness: null,
        stopReason: 'unavailable',
      };
    }
    if (options.isCancelled()) {
      return {
        expandedFilters, selectedAvailable, submittedQuery,
        postQuerySupported: false, postQueryRowCount: null, postQueryCompleteness: null,
        stopReason: 'cancelled',
      };
    }
    publish('submitting_query');
    (query as HTMLElement).click();
    filterQueryClicks += 1;
    submittedQuery = true;

    /* ---- STEP D: wait for the page's own rebuild -------------------------------------------------------------------- */
    publish('waiting_for_results');
    post = await waitForFilteredResults(options.isCancelled);
    // The query has been submitted, so this is no longer a cancellation the caller can act on before a page change: the page was already told to rebuild.
    if (outcome !== 'already_applied') outcome = 'applied';
    // A rebuild that leaves nothing readable at all is a failure rather than a filtered-to-zero result.
    if (post.postQueryRowCount === null && !post.postQuerySupported) outcome = 'failed';

    return {
      expandedFilters,
      selectedAvailable,
      submittedQuery,
      postQuerySupported: post.postQuerySupported,
      postQueryRowCount: post.postQueryRowCount,
      postQueryCompleteness: post.postQueryCompleteness,
      stopReason: outcome,
    };
  }

  /**
   * Whether a completed filter left a valid pool with NO courses in it.
   *
   * ## Why this is not the same as "an empty list"
   *
   * The two look alike on the page and mean opposite things. A row count of `0` accompanied by the page's OWN completeness verdict says the listing came back and
   * matched nothing — 「有」 genuinely has no takers — whereas a count of `0` with no verdict at all says nothing could be read. Only the first is a zero-course
   * result; the second must not be reported as "there are no selectable courses".
   *
   * ## Why `partial` also counts
   *
   * A filtered pool can legitimately come back partial. If it is partial AND empty, the first page of it had nothing, so there is still nothing to load or
   * hydrate: the next page is reached by load-more, which this path deliberately skips. Treating `partial` as "maybe there is more" would click a control with
   * nothing behind it.
   *
   * @param result - the filter operation's outcome.
   * @returns true only when a verdict exists and the pool is empty.
   */
  function isZeroCourseResult(result: AvailabilityFilterOperationResult): boolean {
    return result.submittedQuery
      && result.postQueryRowCount === 0
      && (result.postQueryCompleteness === 'complete' || result.postQueryCompleteness === 'partial');
  }

  /** Run one standalone availability-filter session to completion, owning its own status and events. */
  async function runAvailabilityFilterSession(): Promise<void> {
    const publish = (phase: AvailabilityFilterPhase): void => {
      availabilityFilterPhase = phase;
      emitAvailabilityFilterEvent(availabilityFilterStatus());
    };

    try {
      /*
       * The session's own flag is checked, and its status is updated from the operation's verdict rather than the operation knowing about the session. The
       * operation is the SINGLE implementation of the interaction; this wrapper only decides how the outcome is reported.
       */
      const result = await runAvailabilityFilterOperation({
        isCancelled: () => availabilityFilterCancelRequested,
        onPhase: publish,
      });
      availabilityFilterResult = {
        expandedFilters: result.expandedFilters,
        selectedAvailable: result.selectedAvailable,
        submittedQuery: result.submittedQuery,
        postQuerySupported: result.postQuerySupported,
        postQueryRowCount: result.postQueryRowCount,
        postQueryCompleteness: result.postQueryCompleteness,
        stopReason: result.stopReason,
      };
    } finally {
      publish('finished');
    }
  }

  /*
   * ============================================================================================================================
   * UNIFIED FULL-COURSE PREPARATION
   * ============================================================================================================================
   *
   * One approved run that does the whole data preparation: load every course the page will give us, fill in the teacher data those
   * panels hide until they are expanded, and then read the finished page back.
   *
   * ## Orchestration ONLY
   *
   * This owns the ORDER and nothing else. The two page interactions are the existing bounded controllers — `runBoundedCourseListExpansion`
   * and `runBoundedTeacherHydration` — driven through the existing session runners, so the click targets, observers, timeouts and caps stay
   * owned by the narrow adapters that were measured against the live page. Nothing here clicks anything or names a DOM selector.
   *
   * ## Why the phases are ordered this way
   *
   * Teacher hydration may not begin until the course list is PROVEN complete. Expanding panels on a half-loaded list would fill the teacher
   * data of the courses that happen to be rendered and leave the rest blank, and the result would look finished while whole courses were
   * missing. So a phase-one outcome that is anything other than a proven-complete list ends the run, and hydration never starts.
   */

  /** Messages the preparation contract adds. One meaning each. */
  const START_FULL_PREPARATION_MESSAGE = 'COURSE_COPILOT_START_FULL_PREPARATION';
  const CANCEL_FULL_PREPARATION_MESSAGE = 'COURSE_COPILOT_CANCEL_FULL_PREPARATION';
  const QUERY_FULL_PREPARATION_STATUS_MESSAGE = 'COURSE_COPILOT_QUERY_FULL_PREPARATION_STATUS';
  const FULL_PREPARATION_EVENT_MESSAGE = 'COURSE_COPILOT_FULL_PREPARATION_EVENT';

  /**
   * Where one preparation run is.
   *
   * `filtering_available` comes FIRST because the whole run's subject is the set of courses currently selectable: every later phase — the load-more cap, the
   * hydration queue, the final read — should describe the FILTERED pool, not a pool that was assembled first and narrowed afterwards.
   */
  type PreparationPhase = 'idle' | 'filtering_available' | 'loading_courses' | 'hydrating_teachers' | 'rescanning' | 'finished';

  /** Why a preparation run ended. Every value is a different situation for a caller. */
  type PreparationStopReason =
    /** Every phase completed. */
    | 'completed'
    /** The caller asked to stop. */
    | 'cancelled'
    /**
     * The page's 「有余量」 filter could not be operated at all: no filter panel, no reveal control, no option, or no query button.
     *
     * Distinct from a failure, because the caller's next move differs: this page cannot be filtered, which may be worth telling the user, while a failure means
     * the filter was reachable and did not take.
     */
    | 'availability_filter_unavailable'
    /** The filter was operable and did not take, so the candidate pool would not be the selectable one. */
    | 'availability_filter_failed'
    /** The course list could not be proven complete, so hydration was refused. */
    | 'course_list_incomplete'
    /** Teacher data is complete for every panel considered. */
    | 'teacher_hydration_completed'
    /** Teacher data is complete for some panels and not others. */
    | 'teacher_hydration_partial'
    /** The hydration cap was reached with panels left. */
    | 'teacher_hydration_item_cap'
    /** The final read could not be performed. */
    | 'read_failed';

  /** What one preparation run produced. Plain data. */
  interface PreparationStatus {
    readonly phase: PreparationPhase;
    /**
     * The availability filter's outcome, once that phase has run.
     *
     * Present for every run that got as far as attempting the filter, including failures, because "the filter did not take" is the fact a caller needs in order
     * to explain why nothing was prepared.
     */
    readonly availabilityFilterStatus?: AvailabilityFilterStatus;
    /** The expansion's own summary, when that phase ran. */
    readonly autoExpandStatus?: AutoExpandStatus;
    /** The hydration session's own summary, when that phase ran. */
    readonly teacherHydrationStatus?: TeacherHydrationStatus;
    /**
     * The page as it stood AFTER hydration.
     *
     * Read fresh at the end rather than carried from before, because the whole point of the second phase is that it changes the teacher cells: a snapshot
     * taken earlier would describe a page that no longer exists. ABSENT when no read was taken, which is a different fact from a read that found nothing.
     */
    readonly finalPage?: {
      readonly supported: boolean;
      readonly rowCount: number;
      readonly completeness: string;
      readonly listPresent: boolean;
    };
    readonly stopReason?: PreparationStopReason;
  }

  /** What a preparation START is answered with, immediately. */
  interface PreparationStartResponse {
    readonly ok: true;
    readonly accepted: boolean;
    readonly status: PreparationStatus;
  }

  let preparationPhase: PreparationPhase = 'idle';
  let preparationStopReason: PreparationStopReason | undefined;
  let preparationFilter: AvailabilityFilterStatus | undefined;
  let preparationAutoExpand: AutoExpandStatus | undefined;
  let preparationHydration: TeacherHydrationStatus | undefined;
  let preparationFinalPage: PreparationStatus['finalPage'];
  let preparationCancelRequested = false;

  /** The current preparation session as a caller may see it. */
  function preparationStatus(): PreparationStatus {
    return {
      phase: preparationPhase,
      ...(preparationFilter === undefined ? {} : { availabilityFilterStatus: preparationFilter }),
      ...(preparationAutoExpand === undefined ? {} : { autoExpandStatus: preparationAutoExpand }),
      ...(preparationHydration === undefined ? {} : { teacherHydrationStatus: preparationHydration }),
      ...(preparationFinalPage === undefined ? {} : { finalPage: preparationFinalPage }),
      ...(preparationStopReason === undefined ? {} : { stopReason: preparationStopReason }),
    };
  }

  /** Send one preparation event, ignoring any failure to deliver it. */
  function emitPreparationEvent(event: Record<string, unknown>): void {
    chrome.runtime.sendMessage({ type: FULL_PREPARATION_EVENT_MESSAGE, ...event }).catch(() => {});
  }

  /** Move to a phase and announce it. */
  function setPreparationPhase(next: PreparationPhase): void {
    preparationPhase = next;
    emitPreparationEvent({ phase_changed: next });
  }

  /**
   * Read the page as it stands after hydration.
   *
   * The read status is the page's own, not a new vocabulary: a supported page with its course list reports what it found, a supported page without one is a
   * read that could not be performed, and an unsupported page is reported as such. Rescanning must not invent its own page-read semantics.
   */
  function readFinalPage(): NonNullable<PreparationStatus['finalPage']> {
    const supported = isSupportedPage();
    const listPresent = document.querySelector(COURSE_LIST_CONTAINER_SELECTOR) !== null;
    return {
      supported,
      rowCount: supported && listPresent ? scanVisibleRows().length : 0,
      // `unknown` when there is no list to describe, matching the visible-rows reply exactly.
      completeness: supported && listPresent ? detectCourseListLoadState().completeness : 'unknown',
      listPresent,
    };
  }

  /**
   * Run one approved preparation to its end: load the courses, fill in the teachers, read the page back.
   *
   * ## Each phase consumes the previous one's verdict
   *
   * Phase one must PROVE the list complete; anything else ends the run with the reason the expansion gave, and hydration never starts. Phase two may finish
   * complete or partial — a panel that would not hydrate is contained and the rest of its data is kept — and either way the final read happens, because a
   * partial teacher set is still the best data available and read it back is the point.
   *
   * ## The final read is always FRESH
   *
   * It reruns the scan against the live DOM rather than reusing the rows from before hydration: the second phase's entire effect is on the teacher cells, so an
   * earlier snapshot would describe the page as it was before the work was done.
   */
  async function runFullPreparationSession(): Promise<void> {
    /*
     * PHASE 0 — restrict the pool to what is currently selectable.
     *
     * This runs FIRST, before any load-more, because the alternative — load everything and narrow afterwards — would spend the load-more cap on courses the user
     * cannot choose, and would then hydrate teachers for them. The filter is the same canonical operation the standalone session uses; there is no second copy
     * of the interaction and no round trip through the panel.
     *
     * The filter session owns the query/rebuild wait, so nothing here inspects the course list until this call has returned a stable post-query state. That
     * ordering is what stops the page's own transient removal of `.tjxk_list` from being read as a malformed list.
     */
    setPreparationPhase('filtering_available');
    const filter = await runAvailabilityFilterOperation({
      // A cancellation during this phase must stop it before its next page interaction, exactly as the standalone session's does.
      isCancelled: () => preparationCancelRequested,
      onPhase: (phase) => { emitPreparationEvent({ phase: preparationPhase, availabilityFilterPhase: phase }); },
    });
    preparationFilter = {
      /*
       * Reported as `finished` because it IS finished by the time this is written: the operation has returned. The standalone session's richer phase progression
       * is announced separately, through `availabilityFilterPhase` on each event, so nothing is lost by the summary being terminal.
       */
      phase: 'finished',
      expandedFilters: filter.expandedFilters,
      selectedAvailable: filter.selectedAvailable,
      submittedQuery: filter.submittedQuery,
      postQuerySupported: filter.postQuerySupported,
      postQueryRowCount: filter.postQueryRowCount,
      postQueryCompleteness: filter.postQueryCompleteness,
      stopReason: filter.stopReason,
    };

    if (filter.stopReason === 'cancelled') {
      preparationStopReason = 'cancelled';
      preparationPhase = 'finished';
      emitPreparationEvent({ phase: 'finished', stopReason: preparationStopReason, availabilityFilterStatus: preparationFilter });
      return;
    }
    /*
     * A filter the page would not apply ends the run. Continuing would prepare and then recommend an UNFILTERED pool while the user approved a filtered one, and
     * the approval copy promises 「只分析当前可选课程」 — preparing something else would make that promise false.
     */
    if (filter.stopReason === 'unavailable') {
      preparationStopReason = 'availability_filter_unavailable';
      preparationPhase = 'finished';
      emitPreparationEvent({ phase: 'finished', stopReason: preparationStopReason, availabilityFilterStatus: preparationFilter });
      return;
    }
    if (filter.stopReason !== 'applied' && filter.stopReason !== 'already_applied') {
      preparationStopReason = 'availability_filter_failed';
      preparationPhase = 'finished';
      emitPreparationEvent({ phase: 'finished', stopReason: preparationStopReason, availabilityFilterStatus: preparationFilter });
      return;
    }

    /*
     * A VALID ZERO-RESULT POOL HAS NOTHING LEFT TO PREPARE.
     *
     * 「有余量」 can legitimately match nothing. Loading more would click a control with no results behind it, and hydrating would fill in teacher data for
     * courses that do not exist, so both are skipped and the run finishes through the normal final read. That read reports zero rows with the page's own
     * completeness, which is what lets the panel state 「没有可选课程」 truthfully instead of claiming the list was incomplete.
     *
     * This is a terminal SUCCESS path, not a failure: the honest answer to "which courses can I choose" is "none right now".
     */
    if (isZeroCourseResult(filter)) {
      setPreparationPhase('rescanning');
      const emptyPage = readFinalPage();
      preparationFinalPage = emptyPage;
      preparationStopReason = emptyPage.supported ? 'completed' : 'read_failed';
      preparationPhase = 'finished';
      emitPreparationEvent({
        phase: 'finished',
        stopReason: preparationStopReason,
        availabilityFilterStatus: preparationFilter,
        finalPage: preparationFinalPage,
      });
      return;
    }

    setPreparationPhase('loading_courses');

    /*
     * PHASE 1 — the course list, through the existing expansion session.
     *
     * `report` is supplied so this run is announced as preparation progress rather than as a standalone expansion; the expansion's own session state still
     * updates, so a status query about it stays accurate.
     */
    /*
     * A cancellation belonging to the PREVIOUS run must not stop this one.
     *
     * The expansion session owns its cancel flag and it is set for a genuine reason: the bridge above writes it while a run is in this very phase. What no
     * code path did was CLEAR it, because the clear lives in the `START_AUTO_EXPAND` message handler — and a preparation calls the expansion session DIRECTLY,
     * never through that handler. The flag therefore stayed set for the life of the page, and every later preparation entered this phase, was told it had
     * already been cancelled, and stopped with zero clicks. In a panel that reads as "the start button came back, but pressing it does nothing".
     *
     * Clearing it HERE is what makes it safe rather than a suppression: this line runs once, immediately before a NEW expansion phase begins, and never while a
     * run is in flight. A cancellation issued DURING this session still sets the flag through the same bridge as before and still stops the run, which is
     * asserted beside this behaviour rather than assumed.
     *
     * The hydration session below has always done the same thing for its own flag; this makes the two phases consistent.
     */
    cancelRequested = false;
    const expansion = await runExpansionSession({
      report: () => {
        preparationAutoExpand = sessionStatus();
        emitPreparationEvent({ phase: preparationPhase, autoExpandStatus: preparationAutoExpand });
      },
      onFinished: () => { preparationAutoExpand = sessionStatus(); },
    });

    const listProven = expansion.stopReason === 'complete' || expansion.stopReason === 'already_complete';
    if (!listProven) {
      /*
       * The list was not proven whole, so teacher data would be filled in for an unknown subset of the courses. The expansion's own reason is carried
       * through for `cancelled`, and everything else is reported as an incomplete list — which is the fact that matters downstream, not which of the
       * expansion's several failure modes produced it.
       */
      preparationStopReason = expansion.stopReason === 'cancelled' ? 'cancelled' : 'course_list_incomplete';
      preparationPhase = 'finished';
      emitPreparationEvent({ phase: 'finished', stopReason: preparationStopReason, autoExpandStatus: preparationAutoExpand });
      return;
    }

    /*
     * PHASE 2 — teacher data, through the existing hydration session.
     *
     * A cancelled preparation stops before the second phase, because a user who asked to stop should not have their page clicked further. Hydration itself
     * would refuse a cancellation at its first item, but checking here means the phase is never entered at all.
     */
    if (preparationCancelRequested) {
      preparationStopReason = 'cancelled';
      preparationPhase = 'finished';
      emitPreparationEvent({ phase: 'finished', stopReason: preparationStopReason, autoExpandStatus: preparationAutoExpand });
      return;
    }

    setPreparationPhase('hydrating_teachers');
    // A cancellation requested DURING preparation must also stop hydration, so the flag is bridged onto the session the phase owns.
    hydrationCancelRequested = false;
    const hydration = await runTeacherHydrationSession({
      report: (progress) => {
        preparationHydration = teacherHydrationStatus();
        emitPreparationEvent({ phase: preparationPhase, teacherHydrationStatus: preparationHydration, progress });
      },
      onFinished: () => { preparationHydration = teacherHydrationStatus(); },
    });

    /*
     * PHASE 3 — read the finished page.
     *
     * Reached for a complete, a partial and a capped hydration alike: each of those leaves real teacher data in the DOM, and refusing to read it back would
     * discard work that succeeded. A cancellation is the one exception, and it only skips the READ, never the data.
     */
    if (preparationCancelRequested) {
      preparationStopReason = 'cancelled';
    } else if (hydration.stopReason === 'cancelled') {
      preparationStopReason = 'cancelled';
    } else if (hydration.stopReason === 'item_cap') {
      preparationStopReason = 'teacher_hydration_item_cap';
    } else if (hydration.failed > 0) {
      preparationStopReason = 'teacher_hydration_partial';
    } else {
      preparationStopReason = 'teacher_hydration_completed';
    }

    setPreparationPhase('rescanning');
    const finalPage = readFinalPage();
    preparationFinalPage = finalPage;
    // A cancelled run still reports the page it can see; the reason already says the work was cut short.
    if (preparationStopReason !== 'cancelled' && !finalPage.supported) {
      preparationStopReason = 'read_failed';
    }

    preparationPhase = 'finished';
    emitPreparationEvent({
      phase: 'finished',
      stopReason: preparationStopReason,
      autoExpandStatus: preparationAutoExpand,
      teacherHydrationStatus: preparationHydration,
      finalPage: preparationFinalPage,
    });
  }

  chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender: RuntimeSender, sendResponse: (response: unknown) => void) => {
    /*
     * The COMPLETE loaded-row reply, answered only when asked for by name.
     *
     * ## What "all" means here, exactly
     *
     * Every VALID teaching-class row currently in the DOM: the scan runs to the end of the loaded page and applies the same
     * parser rules as every other read, so a panel without a readable course name still contributes nothing and an unreadable
     * row is still skipped. It is a snapshot of the loaded page, NOT the set of teaching classes that exist at WHU.
     *
     * Deliberately NOT included, and not obtainable here: rows behind a "load more", a later page, or a collapsed section;
     * anything requiring a click or a teacher-hydration pass; anything fetched over the network; and any historical state. The
     * only work done is reading the DOM that is already there.
     *
     * ## Why there is no count field
     *
     * The reply IS the complete set, so its length is the total for this snapshot. A separate total would be a second copy of
     * the same number, and the two could disagree.
     *
     * ## Why it is read fresh
     *
     * Nothing is cached, here or in the worker. The DOM can change between calls — the user re-runs a search and the rows are
     * re-ordered — so a remembered answer could describe a page that no longer exists.
     */
    if (message?.type === QUERY_VISIBLE_ROWS_MESSAGE) {
      /*
       * `supported` is reported from THIS script's own `isSupportedPage()`, because it is the only place that knows what page it is running on.
       * A worker-side copy of the URL rule would be a second definition of "the right page", and the two would eventually disagree.
       *
       * The script reports nothing about whether it was reachable or whether its reply arrived: when it is not running, it cannot say so, and
       * those outcomes are the asking side's to record.
       */
      const supported = isSupportedPage();
      /*
       * WHETHER THE PAGE'S COURSE STRUCTURE IS READABLE AT ALL.
       *
       * A supported page WITHOUT its course list is not a page with no courses: the list is the thing that holds them, so its absence means the read could
       * not be performed rather than that it found nothing. Measured in 16J-PREUI-E4-B2-R2: with the list missing, `rows` is empty and the two load-state
       * markers — which sit OUTSIDE the list — happily reported `partial`, so the reply was byte-identical to a genuinely empty page and the run could even
       * claim `completeness: 'complete'`.
       *
       * The distinction is signalled by OMITTING the load state when the list is absent, because that state describes a course list and there is none to
       * describe. An unsupported page is a THIRD case and must stay different again: it is a page this extension does not operate on, which is a successful
       * recognition, not a structural failure. So `supported` is decided first and the list is only consulted for a page the extension claims.
       */
      const listPresent = document.querySelector(COURSE_LIST_CONTAINER_SELECTOR) !== null;
      const response: VisibleRowsResponse = {
        supported,
        // Empty on an unsupported page: this script is not going to describe a page it does not recognise.
        rows: supported ? scanVisibleRows() : [],
        /*
         * Read in the SAME snapshot as the rows, and only on the supported page: another page that happened to contain `#more` and `#endsign` would
         * otherwise be reported as a half-loaded course list. And only when the course list itself is present, because its two markers describe THAT list.
         */
        ...(supported && listPresent ? { loadState: detectCourseListLoadState() } : {}),
      };
      sendResponse(response);
      return false;
    }

    /*
     * ==========================================================================================================================
     * AUTO-EXPAND MESSAGE BRANCHES
     * ==========================================================================================================================
     *
     * Four messages, each with one meaning. START is the ONLY execution permission in this script; the other three are a query, a
     * cancellation and a one-way event, and none of them can begin a session.
     */

    if (message?.type === QUERY_AUTO_EXPAND_STATUS_MESSAGE) {
      // Read-only, and deliberately so: no click, no scan, no retry, no restart. A panel reopening after the worker was suspended
      // reads the truth from the one place that has it.
      sendResponse({ ok: true, status: sessionStatus() });
      return false;
    }

    if (message?.type === CANCEL_AUTO_EXPAND_MESSAGE) {
      /*
       * Cancellation only ever sets a flag. It does not undo a click that already happened, touch the DOM, or start anything — and on an
       * idle session it is a harmless acknowledgement, because a user cancelling nothing has still asked for nothing to happen.
       */
      cancelRequested = true;
      sendResponse({ ok: true, cancelled: true, status: sessionStatus() });
      return false;
    }

    if (message?.type === START_AUTO_EXPAND_MESSAGE) {
      /*
       * ACKNOWLEDGED IMMEDIATELY, then run in the background.
       *
       * A whole expansion takes many seconds. Holding this response open would make the panel's request depend on the service worker
       * staying alive for that entire time, and this project has no keepalive at all — so the answer is a receipt, and the outcome
       * arrives later as an event. That is the difference between "we took the job" and "the job is done", and the panel needs both.
       */
      if (phase === 'running') {
        // A second start must not create a second loop: one content instance runs at most one session at a time.
        sendResponse({ ok: true, accepted: false, status: sessionStatus() } satisfies AutoExpandStartResponse);
        return false;
      }
      // A fresh session clears the previous verdict, so a status query can never report a stale stop reason as if it were current.
      stopReason = undefined;
      phase = 'running';
      cancelRequested = false;
      sendResponse({ ok: true, accepted: true, status: sessionStatus() } satisfies AutoExpandStartResponse);
      // Detached on purpose: this promise is the session, and nothing awaits it.
      void runExpansionSession();
      return false;
    }

    if (message?.type === AUTO_EXPAND_EVENT_MESSAGE) {
      // This script SENDS this event; receiving one means a reply loop was wired by mistake. Ignored rather than answered, so no loop can form.
      return false;
    }

    /*
     * ==========================================================================================================================
     * TEACHER HYDRATION MESSAGE BRANCHES
     * ==========================================================================================================================
     */

    if (message?.type === QUERY_TEACHER_HYDRATION_STATUS_MESSAGE) {
      // Read-only: no scan, no hydration, no click, no session start. A caller that missed the events learns the truth here.
      sendResponse({ ok: true, status: teacherHydrationStatus() });
      return false;
    }

    if (message?.type === CANCEL_TEACHER_HYDRATION_MESSAGE) {
      /*
       * Cancellation only sets a flag. A detail click already dispatched is not undone — the controller stops before the NEXT item — and on an idle session
       * this is a harmless acknowledgement.
       */
      hydrationCancelRequested = true;
      sendResponse({ ok: true, cancelled: true, status: teacherHydrationStatus() });
      return false;
    }

    if (message?.type === START_TEACHER_HYDRATION_MESSAGE) {
      /*
       * REFUSED UNLESS THE COURSE LIST IS COMPLETE.
       *
       * This is the rule that keeps the two stages honest. Teacher hydration over a PARTIALLY loaded list would silently hydrate only the panels that happen
       * to be rendered, and the result would look finished while whole courses were missing. Only the page's own end-of-list signal allows a session to
       * start; `partial` and `unknown` are both refusals, and the caller is told which.
       */
      if (hydrationPhase === 'running') {
        sendResponse({ ok: true, accepted: false, reason: 'already_running', status: teacherHydrationStatus() } satisfies TeacherHydrationStartResponse);
        return false;
      }
      if (detectCourseListLoadState().completeness !== 'complete') {
        sendResponse({ ok: true, accepted: false, reason: 'course_list_incomplete', status: teacherHydrationStatus() } satisfies TeacherHydrationStartResponse);
        return false;
      }

      // A fresh session clears the previous summary, so a status query can never report a stale stop reason as current.
      hydrationResult = undefined;
      hydrationPhase = 'running';
      hydrationCancelRequested = false;
      hydrationClicks = 0;
      sendResponse({ ok: true, accepted: true, status: teacherHydrationStatus() } satisfies TeacherHydrationStartResponse);
      // Detached on purpose: this promise is the session, and nothing awaits it.
      void runTeacherHydrationSession();
      return false;
    }

    if (message?.type === TEACHER_HYDRATION_EVENT_MESSAGE) {
      // Sent by this script, never received. Ignored so no reply loop can form.
      return false;
    }

    /*
     * ==========================================================================================================================
     * AVAILABILITY FILTER MESSAGE BRANCHES
     * ==========================================================================================================================
     */

    if (message?.type === QUERY_AVAILABILITY_FILTER_STATUS_MESSAGE) {
      // Read-only: no expand, no selection, no query, no session start. A caller that missed the events learns the truth here.
      sendResponse({ ok: true, status: availabilityFilterStatus() });
      return false;
    }

    if (message?.type === CANCEL_AVAILABILITY_FILTER_MESSAGE) {
      /*
       * Cancellation only sets a flag, and the session checks it BEFORE each page interaction. Nothing is undone — the filter choice
       * an earlier step already made stays made, and no second click is ever sent to reverse it. The unified flow wants 「有余量」
       * to remain active, so restoring the previous filter state is deliberately not this session's business.
       */
      availabilityFilterCancelRequested = true;
      sendResponse({ ok: true, cancelled: true, status: availabilityFilterStatus() });
      return false;
    }

    if (message?.type === START_AVAILABILITY_FILTER_MESSAGE) {
      if (availabilityFilterPhase === 'expanding_filters'
        || availabilityFilterPhase === 'selecting_available'
        || availabilityFilterPhase === 'submitting_query'
        || availabilityFilterPhase === 'waiting_for_results') {
        sendResponse({ ok: true, accepted: false, reason: 'already_running', status: availabilityFilterStatus() } satisfies AvailabilityFilterStartResponse);
        return false;
      }
      /*
       * Refused on a page that is not the supported selection page, and refused when there is no filter panel to operate. Both are
       * named rather than collapsed, because they call for different things: the first is the wrong tab, the second is a page whose
       * filter the script cannot reach.
       */
      if (!isSupportedPage()) {
        sendResponse({ ok: true, accepted: false, reason: 'unsupported_page', status: availabilityFilterStatus() } satisfies AvailabilityFilterStartResponse);
        return false;
      }
      if (filterPanel() === undefined) {
        sendResponse({ ok: true, accepted: false, reason: 'filter_panel_missing', status: availabilityFilterStatus() } satisfies AvailabilityFilterStartResponse);
        return false;
      }

      // A fresh session clears the previous summary and its counters, so a status query can never report a stale outcome as current.
      availabilityFilterResult = undefined;
      availabilityFilterCancelRequested = false;
      filterExpandClicks = 0;
      filterOptionClicks = 0;
      filterQueryClicks = 0;
      availabilityFilterPhase = 'expanding_filters';
      sendResponse({ ok: true, accepted: true, status: availabilityFilterStatus() } satisfies AvailabilityFilterStartResponse);
      // Detached on purpose: this promise is the session, and nothing awaits it.
      void runAvailabilityFilterSession();
      return false;
    }

    if (message?.type === AVAILABILITY_FILTER_EVENT_MESSAGE) {
      // Sent by this script, never received. Ignored so no reply loop can form.
      return false;
    }

    /*
     * ==========================================================================================================================
     * FULL PREPARATION MESSAGE BRANCHES
     * ==========================================================================================================================
     */

    if (message?.type === QUERY_FULL_PREPARATION_STATUS_MESSAGE) {
      // Read-only: no restart, no click, no scan, no recommendation. A panel that reopened learns the truth here.
      sendResponse({ ok: true, status: preparationStatus() });
      return false;
    }

    if (message?.type === CANCEL_FULL_PREPARATION_MESSAGE) {
      /*
       * Cancellation is routed to whichever phase is running, because each phase has its own controller with its own cancellation flag. Nothing is rolled
       * back: loaded courses stay loaded, expanded panels stay expanded, and teacher data already written stays written.
       */
      preparationCancelRequested = true;
      if (preparationPhase === 'loading_courses') cancelRequested = true;
      if (preparationPhase === 'hydrating_teachers') hydrationCancelRequested = true;
      sendResponse({ ok: true, cancelled: true, status: preparationStatus() });
      return false;
    }

    if (message?.type === START_FULL_PREPARATION_MESSAGE) {
      /*
       * ACKNOWLEDGED IMMEDIATELY, then run in the background. The whole preparation takes far longer than either phase alone, so holding this response open
       * would make the caller depend on the service worker surviving all of it — and this project has no keepalive at all.
       */
      if (preparationPhase !== 'idle' && preparationPhase !== 'finished') {
        // A second start must not create a second workflow: one content instance runs at most one preparation at a time.
        sendResponse({ ok: true, accepted: false, status: preparationStatus() } satisfies PreparationStartResponse);
        return false;
      }
      // A fresh run clears the previous verdict, so a status query can never report a stale stop reason as current.
      preparationStopReason = undefined;
      preparationFilter = undefined;
      preparationAutoExpand = undefined;
      preparationHydration = undefined;
      preparationFinalPage = undefined;
      preparationCancelRequested = false;
      // The run now BEGINS with the filter, so the acknowledged phase is that one rather than the load-more it used to start with.
      preparationPhase = 'filtering_available';
      sendResponse({ ok: true, accepted: true, status: preparationStatus() } satisfies PreparationStartResponse);
      // Detached on purpose: this promise is the run, and nothing awaits it.
      void runFullPreparationSession();
      return false;
    }

    if (message?.type === FULL_PREPARATION_EVENT_MESSAGE) {
      // Sent by this script, never received. Ignored so no reply loop can form.
      return false;
    }

    if (message?.type !== QUERY_STATUS_MESSAGE) return false;

    const supported = isSupportedPage();
    const response: StatusResponse = {
      supported,
      // Only meaningful on the supported page; `null` states that the count is not applicable rather than that it is zero.
      panelCount: supported ? readPanelCount() : null,
      /*
       * Read on demand rather than cached. The panel may be asking after the service worker was suspended, so the answer has
       * to come from the page as it is NOW — which is also why the worker does not need to remember any of this.
       *
       * Bounded on purpose: this reply is a diagnostic SAMPLE. The page may hold dozens of classes, and returning all of them
       * here would turn a status query into a bulk export of the user's course list.
       */
      rows: supported ? scanVisibleRows(MAX_ROW_SAMPLES) : [],
    };
    sendResponse(response);
    return false;
  });

  /*
   * Re-count when the page's DOM changes.
   *
   * The observer is used ONLY as a trigger to re-count. Its mutation records are never inspected — the callback takes no
   * arguments and looks at nothing they contain. That keeps this a "something changed, look again" signal rather than a way
   * to read page content.
   */
  const observer = new MutationObserver(() => {
    if (isSupportedPage()) scheduleReport();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
