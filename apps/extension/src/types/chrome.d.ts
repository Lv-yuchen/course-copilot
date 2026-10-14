/**
 * The slice of the browser extension API this extension uses, plus the message shapes that cross extension boundaries.
 *
 * ## Why this file has NO imports and NO exports
 *
 * It used to be a module (`export interface …`), and both the service worker and the content script imported `RuntimeMessage`
 * from it. That had a consequence which broke the product: **a file with an import is a module, so TypeScript appended
 * `export {};` to the emitted JavaScript.** The generated `content/content-script.js` therefore ended with
 *
 *     export {};
 *
 * and Edge recorded `Uncaught SyntaxError: Unexpected token 'export'` at that line. Manifest V3 static content scripts are
 * loaded as classic scripts and cannot be ES modules — the manifest has no `type: "module"` for `content_scripts` — so the
 * whole script failed to parse and not one line ran: no page status was reported, the service worker was never woken, and the
 * side panel stayed on "not detected".
 *
 * Keeping this file ambient removes the CAUSE rather than the symptom: with no imports and no exports anywhere in the content
 * script's dependency graph, the compiler cannot emit module syntax for it. The service worker is unaffected — its manifest
 * entry declares `type: "module"`, so its own trailing `export {};` is legal there.
 *
 * Declared here rather than pulled from `@types/chrome` for two reasons: no new dependency is introduced, and the surface
 * available to the extension stays **explicit**. If a later step needs another part of the API, adding it here is a visible,
 * reviewable act rather than something that silently became available.
 *
 * Deliberately absent, because no step has needed them: `storage`, `scripting`, `cookies`, `webRequest`, `activeTab`, and
 * any page-injection surface. `tabs` is present only for `sendMessage` — the worker uses it to ask a content script it
 * already knows about to re-report. It never lists, queries or enumerates tabs, which is what would require the `tabs`
 * permission.
 */

/**
 * A message crossing an extension boundary.
 *
 * Deliberately narrow. Every field is a string, a boolean or a number, and there is no field a page URL, query string, hash, DOM
 * value, cookie, token or extra fetch option could travel in. `courseName` and `teacher` were added for the public-review lookup,
 * and they are the ONLY fields that message accepts: the worker reads no other key, so anything else a caller sends is ignored by
 * construction rather than filtered.
 */
interface RuntimeMessage {
  /** Which message this is. */
  type?: string;
  /** Page-identity result; present only on the page-status message. */
  supported?: boolean;
  /** Number of matching course-panel containers; present only on the panel-count message. */
  count?: number;
  /**
   * The four importance weights the user set, present only on a recommendation request.
   *
   * Declared on the message as well as on {@link QueryRecommendationsRequest} because the worker reads it off the message it received, and the two must not
   * be able to describe different fields. The type alias below is the one definition both use, so a fifth dimension cannot be added to one and forgotten in
   * the other.
   */
  preferences?: PreferenceWeightPayload;
  /**
   * The tab a ping is about; present only on the panel's ping.
   *
   * The panel supplies this because it — not the worker — knows which tab is active. The worker's own record of reporting
   * tabs lives in memory and is therefore lost when Manifest V3 suspends it, which is exactly the case this field exists to
   * recover from: without it, a restarted worker has no way to discover which tab to ask.
   */
  tabId?: number;
  /**
   * The content-script tab a relayed preparation report came from.
   *
   * Stamped on by the worker's relay, because re-broadcasting makes the worker the sender and the panel would otherwise have no way to attribute the report
   * to a page. Absent on the content script's own send and on every message that is not a relayed report.
   */
  sourceTabId?: number;
  /**
   * The course name to look up public reviews for; present only on the public-review query.
   *
   * A published COURSE NAME is the whole of what the public review site is searched with; it is not a page address, not a course id,
   * and nothing derived from the user's session.
   */
  courseName?: string;
  /**
   * An optional SINGLE teacher name, forwarded as the review site's teacher filter.
   *
   * Optional because a name-only query is a legitimate question, and a co-taught or unreadable teacher cell must leave this unset
   * rather than send a list: the filter is a substring match over a column holding one teacher per row, so a published list can
   * match nothing and the course silently loses all of its reviews.
   */
  teacher?: string;
  /*
   * Auto-expand fields, present only on {@link AutoExpandEvent}.
   *
   * Carried on this shape rather than in a separate union member because this file declares ONE message interface and the message types above reference
   * it. Each field below belongs to exactly one message, and an absent field is what says "not that message" rather than a default value.
   */
  /**
   * Which half of an auto-expand session this event reports: after each settled round, or once when it ends.
   *
   * The two are one message type because they carry the same facts at different moments; a caller distinguishes them by this field, and the value set is
   * closed.
   */
  phase?: 'progress' | 'finished';
  /**
   * How many load-more batches the session has requested.
   *
   * A count of BATCHES, never of courses: one click adds a batch whose size varies, so a course count cannot be derived from it and must not be
   * presented as one.
   */
  clicks?: number;
  /** The list's completeness as the page reported it, so a finished event can be read without a second query. */
  completeness?: 'partial' | 'complete' | 'unknown';
  /**
   * Why the session stopped. Present on `finished` only, because a session that is still running has not stopped.
   *
   * Every value is a different situation for the user — a whole list, a user stop, a page that stopped answering, a page that stopped growing, a hard
   * failure, a budget that ran out — so a caller must not collapse them into one message.
   */
  stopReason?: AutoExpandStatus['stopReason'];
  /*
   * Teacher-hydration fields, present only on {@link TeacherHydrationEvent} and the hydration status reply.
   *
   * Carried on this one interface for the same reason the auto-expand fields are: this file declares a single message shape that every message type
   * references. Each field belongs to exactly one message, and absence is what says "not that message".
   */
  /**
   * How many course panels this session may consider: the size of the snapshot taken when it started.
   *
   * A hydration pass works a FIXED list, so this never grows during a run. A panel that appears later belongs to a later pass.
   */
  queued?: number;
  /** How many were looked at, whether skipped or attempted. */
  considered?: number;
  /** How many were not skipped, which includes a panel whose completeness check could not be read. */
  attempted?: number;
  /** Panels whose teacher data is now complete. */
  hydrated?: number;
  /** Panels that were attempted and could not be brought to complete. */
  failed?: number;
  /** Panels that needed nothing, because every row already carried a teacher. These cost no click. */
  skipped?: number;
  /**
   * How many detail clicks were actually dispatched.
   *
   * Kept apart from {@link RuntimeMessage.attempted} on purpose: an unreadable panel is attempted and failed without ever being clicked, so the two
   * numbers answer different questions and neither can be derived from the other.
   */
  hydrationClicks?: number;
  /** Why a hydration session ended. Present on `finished` only. */
  hydrationStopReason?: 'completed' | 'cancelled' | 'item_cap';
  /*
   * Full-preparation fields, present only on the preparation status reply and its events.
   */
  /** Where the unified preparation run is: loading courses, hydrating teachers, rescanning, or done. */
  preparationPhase?: 'idle' | 'loading_courses' | 'hydrating_teachers' | 'rescanning' | 'finished';
  /** Why it ended. Present on the finished event only. */
  preparationStopReason?: 'completed' | 'cancelled' | 'course_list_incomplete' | 'teacher_hydration_completed' | 'teacher_hydration_partial' | 'teacher_hydration_item_cap' | 'read_failed';
  /** The page read back AFTER hydration, or absent when no read was taken. */
  preparationFinalPage?: {
    supported: boolean;
    rowCount: number;
    completeness: string;
    listPresent: boolean;
  };
}

/**
 * The four full-preparation messages.
 *
 * ## Why a preparation contract exists at all
 *
 * The two page interactions already have their own messages, and a caller could drive them in sequence. What it could not do is drive them in sequence
 * CORRECTLY: the rule that teacher hydration may not begin until the course list is proven complete lives in the ordering, and a caller that got it wrong would
 * expand the panels of a half-loaded list and end up with teacher data for an unknown subset of the courses. Putting the order in one approved message means
 * the rule is enforced by the runtime that owns both phases rather than by whoever happens to be calling.
 *
 * ## START is a receipt
 *
 * A preparation run is two bounded passes over the page and takes far longer than either alone, so the response is an acknowledgement carrying the state,
 * never the outcome. The outcome arrives as an event.
 */
type StartFullPreparationRequest = {
  type: 'COURSE_COPILOT_START_FULL_PREPARATION';
  tabId: number;
};

/**
 * Cancellation, routed to whichever phase is running.
 *
 * Nothing is rolled back: loaded courses stay loaded, expanded panels stay expanded, and teacher data already written stays written. The reason is that all
 * three are facts about the page rather than work in progress, and un-doing them would take the page further from what the user asked for.
 */
type CancelFullPreparationRequest = {
  type: 'COURSE_COPILOT_CANCEL_FULL_PREPARATION';
  tabId: number;
};

/** A read-only question about the current preparation run. */
type QueryFullPreparationStatusRequest = {
  type: 'COURSE_COPILOT_QUERY_FULL_PREPARATION_STATUS';
  tabId: number;
};

/**
 * The preparation run reporting itself.
 *
 * SENT BY THE CONTENT SCRIPT and relayed by the worker ONWARD to extension pages, never back to a tab: a worker branch that sent this to a tab would hand the
 * script its own report and form a loop, and the relay's source guard — a real content-script tab id is required — is what prevents that.
 *
 * ## Why `sourceTabId` travels on the message rather than being read from the sender
 *
 * The relay makes the worker the sender, so `sender.tab` is absent at the panel and the ORIGINAL page could no longer be identified. The worker therefore
 * stamps the tab it received the report from onto the payload, and the panel routes on that field.
 */
type FullPreparationEvent = {
  type: 'COURSE_COPILOT_FULL_PREPARATION_EVENT';
  /** The phase that just began, or `finished` for the closing event. */
  phase_changed?: string;
  /** The closing event's phase. */
  phase?: string;
  stopReason?: string;
  autoExpandStatus?: unknown;
  teacherHydrationStatus?: unknown;
  finalPage?: unknown;
  /** The content-script tab this report came from, stamped on by the worker's relay. Absent on the content script's own send. */
  sourceTabId?: number;
};

/**
 * The four teacher-hydration messages, each with exactly one meaning.
 *
 * ## Why a message per job
 *
 * As with the expansion contract, a single message carrying an action field would make "start" and "ask what happened" the same shape, and the one that
 * MUST NOT run anything would be told apart only by a string a caller could get wrong. Four types put the permission in the type system.
 *
 * ## START is a receipt, and it can be refused
 *
 * One session can touch a hundred panels, so the response is an acknowledgement carrying the state, never the outcome. And it is refused outright unless
 * the course list is COMPLETE: hydrating a partially loaded list would fill only the panels that happen to be rendered and then look finished.
 */
type StartTeacherHydrationRequest = {
  type: 'COURSE_COPILOT_START_TEACHER_HYDRATION';
  tabId: number;
};

/** Cancellation. It sets a flag; it never undoes a click, touches the DOM or starts anything. */
type CancelTeacherHydrationRequest = {
  type: 'COURSE_COPILOT_CANCEL_TEACHER_HYDRATION';
  tabId: number;
};

/** A read-only question about the current hydration session. */
type QueryTeacherHydrationStatusRequest = {
  type: 'COURSE_COPILOT_QUERY_TEACHER_HYDRATION_STATUS';
  tabId: number;
};

/**
 * The hydration session reporting itself.
 *
 * SENT BY THE CONTENT SCRIPT, never forwarded back to it: a worker branch that relayed this to a tab would be a loop, and there is deliberately none.
 */
type TeacherHydrationEvent = {
  type: 'COURSE_COPILOT_TEACHER_HYDRATION_EVENT';
  /** `progress` after each settled panel; `finished` exactly once, when the session ends. */
  phase: 'progress' | 'finished';
  queued: number;
  considered: number;
  hydrated: number;
  failed: number;
  skipped: number;
  hydrationClicks: number;
  /** Present on `finished` only. */
  stopReason?: 'completed' | 'cancelled' | 'item_cap';
};

/*
 * ============================================================================================================================
 * BOUNDED AVAILABILITY FILTER
 * ============================================================================================================================
 *
 * Operating WHU's own 「有无余量」 filter: expand the filter rows if they are collapsed, choose 「有」 if it is not already chosen,
 * then submit the page's query once. The behaviour was measured and run end to end in Steps 37a–37b.4; this is the port, not new
 * research.
 *
 * ## Four types, for the same reason the hydration session has four
 *
 * A caller could otherwise start a session to ask a question. Four types put the permission in the type system.
 *
 * ## The response is a receipt, and it can be refused
 *
 * A session clicks at most three page controls, so START answers with an acknowledgement carrying the staged state, never with the
 * finished result. Refusal reasons are named rather than collapsed into a boolean, because they call for different things: an
 * already-running session is a caller mistake, while a missing option is a page the script cannot operate.
 */

/** Begin one availability-filter session in a tab. */
type StartAvailabilityFilterRequest = {
  type: 'COURSE_COPILOT_START_AVAILABILITY_FILTER';
  tabId: number;
};

/** Cancellation. It sets a flag; it never undoes a click and never submits after being set. */
type CancelAvailabilityFilterRequest = {
  type: 'COURSE_COPILOT_CANCEL_AVAILABILITY_FILTER';
  tabId: number;
};

/** A read-only question about the current filter session. Starts nothing. */
type QueryAvailabilityFilterStatusRequest = {
  type: 'COURSE_COPILOT_QUERY_AVAILABILITY_FILTER_STATUS';
  tabId: number;
};

/** The filter session reporting itself. SENT BY THE CONTENT SCRIPT; never forwarded back to it. */
type AvailabilityFilterEvent = {
  type: 'COURSE_COPILOT_AVAILABILITY_FILTER_EVENT';
  phase: AvailabilityFilterPhase;
  expandedFilters: boolean;
  selectedAvailable: boolean;
  submittedQuery: boolean;
  postQuerySupported: boolean;
  postQueryRowCount: number | null;
  postQueryCompleteness: 'partial' | 'complete' | 'unknown' | null;
  stopReason: AvailabilityFilterStopReason;
};

/** Where one filter session is. Closed, so a caller cannot invent a phase. */
type AvailabilityFilterPhase =
  | 'idle'
  | 'expanding_filters'
  | 'selecting_available'
  | 'submitting_query'
  | 'waiting_for_results'
  | 'finished';

/**
 * Why a filter session ended.
 *
 * `already_applied` is a SUCCESS, not a refusal: 「有」 was already the page's chosen option, so the session had nothing to select
 * and went straight to the query. `cancelled` records that a caller stopped it and NO further page action was taken.
 */
type AvailabilityFilterStopReason =
  | 'applied'
  | 'already_applied'
  | 'cancelled'
  | 'unavailable'
  | 'failed';

/** The factual outcome of one availability-filter session. Counts and page facts only, never an interpretation. */
interface AvailabilityFilterStatus {
  phase: AvailabilityFilterPhase;
  /** Whether the filter rows had to be revealed. `false` means they were already showing. */
  expandedFilters: boolean;
  /** Whether this session chose 「有」. `false` when it was already chosen, which is the success case `already_applied`. */
  selectedAvailable: boolean;
  /** Whether the page's query was submitted. */
  submittedQuery: boolean;
  /** Whether the page still looked like the supported selection page after the rebuild. */
  postQuerySupported: boolean;
  /** Teaching-class rows readable after the rebuild; `null` when no list was readable. */
  postQueryRowCount: number | null;
  /** The rebuilt list's own completeness; `null` when no load state could be read. */
  postQueryCompleteness: 'partial' | 'complete' | 'unknown' | null;
  /** Present once the session has finished. */
  stopReason?: AvailabilityFilterStopReason;
}

/** Why a START was refused. Distinct causes, so a caller can tell them apart without parsing a sentence. */
type AvailabilityFilterStartRefusal =
  | 'already_running'
  | 'unsupported_page'
  | 'filter_panel_missing';

/** START's receipt: accepted with the staged state, or refused with a named reason. */
type AvailabilityFilterStartResponse =
  | { ok: true; accepted: true; status: AvailabilityFilterStatus }
  | { ok: true; accepted: false; reason: AvailabilityFilterStartRefusal; status: AvailabilityFilterStatus };

/**
 * One TEACHING-CLASS row read from the page.
 *
 * The name says "row" and not "course" because the fields live at two different levels on the real page, and conflating
 * them loses information: the course code, name and credits belong to the PANEL (one per course), while the teacher and the
 * remaining-seat count belong to the teaching-class ROW (one per class). A course with two classes therefore produces two
 * rows with the same code, name and credits but different teachers AND different seat counts — which is correct, and is why
 * these samples are not de-duplicated.
 *
 * There is no field a capacity, a title, a remark, raw heading text, HTML or a URL could travel in. TWO seat numbers are
 * granted, each read from its own leaf cell: the remaining-seat count (`font.blzyl`) and this-round-selected count
 * (`font.blyxrs`). CAPACITY is still not granted — the shared cell that holds all three is never read, so the third number
 * cannot arrive as a side effect of the two that were authorised.
 */
interface RowIdentity {
  /** The course code, when the panel published one. */
  courseCode?: string;
  /** The course name. Always present: a panel without a readable name produces no rows at all. */
  courseName: string;
  /**
   * The course's credits, when the heading stated them.
   *
   * A PANEL-level fact read from the heading, so every teaching-class row of the same course carries the same value. That
   * is the baseline's scope rather than an accident of this port. ABSENT means the heading stated no credits: never `0`,
   * never `NaN`, and never a placeholder, because a course with unstated credits is not a course worth zero.
   */
  credits?: number;
  /**
   * Seats left in THIS teaching class, when the page states them.
   *
   * A ROW-level fact, so two classes of one course may disagree — one full while the other still has places. `0` is a real
   * answer meaning "no seats left" and is carried as `0`; ABSENT means only that the page did not state a number, which must
   * never be shown as "full". A negative or unparseable value is omitted rather than clamped.
   */
  remainingSeats?: number;
  /**
   * How many students had already signed up for THIS teaching class in the current round, when the page states it.
   *
   * The page's own label is 「本轮已选」 and its definition is 「本轮次已选人数」 — NOT the course's total enrolment and NOT
   * capacity. A ROW-level fact, so two classes of one course carry their own counts.
   *
   * `0` is a REAL answer — nobody has signed up yet — and is carried as `0`. This is the opposite of the legacy capacity
   * placeholder rule, where a `0` meant "this row has not loaded yet" and had to be discarded; selected-this-round has no
   * such placeholder, so `0` is never omitted. ABSENT means only that the page did not state a number.
   */
  selectedThisRound?: number;
  /**
   * The teacher(s) of this teaching-class, when the page has published them.
   *
   * ABSENT means the page has not filled the cell — which the product must not read as "this course has no teacher". A
   * multi-teacher cell is kept as ONE string, exactly as the baseline reader keeps it.
   */
  teacher?: string;
}

/**
 * A content script's answer to a status query.
 *
 * `rows` carries at most three teaching-class rows, which is a deliberate cap rather than a page limit — the page may hold
 * dozens, and sending all of them would make this message a bulk export of the user's course list for no diagnostic benefit.
 */
interface StatusResponse {
  /** Whether the tab is the supported selection page. */
  supported: boolean;
  /** The course-panel count, or `null` when the tab is not a supported page. */
  panelCount: number | null;
  /** Up to three teaching-class rows, in document order. Empty when the tab is not a supported page. */
  rows: RowIdentity[];
}

/**
 * What the page itself says about whether its course list is fully loaded.
 *
 * ## Why both facts per node, and not just a verdict
 *
 * Measured on the live selection page: BOTH nodes exist in BOTH states, and only their visibility changes. So `present` alone decides nothing — a
 * finished list still holds a hidden `点此查看更多` anchor — and "the node is gone" has to stay distinguishable from "the node is there but
 * hidden". The two are reported separately and the verdict is derived from them, so a caller that needs to explain a state can say which fact it
 * came from.
 *
 * ## The frozen rule
 *
 * `partial` when BOTH markers are present, the load-more control is shown and the end sign is not; `complete` when both are present and the reverse
 * holds; `unknown` for everything else, including either marker missing.
 *
 * Presence is a precondition and not just a reported fact. A HIDDEN `#more` means the list is finished — that is what the live page does — while a
 * MISSING `#more` means the page is not shaped the way this rule was measured to work, so the honest verdict is `unknown`. Collapsing the two would
 * let "the marker is gone" silently read as "the marker says we are done".
 *
 * Nothing else feeds the verdict: not row counts (one course panel can carry many teaching-class rows), not panel counts, and not any visible text.
 */
type CourseListLoadState = {
  /** Whether the load-more container is in the DOM at all. */
  morePresent: boolean;
  /** Whether it is actually shown. A finished list keeps it hidden rather than removing it. */
  moreVisible: boolean;
  /** Whether the end-of-list sign is in the DOM at all. */
  endSignPresent: boolean;
  /** Whether it is actually shown. */
  endSignVisible: boolean;
  /** The derived verdict; the only field a caller normally needs. */
  completeness: 'partial' | 'complete' | 'unknown';
};

/**
 * A content script's answer to a full visible-row query.
 *
 * ## Exactly what this is
 *
 * A snapshot of every VALID teaching-class row currently loaded in the DOM, in document order, using the same
 * {@link RowIdentity} fields and the same parser as the bounded status sample. Because the set is complete for this snapshot,
 * `rows.length` IS the total — a separate count field would be a second copy of the same number, and the two could disagree.
 *
 * ## What it is NOT, and must never be read as
 *
 * It does NOT mean "all teaching classes that exist on WHU". Rows are obtained by reading the page that is already there, so
 * anything not currently rendered is absent: a row behind "load more", a later results page, a collapsed section, a
 * teacher-hydration pass, anything needing a network fetch, and any historical state. It is also not a live subscription — each
 * answer describes the DOM as it was at the moment of the query, and nothing about it is cached.
 *
 * ## Which rows are excluded
 *
 * "All" means all READABLE rows, not all `tr.body_tr` elements unconditionally. A panel without a readable course name
 * contributes nothing, exactly as it does for every other read, so the full query can never be used to smuggle in a row the
 * parser refused.
 */
interface VisibleRowsResponse {
  /**
   * Whether the tab is the supported selection page, as the CONTENT SCRIPT decided it.
   *
   * Reported by the script rather than inferred by the worker, because only the page's own context knows what page it is: the worker would have
   * to re-implement the URL rule, and two copies of "is this the right page" would eventually disagree. This is the content script's OWN fact —
   * it cannot report a missing script or a transport failure, because it does not run in those cases.
   */
  supported: boolean;
  /** Every valid teaching-class row currently loaded. Empty when the tab is not a supported page. */
  rows: RowIdentity[];
  /**
   * The page's own completeness signal, read in the SAME snapshot as the rows.
   *
   * ABSENT rather than a fabricated `unknown` when the page is not the supported one: on any other page there is no course list to have a
   * completeness, and reporting a verdict there would be inventing one. The worker still publishes `unknown` for the run, because that is what a
   * caller needs to hear — but it comes from the absence of a signal, not from a signal that said "unknown".
   */
  loadState?: CourseListLoadState;
}

/*
 * ==============================================================================================================================
 * THE RECOMMENDATION QUERY CONTRACT
 * ==============================================================================================================================
 *
 * ## Why the shape is stated ONCE, here
 *
 * The worker produces this response and the side panel consumes it, so both sides need the same declaration. It used to be two
 * private interfaces inside the worker's IIFE plus structural literals in tests — which meant two independent copies of one contract
 * with nothing stopping them from drifting. These are ambient, so either context can name them without an import.
 *
 * ## Why the request is not a separate object type
 *
 * `RuntimeMessage` already carries `type` and `tabId`, and a request that is structurally identical to what the worker reads would
 * be a second place to change if that ever grew. The type below instead PINS the existing runtime shape — a caller that builds a
 * `QueryRecommendationsRequest` is writing exactly the message the handler accepts, and nothing wider.
 *
 * ## What the response deliberately does NOT contain
 *
 * No `code`, no `stack`, no `details`, no error object, and no `tabId` or `generation`. Request ordering and tab ownership are
 * PANEL-LOCAL lifecycle concerns: the worker cannot know which tab a caller is looking at by the time a reply lands, and a
 * `generation` echoed back would be the worker taking a position on a question it has no facts about. The failure carries one fixed,
 * bounded message and nothing else.
 */

/**
 * The four importance weights a user's preference editor produces, as relative values.
 *
 * One definition, used by both the request type and the runtime message, so the panel and the worker cannot disagree about which fields may travel. The
 * numbers are RATIOS, not percentages and not normalised weights: the engine's `normalizePreferences` is the authority on what they become, and this layer
 * deliberately performs no arithmetic on them.
 *
 * The four keys are the only dimensions the product exposes. `teachingQuality` and `examFriendliness` cannot move a course up or down, so they have no
 * control; `studentSentiment` is the same weight as `overallScore` and is not named a second time.
 */
type PreferenceWeightPayload = Partial<Record<
  'gradeFriendliness' | 'workloadFriendliness' | 'attendanceFriendliness' | 'overallScore',
  number
>>;

/**
 * The message a caller sends to recommend from the courses loaded in a tab.
 *
 * Carries a TAB ID, and optionally the user's own importance weights.
 *
 * ## Why preferences are accepted and nothing else structural is
 *
 * `preferences` is a genuine USER input, and it is the only field here that is: the panel holds the sliders, so the panel is where the
 * numbers come from. A `preferences` payload cannot choose a provider, cannot choose a policy, cannot widen a query and cannot skip a
 * validation step — the worker passes it to the engine's existing `preferences` option, which normalises and re-validates it, and an
 * unusable payload therefore produces the engine's own default ranking rather than a broken one.
 *
 * Everything else stays absent for the reasons it always was: the provider is the worker's own module-scope instance, the policy is bound
 * inside the runner, `topN` is host policy, and `coverage` is a fact only the caller's own page read can state.
 */
type QueryRecommendationsRequest = {
  type: 'COURSE_COPILOT_QUERY_RECOMMENDATIONS';
  tabId: number;
  /**
   * The four importance weights the user chose, as relative values.
   *
   * OPTIONAL, and absent means "use the host's default ranking" — which is also what the panel sends before the user touches a slider, so an
   * untouched editor and a default run are the same request.
   */
  preferences?: PreferenceWeightPayload;
};

/**
 * What the page read actually produced, for this run.
 *
 * ## Why this travels beside the result instead of inside it
 *
 * These are INPUT-side facts about the page, not outputs of the ranking. An empty `RecommendationResult` is the canonical, correct answer to
 * "recommend from nothing", and it says nothing about WHY there was nothing — an unsupported tab, a tab with no content script, a reply that
 * could not be read, a page that genuinely lists no courses, and a page whose rows could not be mapped are five different situations that all
 * produce the same empty result. Carrying them here lets a caller say which one happened without parsing any text, and without teaching the
 * engine about page state it has no business knowing.
 *
 * Report-only: nothing in this object may influence a score, a rank or a confidence.
 */
type PageReadStatus = {
  /**
   * How the ask itself went.
   *
   * - `ok` — a content script answered and its reply was usable.
   * - `unavailable` — no usable answer was obtained: an unusable tab id, no content script, or a rejected `sendMessage`.
   * - `malformed` — something answered, but not in the agreed shape.
   */
  read: 'ok' | 'unavailable' | 'malformed';
  /**
   * The content script's own verdict on the page, when it answered.
   *
   * Absent when nothing answered, because there is then no page verdict to report — `false` would read as "the script ran and said no".
   */
  supported?: boolean;
  /** Teaching-class rows the content script reported. `0` when nothing was readable. */
  rowCount: number;
  /**
   * Rows that became a `NormalizedCourse`.
   *
   * Reported beside {@link rowCount} rather than instead of it, because the two disagree in a case worth telling apart: rows that exist but
   * cannot be mapped. `rowCount > 0` with `courseCount === 0` is not the same situation as a page with no rows at all.
   */
  courseCount: number;
  /**
   * Whether the loaded rows are known to be the whole list.
   *
   * `complete` is claimed only on the page's own end-of-list signal; `partial` only on its own load-more signal. Everything else — an unsupported
   * tab, a failed read, a page whose markers are not shaped as expected — is `unknown`, which must never be presented as `complete`, because a user
   * shown a complete-looking list has been told something the extension does not know.
   */
  completeness: 'partial' | 'complete' | 'unknown';
  /**
   * The page facts the verdict was derived from, when the page reported any.
   *
   * ABSENT rather than zeroed on a read that obtained nothing: fabricating `false` for all four would read as "no more rows and no end sign",
   * which is a claim about a page that was never successfully read. Reported so a caller can explain the verdict instead of only stating it.
   */
  loadState?: {
    morePresent: boolean;
    moreVisible: boolean;
    endSignPresent: boolean;
    endSignVisible: boolean;
  };
};

/**
 * One session of the bounded course-list expansion, as the content script reports it.
 *
 * Ambient on purpose, and for the same measured reason the rest of this file is: the content script is a CLASSIC script and cannot import, so every name
 * it uses has to be reachable without an import. That is why this shape lives here rather than in a module beside the implementation.
 */
type AutoExpandStatus = {
  /** `idle` before any approved start, `running` while a session is in flight, `finished` once one has ended. */
  phase: 'idle' | 'running' | 'finished';
  /** How many load-more clicks the session has made. Never above the controller's budget. */
  clicks: number;
  /** The list's completeness, as the page reported it. */
  completeness: 'partial' | 'complete' | 'unknown';
  /** Why the session ended. ABSENT while it is still running, because nothing has stopped it yet. */
  stopReason?: 'complete' | 'already_complete' | 'cancelled' | 'unknown_state' | 'no_progress' | 'click_failed' | 'wait_failed' | 'click_cap';
  /** Whether the last settled round saw a course panel appear. A fact about one round, never a counter. */
  lastStepProgressed?: boolean;
};

/**
 * The four auto-expand messages, each with exactly one meaning.
 *
 * ## Why a message per job rather than one overloaded type
 *
 * A single `AUTO_EXPAND` message carrying an action field would make "start" and "ask what happened" the same shape, and the one that MUST NOT run
 * anything would be distinguished from the one that does only by a string a caller could get wrong. Four types make the permission explicit in the type
 * system: only {@link StartAutoExpandRequest} begins a session.
 *
 * ## START is a receipt
 *
 * One session takes many seconds, and this worker has no keepalive — the architecture audit established that — so the START response is an
 * acknowledgement carrying the current status, never the outcome. The outcome arrives later as an {@link AutoExpandEvent}. Holding the response open
 * would make the caller depend on the worker surviving the whole expansion.
 */
type StartAutoExpandRequest = {
  type: 'COURSE_COPILOT_START_AUTO_EXPAND';
  tabId: number;
};

/** Cancellation. It sets a flag; it never undoes a click, touches the DOM or starts anything. */
type CancelAutoExpandRequest = {
  type: 'COURSE_COPILOT_CANCEL_AUTO_EXPAND';
  tabId: number;
};

/** A read-only question about the current session, so a reopening panel can recover the truth. */
type QueryAutoExpandStatusRequest = {
  type: 'COURSE_COPILOT_QUERY_AUTO_EXPAND_STATUS';
  tabId: number;
};

/**
 * The expansion reporting itself.
 *
 * SENT BY THE CONTENT SCRIPT, never forwarded back to it: a worker branch that relayed this to a tab would be a loop, and there is deliberately none.
 */
type AutoExpandEvent = {
  type: 'COURSE_COPILOT_AUTO_EXPAND_EVENT';
  /** `progress` after each settled round; `finished` exactly once, when the session ends. */
  phase: 'progress' | 'finished';
  clicks: number;
  completeness: 'partial' | 'complete' | 'unknown';
  /** Present on `finished` only. */
  stopReason?: AutoExpandStatus['stopReason'];
};

/** A URL the worker accepted, with the content script's own answer. */
type AutoExpandForwarded = {
  ok: true;
  /** The content script's reply, unmodified: this worker does not interpret it and keeps no copy. */
  reply: unknown;
};

/**
 * A forward that could not be made, or whose answer could not be used.
 *
 * One shape for three causes — an unusable tab id, a rejected send, a malformed reply — because the caller's next move is the same in each: it has no
 * session information and must not pretend otherwise. No error object, URL or stack reaches the caller.
 */
type AutoExpandForwardFailure = {
  ok: false;
  error: string;
};

/**
 * The answer when a run completed.
 *
 * `ok: true` covers every ordinary outcome, INCLUDING the failures that degrade to answers: an unusable tab id, a missing content
 * script, a malformed row reply, an unsupported page, a provider or network failure, and a course with no reviews all arrive here,
 * because the canonical pipeline has already turned them into an empty result or an `insufficientData` entry.
 */
type QueryRecommendationsSuccess = {
  ok: true;
  /** What the page read produced, so an empty result can be explained without guessing. */
  page: PageReadStatus;
  /** The canonical result, unmodified. See {@link RecommendationResult} in `recommendation-types.d.ts`. */
  result: RecommendationResult;
};

/**
 * The answer when the run itself broke, outside everything the pipeline degrades.
 *
 * `ok: false` does NOT mean "this course has no data" — that is `ok: true` with an empty result. The message is fixed and bounded:
 * no stack, no original exception text, no URL and nothing from inside the provider.
 */
type QueryRecommendationsFailure = {
  ok: false;
  error: string;
};

/** Either answer to {@link QueryRecommendationsRequest}. Discriminated on `ok`. */
type QueryRecommendationsResponse = QueryRecommendationsSuccess | QueryRecommendationsFailure;

/** Where a message came from. */
interface RuntimeSender {
  /** The tab the message came from, when it came from a content script. */
  tab?: { id?: number };
}

/** The extension runtime namespace. */
interface ChromeRuntime {
  /**
   * Registers a listener for lifecycle events.
   *
   * @param listener - receives the installation details; typed as `unknown` because this extension does not read them.
   */
  onInstalled: {
    addListener(listener: (details: unknown) => void): void;
  };

  /**
   * Registers a listener for runtime messages.
   *
   * @param listener - receives the message, its sender, and a callback for an optional reply.
   */
  onMessage: {
    addListener(listener: (message: RuntimeMessage, sender: RuntimeSender, sendResponse: (response: unknown) => void) => boolean | void): void;
  };

  /**
   * Sends a message to the extension's other contexts.
   *
   * @param message - the message to send.
   * @returns a promise that rejects when nothing is listening.
   */
  sendMessage(message: RuntimeMessage): Promise<unknown>;

  /** The manifest the browser actually loaded, useful for proving which build is running. */
  getManifest(): { version: string; name: string };
}

/** The side panel namespace. */
interface ChromeSidePanel {
  /**
   * Sets how the side panel is opened.
   *
   * @param options - `openPanelOnActionClick` makes a click on the extension's toolbar icon open the panel.
   * @returns a promise that rejects if the browser refuses the setting.
   */
  setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>;
}

/**
 * The tabs namespace, limited to what this extension actually needs.
 *
 * Using this namespace does NOT require the `"tabs"` permission. That permission governs the SENSITIVE properties —
 * `url`, `pendingUrl`, `title`, `favIconUrl` — not the namespace itself. The surface declared here is narrower than that
 * boundary on purpose: `query` exposes only `id`, so a change that started reading a URL or a title would have to be a
 * deliberate edit to this file rather than something that quietly became possible.
 */
interface ChromeTabs {
  /**
   * Finds tabs matching the given criteria.
   *
   * @param queryInfo - only ever `{ active: true, currentWindow: true }` here.
   * @returns the matching tabs, of which only `id` is read.
   */
  query(queryInfo: { active: boolean; currentWindow: boolean }): Promise<Array<{ id?: number }>>;
  /**
   * Sends a message to a specific tab's content script.
   *
   * @param tabId - the tab to message.
   * @param message - the message to send.
   * @returns a promise that rejects when the tab has no listener.
   */
  sendMessage(tabId: number, message: RuntimeMessage): Promise<unknown>;
}

/** The subset of the global `chrome` object this extension relies on. */
interface ChromeApi {
  runtime: ChromeRuntime;
  sidePanel: ChromeSidePanel;
  tabs: ChromeTabs;
}
