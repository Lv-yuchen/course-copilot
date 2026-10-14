/**
 * Course Copilot side panel — page identity and panel count.
 *
 * The panel renders two facts: whether the supported WHU page was identified, and how many course-panel containers were
 * found. It shows no course name, teacher, credit, review, recommendation, preference or seat information, because none of it
 * is read anywhere.
 *
 * A count of 0 is displayed as 0. It is not explained as a broken page, a failed selector or an absence of courses — this
 * step reports the number and nothing else.
 *
 * ## Why everything is wrapped in a function
 *
 * This file carries no module syntax, which makes it a SCRIPT, and scripts share one global scope — so its top-level `const`
 * declarations would collide with identically named ones in the content script and the service worker. The wrapper keeps
 * every binding local, so no name has to be coordinated across the three files.
 *
 * (Unlike the content script, this page is loaded through `sidepanel.html` and could legitimately use
 * `<script type="module">` later. The wrapper is about scope isolation here, not about a restriction.)
 */

import {
  createFullPreparationController,
  finalPageText,
  preparationProgressText,
  PREPARATION_EVENT_MESSAGE,
  type PreparationView,
} from './full-preparation.js';
import { createRecommendationRequestController, type RecommendationRequestState } from './recommendation-request.js';
import { preparationReportTabIdOf } from './preparation-report-tab.js';
import {
  createRecommendationHandoff,
  recommendationIdleView,
  recommendationResultView,
  RECOMMENDATION_LABELS,
  type RecommendationResultView,
} from './recommendation-result.js';
import { renderCourseCards, setRatedCollapsed } from './course-cards.js';
import {
  PREFERENCE_CONTROLS,
  PREFERENCE_MAX,
  PREFERENCE_PROBLEM_TEXT,
  defaultPreferenceValues,
  preferencePayloadOf,
  preferencePercentagesOf,
  preferenceProblemOf,
} from './preferences.js';

(() => {
  const SUPPORTED_TEXT = '已识别 WHU 自主选课页面';
  const UNSUPPORTED_TEXT = '当前未检测到支持的 WHU 自主选课页面';

  /** The message names this panel listens for and sends. */
  const PAGE_STATUS_MESSAGE = 'COURSE_COPILOT_PAGE_STATUS';
  const PANEL_COUNT_MESSAGE = 'COURSE_COPILOT_PANEL_COUNT';
  const PING_MESSAGE = 'COURSE_COPILOT_PING';

const STATUS_ELEMENT_ID = 'page-status';
  /*
   * PRE-RELEASE-UX-A14 removed the three element ids that used to sit here, along with the section they addressed. The panel no longer looks for them, so a build
   * that somehow still carried the markup would show it unmanaged rather than silently half-wired.
   *
   * Their names are deliberately not repeated in this comment. Comments are source, and a check that scans this file for a removed id cannot tell an explanation from
   * a reintroduction — which is the point of the check.
   */
  const COUNT_ELEMENT_ID = 'panel-count';
  const VERSION_ELEMENT_ID = 'fact-version';

  /*
   * The preference editor's elements. The four ROW elements are not named here: their ids are derived from each control's key by one helper, so a
   * fifth dimension could not be added to the table without its markup being addressed consistently or not at all.
   */
  const PREFERENCES_PROBLEM_ELEMENT_ID = 'preferences-problem';
  const PREFERENCES_RESET_ELEMENT_ID = 'preferences-reset';
  const PREFERENCES_APPLY_ELEMENT_ID = 'preferences-apply';

  /** Shown when 更新推荐 is pressed before any recommendation exists, so there is no page the change could belong to. */
  const PREFERENCES_NO_TARGET_TEXT = '请先加载课程并生成一次推荐，再调整偏好。';

  /** The data-preparation control's elements, and the event that feeds it. */
  const PREP_START_ELEMENT_ID = 'full-preparation-start';
  const PREP_CANCEL_ELEMENT_ID = 'full-preparation-cancel';
  const PREP_MESSAGE_ELEMENT_ID = 'full-preparation-message';

  /** Update the visible status line. */
  function setStatus(supported: boolean): void {
    const element = document.getElementById(STATUS_ELEMENT_ID);
    if (element === null) {
      // Visible in the console rather than leaving the previous line on screen, which would read as a stale success.
      console.log('[Course Copilot] side panel 缺少 #page-status 元素');
      return;
    }
    element.textContent = supported ? SUPPORTED_TEXT : UNSUPPORTED_TEXT;
    element.classList.toggle('panel-status-supported', supported);

    /*
     * The count line is only meaningful once a page has been identified, so it is hidden otherwise rather than showing a
     * number for a page the extension does not support.
     */
    const countElement = document.getElementById(COUNT_ELEMENT_ID);
    if (countElement !== null) countElement.hidden = !supported;
  }

  /** Update the visible panel count. */
  function setPanelCount(count: number | null): void {
    const element = document.getElementById(COUNT_ELEMENT_ID);
    if (element === null) {
      console.log('[Course Copilot] side panel 缺少 #panel-count 元素');
      return;
    }

    if (count === null || typeof count !== 'number' || !Number.isFinite(count)) {
      /*
       * No count has been reported yet. Shown as "…" rather than 0: displaying 0 would assert that the page has no course
       * panels, which is a different statement from "the number is not known yet".
       */
      element.textContent = '检测到课程面板：…';
      return;
    }

    element.textContent = `检测到课程面板：${count}`;
  }

  /*
   * REMOVED IN PRE-RELEASE-UX-A14: the renderer that displayed up to three teaching-class identities as a development block.
   *
   * It was the ONLY consumer of the status reply's row samples, so the call site went with it. What that renderer did — parse a row into code · name · teacher, and
   * treat an absent teacher as missing page DATA rather than as a teacherless class — is still done, and tested, one layer down; the panel simply no longer displays
   * any of it. That wording rule remains a rule of the canonical model, not of this panel.
   *
   * The removed function's name is deliberately not written here: a source-level check asserts this file contains no trace of it, and comments are source.
   */

  const versionElement = document.getElementById(VERSION_ELEMENT_ID);
  if (versionElement === null) {
    console.log('[Course Copilot] side panel 缺少 #fact-version 元素');
  } else {
    /*
     * Read from the manifest the browser actually loaded, not from a constant: this line is meant to say which build is
     * running, and a value copied from source could only say what someone typed.
     */
    const manifest = chrome.runtime.getManifest();
    versionElement.textContent = manifest.version;
  }

  // Path 2: a report can arrive at any time while the panel is open.
  chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender: RuntimeSender) => {
    if (message?.type === PAGE_STATUS_MESSAGE) setStatus(message.supported === true);
    if (message?.type === PANEL_COUNT_MESSAGE) setPanelCount(typeof message.count === 'number' ? message.count : null);
    /*
     * Preparation events arrive here too, through the ONE listener this panel has.
     *
     * ## Which tab the report belongs to
     *
     * The worker relays these reports, so the browser's sender is the WORKER and `sender.tab` is absent — reading it alone would throw every report away as
     * foreign and leave the panel stuck in a running phase. The owning tab therefore comes from {@link preparationReportTabIdOf}, which prefers the
     * `sourceTabId` the worker stamped on with the ORIGINAL sender, and falls back to `sender.tab.id` for a report that arrives directly. Either way the
     * browser's record is preferred over a payload field that could say anything, and the controller still compares the result against the tab its operation
     * belongs to and ignores anything else.
     */
    if (message?.type === PREPARATION_EVENT_MESSAGE) {
      preparation.onEvent(preparationReportTabIdOf(message, sender?.tab?.id), message as Record<string, unknown>);
    }
    return false;
  });

  /**
   * Render the data-preparation control.
   *
   * The controller decides everything the user sees; this only puts it on screen. In particular each sentence is the controller's own, so the wording for every
   * phase and every stop reason is decided in one place and cannot drift between the two halves of this feature.
   */
  function renderPreparation(view: PreparationView): void {
    const start = document.getElementById(PREP_START_ELEMENT_ID);
    const cancel = document.getElementById(PREP_CANCEL_ELEMENT_ID);
    const message = document.getElementById(PREP_MESSAGE_ELEMENT_ID);
    if (start === null || cancel === null || message === null) {
      console.log('[Course Copilot] side panel 缺少数据准备元素');
      return;
    }
    start.hidden = !view.canStart;
    cancel.hidden = !view.canCancel;

    /*
     * Two lines can be true at once — "I am working" and "here is what has happened so far" — so the running states compose them. The phase line comes from the
     * controller module rather than being rebuilt here, so the wording lives in one place and the two halves of this feature cannot drift apart.
     *
     * The final-read fact is added only where a read actually happened, and it names teaching-class records rather than courses.
     */
    const lines: string[] = [];
    const progress = preparationProgressText(view.phase, view.clicks, view.hydration);
    if (progress !== null) lines.push(progress);
    else if (view.message !== null) lines.push(view.message);
    if (view.phase === 'finished') {
      const finalLine = finalPageText(view.finalRowCount === null ? undefined : { rowCount: view.finalRowCount });
      if (finalLine !== null) lines.push(finalLine);
    }
    message.textContent = lines.join(' ');
    message.hidden = lines.length === 0;

    /*
     * THE HANDOFF.
     *
     * A finished preparation that permits a recommendation asks for one, exactly once. This runs on every view update because a preparation reports its completion
     * more than once — a live event, a status read after a panel reopen, and possibly a duplicate — and the handoff's own dedupe flag is what makes the extra
     * reports harmless. The tab comes from the preparation's own record, never from a fresh query: re-reading the active tab here would aim the request at whichever
     * page is now in front.
     *
     * ## Why both objects are read through lazy accessors
     *
     * `createFullPreparationController` calls its `onView` sink ONCE DURING CONSTRUCTION, to publish the initial view. This function is that sink, so it runs
     * before either the controller or the handoff exists — and reaching for a `const` declared below threw
     * `ReferenceError: Cannot access 'handoff' before initialization`, which killed the whole side panel script during evaluation and left the button unwired.
     *
     * That was a REAL browser failure, not a theoretical one: it was found by clicking the shipped panel in Edge, where nothing happened at all. Reading through
     * accessors keeps the sink safe whatever the construction order is, which is the actual requirement — the sink has no business depending on the order in which
     * its collaborators are built.
     */
    deferredHandoff()?.consider(view.phase, view.stopReason, deferredPreparation()?.operationTabId() ?? null);
  }

  /**
   * The preparation controller, available only once it exists.
   *
   * A setter pair rather than a direct reference, because this module's initialisation order is forced: the controller must be constructed with the render sink,
   * and the sink must tolerate being called during that construction.
   */
  let preparationRef: ReturnType<typeof createFullPreparationController> | null = null;
  function deferredPreparation(): ReturnType<typeof createFullPreparationController> | null {
    return preparationRef;
  }
  let handoffRef: ReturnType<typeof createRecommendationHandoff> | null = null;
  function deferredHandoff(): ReturnType<typeof createRecommendationHandoff> | null {
    return handoffRef;
  }

  const preparation = createFullPreparationController({ onView: renderPreparation });
  preparationRef = preparation;

  /*
   * ============================================================================================================================
   * RECOMMENDATION RESULT AREA
   * ============================================================================================================================
   *
   * ONE instance of the hardened controller, and the handoff that decides when a finished preparation becomes a request. No transport is
   * written here: the request goes through the controller, which owns the expected-tab binding, the freshness rules and the stale outcome.
   *
   * The result area keeps its own state, separate from the preparation's. The two answer different questions — "is the page ready" and "what
   * did the ranking say" — and a preparation can finish while a recommendation goes stale.
   */

  const RECOMMENDATION_MESSAGE_ELEMENT_ID = 'recommendation-message';
  const RECOMMENDATION_TEACHER_NOTICE_ELEMENT_ID = 'recommendation-teacher-notice';
  const RECOMMENDATION_REVIEW_NOTICE_ELEMENT_ID = 'recommendation-review-notice';
  const RECOMMENDATION_COUNTS_ELEMENT_ID = 'recommendation-counts';
  const RECOMMENDATION_EMPTY_ELEMENT_ID = 'recommendation-empty';
  const RECOMMENDATION_SECTION_ELEMENT_ID = 'recommendation';

  /** Put one line on screen, or hide it when there is nothing to say. */
  function setLine(elementId: string, text: string | null): void {
    const element = document.getElementById(elementId);
    if (element === null) return;
    const hasText = text !== null && text.length > 0;
    element.textContent = hasText ? text : '';
    element.hidden = !hasText;
  }

  /**
   * The three card lists and their sections, resolved once.
   *
   * Resolved lazily through a function rather than captured at module load, because the panel script runs from the document's head-of-body position and a missing
   * element must be reported rather than silently produce a renderer that writes nowhere.
   */
  function cardTargets(): Parameters<typeof renderCourseCards>[0] | null {
    const recommended = document.getElementById('card-list-recommended');
    const rated = document.getElementById('card-list-rated');
    const insufficient = document.getElementById('card-list-insufficient');
    const recommendedSection = document.getElementById('cards-recommended');
    const ratedSection = document.getElementById('cards-rated');
    const insufficientSection = document.getElementById('cards-insufficient');
    /*
     * The SHARED grade disclaimer is resolved here too, and for the same reason: a panel that cannot find it must say so rather than render a result whose grade
     * figures carry no disclosure. It is the one element the renderer both writes and toggles.
     */
    const disclaimer = document.getElementById('grade-disclaimer');
    /*
     * The rated section's disclosure. A missing control would leave a hundred rated cards either permanently hidden with no way to open them, or permanently
     * expanded — the problem this slice exists to fix — so its absence is REPORTED rather than silently tolerated.
     */
    const ratedToggle = document.getElementById('rated-toggle');
    const ratedCount = document.getElementById('rated-count');
    const ratedCards = document.getElementById('rated-cards');
    if (recommended === null || rated === null || insufficient === null
      || recommendedSection === null || ratedSection === null || insufficientSection === null
      || disclaimer === null || ratedToggle === null || ratedCount === null || ratedCards === null) {
      console.log('[Course Copilot] side panel 缺少课程卡片元素');
      return null;
    }
    return {
      recommended,
      rated,
      insufficient,
      sections: { recommended: recommendedSection, rated: ratedSection, insufficient: insufficientSection },
      disclaimer,
      disclosure: { toggle: ratedToggle, count: ratedCount, panel: ratedCards },
    };
  }

  /**
   * Wire the rated section's toggle, ONCE per panel.
   *
   * The handler reads the current state off `aria-expanded` and asks for the opposite, so there is no second copy of "is it open?" to fall out of step. It only
   * names the state it wants; `setRatedCollapsed` owns the two assignments that render it.
   *
   * The control is a real `<button>`, so keyboard activation arrives here as a click and no key handling is needed. Nothing is attached inline, which the content
   * security policy forbids and which the skeleton gate checks for.
   */
  function wireRatedDisclosure(): void {
    const targets = cardTargets();
    if (targets === null || targets.disclosure === undefined) return;
    const { disclosure } = targets;
    disclosure.toggle.addEventListener('click', () => {
      const expanded = disclosure.toggle.getAttribute('aria-expanded') === 'true';
      // The opposite of whatever it currently is, read from the DOM rather than from a remembered flag.
      setRatedCollapsed({ toggle: disclosure.toggle, panel: disclosure.panel }, expanded);
    });
  }

  // Wired at load, so the control works before the first result arrives and after every later one.
  wireRatedDisclosure();

  /**
   * Render the result area and its cards.
   *
   * Every sentence comes from the controller module, so the wording for each page state, each review-source state and each kind of empty lives in one place. The
   * two PERSISTENT lines are rendered from their own fields rather than from the status line, because they stay on screen beside a summary: a partial preparation
   * does not become complete because a recommendation succeeded, and a partial review source keeps qualifying the numbers it produced.
   *
   * The CARDS are rendered only for a usable result. Every other state — loading, stale, an error, or a page that could not supply courses — clears them, because a
   * previous answer's cards sitting beside "正在生成…" would read as this run's result.
   */
  function renderRecommendation(view: RecommendationResultView, result: RecommendationResult | null): void {
    const section = document.getElementById(RECOMMENDATION_SECTION_ELEMENT_ID);
    if (section === null) {
      console.log('[Course Copilot] side panel 缺少推荐结果元素');
      return;
    }
    // Nothing has been asked for and there is nothing to disclose: the area stays out of the way entirely.
    const hasAnything = view.status !== 'idle'
      || view.pageNotice !== null
      || view.reviewNotice !== null
      || view.teacherNotice !== null
      || view.counts !== null
      || view.emptyNotice !== null;
    section.hidden = !hasAnything;

    setLine(RECOMMENDATION_MESSAGE_ELEMENT_ID, view.pageNotice ?? (view.message.length > 0 ? view.message : null));
    setLine(RECOMMENDATION_TEACHER_NOTICE_ELEMENT_ID, view.teacherNotice);
    setLine(RECOMMENDATION_REVIEW_NOTICE_ELEMENT_ID, view.reviewNotice);
    setLine(RECOMMENDATION_EMPTY_ELEMENT_ID, view.emptyNotice);

    const counts = document.getElementById(RECOMMENDATION_COUNTS_ELEMENT_ID);
    if (counts !== null) {
      counts.hidden = view.counts === null;
      if (view.counts !== null) {
        setCount('recommendation-count-recommended', RECOMMENDATION_LABELS.recommended, view.counts.recommended);
        setCount('recommendation-count-rated', RECOMMENDATION_LABELS.rated, view.counts.rated);
        setCount('recommendation-count-insufficient', RECOMMENDATION_LABELS.insufficient, view.counts.insufficient);
      }
    }

    /*
     * Cards only for a result the view actually summarised: a page notice means there is no ranking to show, so a card list would be describing a different run.
     */
    const targets = cardTargets();
    if (targets !== null) {
      renderCourseCards(targets, view.counts === null ? null : result);
    }
  }

  /** Write one count, keeping its label's wording in the controller module. */
  function setCount(elementId: string, label: string, value: number): void {
    const element = document.getElementById(elementId);
    if (element === null) return;
    // The label is looked up from the shared table so the rendered wording cannot drift from the tested one.
    element.textContent = String(value);
    element.setAttribute('data-label', label);
  }

  /*
   * The canonical result behind the current view, or `null`.
   *
   * Held so the cards can be re-rendered from the SAME state the summary was built from, and cleared on every state that is not a usable success — which is what
   * makes a loading or failed panel drop the previous answer's cards instead of leaving them on screen looking current.
   */
  let currentRecommendationResult: RecommendationResult | null = null;

  const recommendation = createRecommendationRequestController({
    sink: (state: RecommendationRequestState) => {
      // Only a success carries a result at all; every other state clears it, including `stale`, whose answer belongs to a page the user has left.
      currentRecommendationResult = state.status === 'success' ? state.result : null;
      renderRecommendation(recommendationResultView(state, preparation.view().stopReason), currentRecommendationResult);
    },
  });

  const handoff = createRecommendationHandoff({ request: (expectedTabId) => recommendation.request(expectedTabId) });
  handoffRef = handoff;

  /**
   * Read the four sliders as the panel currently holds them.
   *
   * Every value is read from the DOM rather than from a mirrored variable, so there is one copy of the user's choice — the control they actually moved —
   * and no second state that could fall out of step with what is on screen.
   */
  function readPreferenceValues(): Record<string, number> {
    const values: Record<string, number> = {};
    for (const { key } of PREFERENCE_CONTROLS) {
      const slider = document.getElementById(`preference-${key}`);
      // An unreadable slider is reported as a non-number, which the validator refuses; it is never silently defaulted.
      values[key] = slider === null ? Number.NaN : Number((slider as HTMLInputElement).value);
    }
    return values;
  }

  /**
   * Re-render the slider read-outs and the validity of the update action.
   *
   * The percentage and the `n/10` value are written from the same DOM read, so the two cannot describe different numbers. The update button is disabled
   * for an all-zero choice rather than left clickable: the refusal has to be visible BEFORE the click, not only after it.
   */
  function refreshPreferenceReadouts(): void {
    const values = readPreferenceValues();
    const percentages = preferencePercentagesOf(values);
    PREFERENCE_CONTROLS.forEach(({ key }, index) => {
      const value = values[key];
      const valueElement = document.getElementById(`preference-value-${key}`);
      if (valueElement !== null) valueElement.textContent = `${String(value)}/${PREFERENCE_MAX}`;
      const percentElement = document.getElementById(`preference-percent-${key}`);
      if (percentElement !== null) percentElement.textContent = `${percentages[index]}%`;
    });

    const problem = preferenceProblemOf(values);
    const problemElement = document.getElementById(PREFERENCES_PROBLEM_ELEMENT_ID);
    if (problemElement !== null) {
      // The sentence comes from the module's own table, so the wording cannot drift from the tested one.
      problemElement.textContent = problem === null ? '' : PREFERENCE_PROBLEM_TEXT[problem.code];
      problemElement.hidden = problem === null;
    }
    const apply = document.getElementById(PREFERENCES_APPLY_ELEMENT_ID);
    if (apply !== null) (apply as HTMLButtonElement).disabled = problem !== null;
  }

  /**
   * Wire the preference editor, ONCE per panel.
   *
   * ## What a weight change is allowed to do
   *
   * It re-ranks the page the current result describes: `recommendation.tabId()` is the tab that result belongs to, and passing it makes the request
   * `expectedTabId`-bound exactly as the preparation handoff is — so a weight change cannot migrate to another page and cannot read one.
   *
   * ## What it must never do
   *
   * It sends NO preparation message. The availability filter, the load-more clicks and the teacher-detail expansion are three separate START messages that
   * only the preparation button sends, so a re-rank cannot repeat any of them by construction. The read the worker performs
   * the visible-rows query message, which only queries and scans the DOM.
   *
   * ## Why the request is not sent from a slider's own `input` event
   *
   * Moving a slider fires continuously, so ranking on every event would send a run per pixel of travel. The user gets one explicit action instead, which
   * is also what makes "I changed my mind before running" expressible.
   */
  function wirePreferenceEditor(): void {
    for (const { key } of PREFERENCE_CONTROLS) {
      const slider = document.getElementById(`preference-${key}`);
      // `input` rather than `change`, so the percentage tracks the value while the user is still dragging it.
      if (slider !== null) slider.addEventListener('input', refreshPreferenceReadouts);
    }

    const reset = document.getElementById(PREFERENCES_RESET_ELEMENT_ID);
    if (reset !== null) {
      reset.addEventListener('click', () => {
        /*
         * The defaults are written to the DOM from the module's own table, so 恢复默认 restores exactly the shipped weighting rather than whatever the
         * markup happened to carry. Nothing else is touched: no request is sent, and the user still has to press 更新推荐.
         */
        const defaults = defaultPreferenceValues();
        for (const { key } of PREFERENCE_CONTROLS) {
          const slider = document.getElementById(`preference-${key}`);
          if (slider !== null) (slider as HTMLInputElement).value = String(defaults[key]);
        }
        refreshPreferenceReadouts();
      });
    }

    const apply = document.getElementById(PREFERENCES_APPLY_ELEMENT_ID);
    if (apply !== null) {
      apply.addEventListener('click', () => {
        const values = readPreferenceValues();
        // The same check that disabled the button. Re-run here so a disabled attribute is a courtesy, not the enforcement.
        if (preferenceProblemOf(values) !== null) {
          refreshPreferenceReadouts();
          return;
        }
        const targetTabId = recommendation.tabId();
        if (targetTabId === null) {
          // Nothing has been recommended yet, so there is no page this change belongs to. Refusing is the honest answer: falling back to the active tab
          // would rank a page the user never prepared and present it as the one they were looking at.
          const problemElement = document.getElementById(PREFERENCES_PROBLEM_ELEMENT_ID);
          if (problemElement !== null) {
            problemElement.textContent = PREFERENCES_NO_TARGET_TEXT;
            problemElement.hidden = false;
          }
          return;
        }
        void recommendation.request(targetTabId, preferencePayloadOf(values));
      });
    }

    // The initial read-out, so the percentages on screen are computed from the sliders rather than hard-coded in the markup.
    refreshPreferenceReadouts();
  }

  wirePreferenceEditor();

  /*
   * The initial render. The controller publishes only when something CHANGES, so a panel that opens onto an untouched result area would have no view to draw; this
   * draws the idle one, and it is the same view function the controller's own states go through, so the two cannot drift.
   */
  renderRecommendation(recommendationIdleView(preparation.view().stopReason, preparation.view().phase === 'finished'), null);

  document.getElementById(PREP_START_ELEMENT_ID)?.addEventListener('click', () => {
    /*
     * The click IS the approval. Nothing else in this panel calls `start`.
     *
     * The handoff flag is cleared FIRST, because this approval begins a new preparation whose completion is entitled to one recommendation request. Without this,
     * a second run in the same panel session would never ask.
     */
    handoff.reset();
    void preparation.start();
  });
  document.getElementById(PREP_CANCEL_ELEMENT_ID)?.addEventListener('click', () => {
    void preparation.cancel();
  });

  /**
   * Ask the worker about the tab this panel is looking at.
   *
   * The panel supplies the tab id because the WORKER cannot reliably know it: its record of reporting tabs lives in memory and
   * is lost when Manifest V3 suspends it, which is precisely the state this recovers from. The panel can obtain the id
   * without any extra permission — `chrome.tabs.query` does not require `"tabs"`, which governs the sensitive properties
   * (`url`, `title`) that are deliberately never read here.
   *
   * Reading only `id` is the whole point: no URL, no title, nothing about where the user is.
   */
  async function refreshFromActiveTab(): Promise<void> {
    let tabId: number | null = null;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const first = tabs[0];
      // Only `id` is read from the result. No other property of the tab is touched.
      if (first !== undefined && typeof first.id === 'number') tabId = first.id;
    } catch {
      /*
       * Query failed, so no tab can be named. Handled below exactly like "no active tab": the panel reports that it has not
       * detected the page rather than guessing.
       */
      tabId = null;
    }

    if (tabId === null) {
      setStatus(false);
      setPanelCount(null);
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({ type: PING_MESSAGE, tabId });
      /*
       * PRE-RELEASE-UX-A14 dropped `rows` from this shape. The status reply still CARRIES it — the content script's own contract is unchanged — but nothing in this
       * panel reads it any more, and an unused field in a decoded record is the kind of thing a later edit starts depending on again. The panel now takes exactly
       * what it renders: whether the page is supported, and how many course panels it holds.
       */
      const record = typeof response === 'object' && response !== null
        ? (response as { supported?: unknown; panelCount?: unknown })
        : {};
      setStatus(record.supported === true);
      setPanelCount(typeof record.panelCount === 'number' ? record.panelCount : null);
    } catch {
      /*
       * The worker was unreachable. The display stays on its initial "not detected" wording rather than claiming support, and
       * nothing is retried — a failure here is reported, not looped over.
       */
      setStatus(false);
      setPanelCount(null);
    }
  }

  void refreshFromActiveTab();

  /*
   * Recover whatever this tab is already doing.
   *
   * A panel can be closed and reopened, and the service worker can be suspended and restarted, so the events that described a run may never have reached
   * anyone. This read is how the panel learns the truth anyway — and it is a READ: a status reply of `idle` starts nothing.
   */
  void preparation.restore();

  console.log('[Course Copilot] side panel 已加载');
})();
