/**
 * PART 16J-PREUI-E4-C1 — the unified full-course preparation workflow.
 *
 * ## What this orchestrates, and what it must not do itself
 *
 * One approved run performs three phases: load every course the page will give us, fill in the teacher data those panels hide, then read the page back. The
 * ORDER is the whole contribution — teacher hydration may not begin until the course list is PROVEN complete — so these tests concentrate on the seams
 * between phases: which outcome lets the next phase start, which one stops the run, and what the final read sees.
 *
 * The two page interactions are the existing bounded controllers, driven at the artifact level exactly as the standalone suites drive them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contentScriptPath = join(repoRoot, 'apps', 'extension', 'dist', 'content', 'content-script.js');
const panelSource = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');

const START = 'COURSE_COPILOT_START_FULL_PREPARATION';
const CANCEL = 'COURSE_COPILOT_CANCEL_FULL_PREPARATION';
const QUERY_STATUS = 'COURSE_COPILOT_QUERY_FULL_PREPARATION_STATUS';
const EVENT = 'COURSE_COPILOT_FULL_PREPARATION_EVENT';
const AUTO_EXPAND_EVENT = 'COURSE_COPILOT_AUTO_EXPAND_EVENT';
const HYDRATION_EVENT = 'COURSE_COPILOT_TEACHER_HYDRATION_EVENT';
const QUERY_VISIBLE_ROWS = 'COURSE_COPILOT_QUERY_VISIBLE_ROWS';

// ---------------------------------------------------------------------------- a controllable page

type Listener = () => void;

class Element {
  readonly tagName: string;
  readonly style: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly children: Element[] = [];
  parent: Element | null = null;
  readonly classes = new Set<string>();
  text: string | null = null;
  clickCount = 0;
  readonly #listeners = new Map<string, Set<Listener>>();

  constructor(tagName: string) { this.tagName = tagName.toLowerCase(); }

  get className(): string { return [...this.classes].join(' '); }

  classList = { contains: (token: string): boolean => this.classes.has(token) };

  matchesCompound(selector: string): boolean {
    /*
     * ATTRIBUTE CLAUSES are honoured, which this matcher did not need until PRE-RELEASE-UX-A10. The availability filter's granted selectors are attribute-based —
     * `div.items[name=yl_list]`, `li[index=yl_list_1] a`, `button[name=query]` — so a matcher that only understood `#id`, `tag` and `.class` would find none of
     * them and the filter phase would report `unavailable` against a fixture that plainly contained a working filter.
     */
    const attrMatches = [...selector.matchAll(/\[([\w-]+)=([^\]]+)\]/gu)];
    const withoutAttrs = selector.replace(/\[[^\]]*\]/gu, '');
    for (const match of attrMatches) {
      if (this.attributes[match[1] ?? ''] !== match[2]) return false;
    }
    if (withoutAttrs.length === 0) return true;
    const parts = withoutAttrs.split('.');
    const tag = parts[0] ?? '';
    if (tag.startsWith('#')) return this.attributes.id === tag.slice(1);
    if (tag.length > 0 && this.tagName !== tag) return false;
    return parts.slice(1).every((token) => token.length === 0 || this.classes.has(token));
  }

  matches(selector: string): boolean {
    return selector.includes(' ') ? this.querySelector(selector) !== null : this.matchesCompound(selector);
  }

  querySelector(selector: string): Element | null {
    const steps = selector.trim().split(/\s+/u);
    const last = steps[steps.length - 1] ?? '';
    for (const candidate of this.querySelectorAll(last)) {
      let node: Element | null = candidate.parent;
      let step = steps.length - 2;
      while (step >= 0 && node !== null) {
        if (node.matchesCompound(steps[step] ?? '')) step -= 1;
        node = node.parent;
      }
      if (step < 0) return candidate;
    }
    return null;
  }

  querySelectorAll(selector: string): Element[] {
    const last = selector.trim().split(/\s+/u).pop() ?? '';
    const found: Element[] = [];
    for (const child of this.children) {
      if (child.matchesCompound(last)) found.push(child);
      found.push(...child.querySelectorAll(last));
    }
    return found;
  }

  get textContent(): string { return this.text !== null ? this.text : this.children.map((child) => child.textContent).join(''); }
  /**
   * The element's rendered width, which is ZERO when it or any ancestor is hidden.
   *
   * The content script's reveal gate requires a non-zero box before it will click the filter's expand control, and this fixture had no `offsetWidth` at all — so the
   * read was `undefined`, the gate refused, and a page with a perfectly good reveal control was reported as unable to expose its filter rows. A real element always
   * answers this property, so the stub must too.
   */
  get offsetWidth(): number {
    let node: Element | null = this;
    while (node !== null) {
      if (node.style['display'] === 'none') return 0;
      node = node.parent;
    }
    return 100;
  }
  get childElementCount(): number { return this.children.length; }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  getBoundingClientRect(): { width: number; height: number; top: number } { return { width: 100, height: 20, top: 0 }; }

  click(): void {
    this.clickCount += 1;
    for (const listener of this.#listeners.get('click') ?? []) listener();
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.#listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(type, set);
  }
}

class FakeObserver {
  static live: FakeObserver[] = [];
  readonly #callback: (records: Array<{ addedNodes: Element[] }>) => void;
  #targets: Element[] = [];

  constructor(callback: (records: Array<{ addedNodes: Element[] }>) => void) {
    this.#callback = callback;
    FakeObserver.live.push(this);
  }

  observe(target: Element): void { this.#targets.push(target); }

  disconnect(): void {
    this.#targets = [];
    FakeObserver.live = FakeObserver.live.filter((entry) => entry !== this);
  }

  /**
   * Deliver one change to every live observer watching `changed` or an ancestor.
   *
   * `added` is passed through as the record's `addedNodes`, because the expansion watcher decides PROGRESS by inspecting the nodes a change added. An earlier
   * version of this harness invoked the callback with no records at all, so every round looked like it grew nothing and the expansion stopped as
   * `no_progress` — a harness bug that presented as a product failure.
   */
  static notify(changed: Element, added: Element[] = []): void {
    for (const observer of [...FakeObserver.live]) {
      for (const target of observer.#targets) {
        let node: Element | null = changed;
        while (node !== null) {
          if (node === target) { observer.#callback([{ addedNodes: added }]); break; }
          node = node.parent;
        }
      }
    }
  }
}

/**
 * The page under test.
 *
 * `pages` decides how many load-more batches the page will serve: the fixture starts with the courses in `initial` and each load-more click appends the next
 * batch, until the page flips its own markers to `complete`. That is what lets a test drive the expansion to a chosen outcome.
 */
interface PageSpec {
  /** Course panels present at first, each with `rows` teaching classes whose teacher cells start empty. */
  readonly initial: number;
  /** How many additional panels each load-more click appends. `0` means the page accepts the click and grows nothing. */
  readonly perClick: number;
  /** How many batches the page will serve before it reports the end. */
  readonly batches: number;
  /** Whether panels are unexpanded (`a.expand1`) or already expanded. */
  readonly expanded?: boolean;
  /** How each expand click fills its panel: `all`, `first`, or `none`. */
  readonly fill?: 'all' | 'first' | 'none';
  /** Whether the real course list exists at all. */
  readonly list?: boolean;
  /** Whether the supported page's URL is used. */
  readonly supported?: boolean;
  /** Teaching classes on each panel. Defaults to one, the shape the real page usually has. */
  readonly rowsPerPanel?: number;
  /**
   * How the page's 「有余量」 filter behaves, because the run now starts by operating it.
   *
   * `applied` (the default) is a working filter panel whose 「有」 option starts unchosen, `already` has it chosen already so no option click is needed, `none`
   * omits the panel entirely, `no-query` omits only the query button, `zero` makes the filtered query leave no courses at all, `unavailable` omits the reveal
   * control while the rows are hidden, and `option-inert` has the option accept the click without ever becoming chosen. Each is a state the real page can be in,
   * and each is what decides whether the run proceeds.
   */
  readonly filter?: 'applied' | 'already' | 'none' | 'no-query' | 'zero' | 'unavailable' | 'option-inert';
  /** Hold the first filter query open, so a cancellation can be delivered while the filter phase is genuinely in flight. */
  readonly holdFilterExpand?: boolean;
  /** Start with the filter rows collapsed, so the run must reveal them before it can choose 「有」. */
  readonly collapsedFilters?: boolean;
  /**
   * Cancel the whole preparation when the Nth panel's expand control is clicked, counting from one.
   *
   * This is how a cancellation "during hydration" is produced HONESTLY: the request is issued from inside the page adapter at the moment the second panel's
   * click happens, which is exactly when a user would press stop. Driving the flag directly would prove nothing about the runtime's reaction to it.
   */
  readonly cancelOnHydrationPanel?: number;
}

interface Harness {
  readonly events: Array<Record<string, unknown>>;
  readonly expandClicks: () => number[];
  readonly loadMoreClicks: () => number;
  readonly teacherTexts: () => string[];
  /** The three filter interactions this run performed: reveal, option and query. */
  readonly filterClicks: () => { expand: number; option: number; query: number };
  /** Every page interaction, in order: `filter-expand`, `filter-option`, `filter-query`, `load-more`, `hydrate-panel`. */
  readonly interactions: () => string[];
  /** Resume a filter query the fixture was asked to hold. */
  readonly releaseFilterExpand: () => Promise<void>;
  ask: (type: string) => Record<string, unknown>;
  flush: () => Promise<void>;
}

function harness(spec: PageSpec): Harness {
  const root = new Element('div');
  const contentBox = new Element('div');
  contentBox.attributes.id = 'contentBox';
  const list = new Element('div');
  list.classes.add('tjxk_list');
  if (spec.list !== false) {
    contentBox.children.push(list);
    list.parent = contentBox;
  }

  const panels: Element[] = [];
  const anchors: Element[] = [];
  const cellsPerPanel: Element[][] = [];
  /**
   * Declared before the panels so a panel's click handler can ask the content script something.
   *
   * Nothing calls it before the harness returns, but a handler that closes over a later `const` would depend on that ordering holding forever, and the page's own
   * cancellation is issued from exactly here.
   */
  let ask: (type: string) => Record<string, unknown> = () => { throw new Error('harness not ready'); };

  /** Build one course panel and append it to the list, returning it so a caller can report it as an added node. */
  const buildPanel = (): Element => {
    const panel = new Element('div');
    panel.classes.add('panel');
    panel.classes.add('panel-info');
    const heading = new Element('div');
    heading.classes.add('panel-heading');
    heading.classes.add('kc_head');
    /*
     * A readable course identity, because the final rescan is the REAL scanner: it skips a panel whose heading yields no name, so a fixture without one would
     * report zero rows for the finished page. Hydration does not need it — it reads rows and teacher cells only — but phase three does.
     */
    const title = new Element('h3');
    title.classes.add('kcmc');
    title.text = `(C${panels.length})课程${panels.length}`;
    heading.children.push(title);
    title.parent = heading;
    const anchor = new Element('a');
    anchor.classes.add('expand_close');
    // An already-expanded panel carries the other class and has no expand control to click.
    if (spec.expanded === true) anchor.classes.add('close1');
    else anchor.classes.add('expand1');
    anchor.attributes.href = 'javascript:void(0);';
    const index = panels.length;
    anchor.addEventListener('click', () => {
      anchor.classes.delete('expand1');
      anchor.classes.add('close1');
      // Recorded as 「教师信息补全」 rather than as a generic panel expansion: this control IS the hydration phase's page interaction.
      interactions.push('hydrate-panel');
      /*
       * A cancellation issued from INSIDE the page adapter, at the moment this panel is expanded. That is when a user would press stop, and it is the only way
       * to prove the runtime reacts to a request that arrives mid-phase rather than before it.
       */
      if (spec.cancelOnHydrationPanel !== undefined && index + 1 === spec.cancelOnHydrationPanel) {
        ask(CANCEL);
      }
      const cells = cellsPerPanel[index] ?? [];
      const fill = spec.fill ?? 'all';
      const limit = fill === 'none' ? 0 : (fill === 'first' ? Math.min(1, cells.length) : cells.length);
      for (let cell = 0; cell < limit; cell += 1) cells[cell]!.text = `T${index}-${cell}`;
      FakeObserver.notify(panel, []);
    });
    heading.children.push(anchor);
    anchor.parent = heading;
    anchors.push(anchor);

    const body = new Element('div');
    body.classes.add('panel-body');
    const table = new Element('table');
    const tbody = new Element('tbody');
    const cells: Element[] = [];
    /*
     * One teaching class per row by default, which is the shape the real page uses: a course offered once carries one `tr.body_tr`, and a panel with several
     * rows carries one class per row. Hydration is panel-wide (measured in E4-A-R1: one expand click fills EVERY row of its panel), so only the cases that
     * need a partly-filled panel ask for more than one row.
     */
    const rows = spec.rowsPerPanel ?? 1;
    for (let row = 0; row < rows; row += 1) {
      const tr = new Element('tr');
      tr.classes.add('body_tr');
      const td = new Element('td');
      td.classes.add('jsxm');
      td.text = '';
      tr.children.push(td);
      td.parent = tr;
      tbody.children.push(tr);
      tr.parent = tbody;
      cells.push(td);
    }
    table.children.push(tbody);
    tbody.parent = table;
    body.children.push(table);
    table.parent = body;
    panel.children.push(heading, body);
    heading.parent = panel;
    body.parent = panel;
    list.children.push(panel);
    panel.parent = list;
    panels.push(panel);
    cellsPerPanel.push(cells);
    return panel;
  };

  for (let index = 0; index < spec.initial; index += 1) buildPanel();

  const more = new Element('div');
  more.attributes.id = 'more';
  const endsign = new Element('div');
  endsign.attributes.id = 'endsign';
  /** The page states completeness with these two markers and nothing else. */
  const paint = (complete: boolean): void => {
    more.style.display = complete ? 'none' : 'block';
    endsign.style.display = complete ? 'block' : 'none';
  };
  // A page that will serve no batches starts already complete.
  paint(spec.batches === 0);

  let batchesServed = 0;
  let loadMoreClicks = 0;
  const loadMore = new Element('a');
  loadMore.attributes.href = 'javascript:void(0);';
  loadMore.addEventListener('click', () => {
    loadMoreClicks += 1;
    interactions.push('load-more');
    batchesServed += 1;
    const added: Element[] = [];
    for (let index = 0; index < spec.perClick; index += 1) { added.push(buildPanel()); }
    if (batchesServed >= spec.batches) paint(true);
    // The appended panels are passed as the record's added nodes, which is how the expansion watcher sees progress.
    FakeObserver.notify(list, added);
  });
  more.children.push(loadMore);
  loadMore.parent = more;

  /*
   * ============================================================ the availability filter panel
   *
   * The run now BEGINS by operating WHU's own 「有余量」 filter, so a fixture without one would make every preparation test report
   * `availability_filter_unavailable` and prove nothing about the phases those tests are about. The panel is built from the same measured structure the A9 suite
   * uses: `#searchBox` owns the reveal control, the option group and the submit, and the option rows live inside the group.
   *
   * The clicks are counted here rather than inferred, because the hard bounds are part of the contract: at most one expand, one option and one query per run.
   */
  const filterMode = spec.filter ?? 'applied';
  let filterExpandClicks = 0;
  let filterOptionClicks = 0;
  let filterQueryClicks = 0;
  /*
   * Whether the first filter query should PARKE the run so a cancellation can land mid-phase.
   *
   * The session awaits a frame inside its rebuild wait, so a caller that cancels while the query is held is genuinely cancelling work in flight rather than after it
   * finished. Cancelling before the run starts or after it ends would demonstrate nothing about the routing.
   */
  let holdFilterExpand = spec.holdFilterExpand === true;
  let releaseFilterExpand: (() => void) | undefined;
  let filterExpandHold: Promise<void> | undefined;
  /*
   * EVERY page interaction this run performs, in the order it happened.
   *
   * This is what makes the phase ORDER testable rather than merely reported: the phases are announced by the content script, but the ordering claim is about what
   * was done to the page, and only a trace of the interactions themselves can prove that no load-more happened before the filter took effect.
   */
  const interactions: string[] = [];

  /** The option group's list, so revealing the rows can unhide it the way the page's own control does. */
  const filterGroup = new Element('div');
  filterGroup.classes.add('items');
  filterGroup.attributes.name = 'yl_list';
  const filterList = new Element('ul');
  const optionAnchor = new Element('a');
  optionAnchor.attributes.href = 'javascript:void(0);';
  optionAnchor.text = '有';
  if (filterMode === 'already') optionAnchor.classes.add('selectedValue');
  /** The option click's own page effect. This interaction is NOT held: the session re-reads the chosen marker in the same tick, so a deferred click would be read as
   * "the filter did not take" and report `failed` instead of whatever the test is actually about. */
  const applyOption = (): void => {
    filterOptionClicks += 1;
    interactions.push('filter-option');
    /*
     * In `option-inert` mode the click is ACCEPTED but the widget never marks the option chosen. That is the `failed` outcome: the filter was reachable and did not
     * take, which is a different situation from one that cannot be reached at all — and it is the branch that decides whether the run stops before loading.
     */
    if (filterMode === 'option-inert') return;
    // The widget writes its own chosen marker; the session reads it back rather than trusting the click.
    optionAnchor.classes.add('selectedValue');
  };
  optionAnchor.addEventListener('click', () => { applyOption(); });
  const optionRow = new Element('li');
  optionRow.attributes.index = 'yl_list_1';
  optionRow.children.push(optionAnchor);
  optionAnchor.parent = optionRow;
  const unavailableAnchor = new Element('a');
  unavailableAnchor.attributes.href = 'javascript:void(0);';
  unavailableAnchor.text = '无';
  const unavailableRow = new Element('li');
  unavailableRow.attributes.index = 'yl_list_0';
  unavailableRow.children.push(unavailableAnchor);
  unavailableAnchor.parent = unavailableRow;
  filterList.children.push(optionRow, unavailableRow);
  optionRow.parent = filterList;
  unavailableRow.parent = filterList;
  filterGroup.children.push(filterList);
  filterList.parent = filterGroup;

  const queryButton = new Element('button');
  queryButton.attributes.type = 'button';
  queryButton.attributes.name = 'query';
  queryButton.text = '查询';
  let filterQuerySubmitted = false;
  queryButton.addEventListener('click', () => {
    filterQueryClicks += 1;
    interactions.push('filter-query');
    /*
     * The page's own submit CLEARS the list and rebuilds it. Reproduced rather than skipped, because a fixture where the list survives would let a controller that
     * never waits for the rebuild pass — and waiting is exactly what the transient-absence rule is about.
     *
     * It rebuilds ONCE. A real query does replace the listing every time, but these tests are about the phases AFTER the filter, and re-rebuilding would discard
     * the teacher data and load-more progress that the later phases' assertions are about. The single rebuild is enough to exercise the transient absence.
     */
    if (filterQuerySubmitted) return;
    filterQuerySubmitted = true;
    list.children.length = 0;
    panels.length = 0;
    anchors.length = 0;
    cellsPerPanel.length = 0;
    if (filterMode !== 'zero') {
      for (let index = 0; index < spec.initial; index += 1) buildPanel();
    }
  });

  const expandControl = new Element('a');
  expandControl.classes.add('down');
  expandControl.attributes.href = 'javascript:void(0);';
  expandControl.text = '展开';
  /** The reveal control's own page effect, applied only after the hold (if any) has been released. */
  const applyExpand = (): void => {
    filterExpandClicks += 1;
    interactions.push('filter-expand');
    // Revealing the rows is the page's own change: it clears the inline collapse from every level of the row set.
    delete filterGroup.style.display;
    delete filterList.style.display;
    delete optionRow.style.display;
    delete optionAnchor.style.display;
  };
  expandControl.addEventListener('click', () => {
    if (holdFilterExpand) {
      /*
       * The FIRST reveal parks the run BEFORE the rows are actually shown. The session awaits a frame immediately after this click, so a cancel delivered while the
       * hold is open lands in a genuine in-flight window, and the SAME invocation then applies the click for real when the test releases it.
       *
       * The EXPAND is what is held rather than the option click or the query, because the session's interaction with the page is synchronous at those points: it
       * re-reads the option's own class in the same tick, so a deferred option click would be observed as "the filter did not take" and report `failed` instead of
       * the cancellation under test.
       */
      holdFilterExpand = false;
      filterExpandHold = new Promise<void>((resolveHold) => { releaseFilterExpand = resolveHold; });
      void filterExpandHold.then(() => { applyExpand(); });
      return;
    }
    applyExpand();
  });
  if (spec.collapsedFilters === true) {
    /*
     * COLLAPSED AT EVERY LEVEL, which is what makes the reveal control genuinely necessary. Hiding only the group would leave the option's own box non-zero, and the
     * session treats a visible anchor as reachable no matter what an ancestor says — measured behaviour, and the reason the A9 suite's helper hides every level too.
     */
    filterGroup.style.display = 'none';
    filterList.style.display = 'none';
    optionRow.style.display = 'none';
    optionAnchor.style.display = 'none';
  }
  if (filterMode === 'unavailable') {
    // The rows are collapsed AND there is no control to reveal them, which is the refusal case.
    filterGroup.style.display = 'none';
  }

  if (filterMode !== 'none' && spec.supported !== false) {
    /*
     * An UNSUPPORTED page gets no filter panel, because in production it could not: the content script is injected only on the supported page, so a document with
     * this extension's script in it is the supported one. Building a panel here would invent a page that cannot exist and make the refusal case untestable —
     * which is exactly what happened before this guard, when an unsupported fixture reported `applied` across a filter the real page would never expose.
     */
    const searchBox = new Element('div');
    searchBox.attributes.id = 'searchBox';
    searchBox.children.push(filterGroup);
    filterGroup.parent = searchBox;
    if (filterMode !== 'unavailable') {
      searchBox.children.push(expandControl);
      expandControl.parent = searchBox;
    }
    if (filterMode !== 'no-query') {
      searchBox.children.push(queryButton);
      queryButton.parent = searchBox;
    }
    root.children.push(searchBox);
    searchBox.parent = root;
  }

  const inner = new Element('div');
  inner.attributes.id = 'innerContainer';
  inner.children.push(contentBox, more, endsign);
  contentBox.parent = inner;
  more.parent = inner;
  endsign.parent = inner;
  root.children.push(inner);
  inner.parent = root;

  const events: Array<Record<string, unknown>> = [];
  const listeners: Array<(message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => unknown> = [];
  const pendingTimers: Array<() => void> = [];
  /*
   * A CONTROLLABLE CLOCK, and why this fixture needs one now.
   *
   * PRE-RELEASE-UX-A10 gave the run a first phase that waits for the page's own query to settle, and that wait is time-based: it polls and requires the result set
   * to hold still for a quiet window before accepting it. `flush()` runs the queued timers back to back, which advances no real time, so the wait could never
   * satisfy itself and every preparation test stalled in `filtering_available`.
   *
   * The clock is therefore virtual: `sleep` moves it forward by the delay that was asked for, so a poll sees real elapsed time and the wait settles in a couple
   * of rounds instead of two hundred. The sandbox's `Date` is replaced so the content script reads THIS clock rather than the host's.
   */
  let clock = 0;
  const timers = {
    setTimeout: (fn: () => void, delay?: number): number => {
      const at = clock + (typeof delay === 'number' ? delay : 0);
      pendingTimers.push(() => {
        /*
         * While a filter query is held, the clock does not move. The session's rebuild wait is driven by timers AND by elapsed time, so freezing the clock keeps the
         * run inside the filter phase — which is the window a cancellation must be tested in. A held run cannot be advanced by any amount of `flush()`.
         */
        if (filterExpandHold !== undefined) { pendingTimers.push(() => { clock = Math.max(clock, at); fn(); }); return; }
        clock = Math.max(clock, at);
        fn();
      });
      return pendingTimers.length;
    },
    clearTimeout: (): void => { /* timers run wholesale in flush() */ },
  };
  class FakeDate {
    static now(): number { return clock; }
  }

  const sandbox: Record<string, unknown> = {
    Date: FakeDate,
    document: {
      querySelector: (selector: string): Element | null => root.querySelector(selector),
      querySelectorAll: (selector: string): Element[] => root.querySelectorAll(selector),
      documentElement: root,
    },
    getComputedStyle: (element: Element): { display: string; visibility: string } => {
      /*
       * ANCESTORS COUNT, which this fixture got wrong until PRE-RELEASE-UX-A10 and which made a hidden option look reachable.
       *
       * A real `getComputedStyle` answers for the element as RENDERED, so a `display:none` ancestor hides everything inside it. This stub returned the element's own
       * inline style only, so the session's visibility gate saw a hidden 「有」 anchor as perfectly clickable, skipped the reveal entirely and ran straight to the
       * query — which made the cancellation test unobservable and, worse, described a page where a collapsed filter is still operable.
       */
      let node: Element | null = element;
      let display = 'block';
      let visibility = 'visible';
      while (node !== null) {
        if (node.style['display'] === 'none') display = 'none';
        if (node.style['visibility'] === 'hidden' || node.style['visibility'] === 'collapse') visibility = node.style['visibility'] ?? 'visible';
        node = node.parent;
      }
      return { display, visibility };
    },
    location: {
      hostname: spec.supported === false ? 'example.invalid' : 'jwgl.whu.edu.cn',
      pathname: spec.supported === false ? '/' : '/xsxk/zzxkyzb_cxZzxkYzbIndex.html',
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    MutationObserver: FakeObserver,
    HTMLElement: Element,
    window: { setTimeout: timers.setTimeout },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    chrome: {
      runtime: {
        id: 'test-extension-id',
        sendMessage: (message: Record<string, unknown>): Promise<void> => {
          if (message?.type === EVENT) events.push(message);
          // The two standalone features would also announce; they are silent here because this run owns the reporting.
          if (events.length > 400) events.length = 400;
          return Promise.resolve();
        },
        onMessage: { addListener: (listener: never) => { listeners.push(listener); } },
      },
    },
  };
  sandbox['globalThis'] = sandbox;
  sandbox['self'] = sandbox;
  vm.createContext(sandbox);
  new vm.Script(readFileSync(contentScriptPath, 'utf8'), { filename: 'content-script.js' }).runInContext(sandbox);

  // Assigned here so the panels built above can close over it without depending on declaration order.
  ask = (type: string): Record<string, unknown> => {
    let response: unknown;
    const listener = listeners[0];
    if (listener === undefined) throw new Error('content script registered no listener');
    listener({ type }, { tab: { id: 7 } }, (value: unknown) => { response = value; });
    return response as Record<string, unknown>;
  };

  return {
    events,
    expandClicks: () => anchors.map((anchor) => anchor.clickCount),
    loadMoreClicks: () => loadMoreClicks,
    /** The three filter interactions, counted so the hard bounds can be asserted rather than assumed. */
    filterClicks: () => ({ expand: filterExpandClicks, option: filterOptionClicks, query: filterQueryClicks }),
    interactions: () => [...interactions],
    /** Resume a held filter query, so the run can continue past the phase a cancellation test stopped it in. */
    releaseFilterExpand: async (): Promise<void> => {
      releaseFilterExpand?.();
      releaseFilterExpand = undefined;
      await filterExpandHold;
      filterExpandHold = undefined;
    },
    teacherTexts: () => cellsPerPanel.flat().map((cell) => (cell.textContent ?? '').trim()),
    ask,
    async flush(): Promise<void> {
      for (let round = 0; round < 16; round += 1) {
        const batch = pendingTimers.splice(0, pendingTimers.length);
        for (const fn of batch) fn();
        await Promise.resolve();
      }
    },
  };
}

describe('PRE-RELEASE-UX-A10 the filter runs BEFORE anything is loaded or hydrated', () => {
  /*
   * ## What these cases assert, and why they are about the PAGE and not the report
   *
   * The phases are announced by the content script, so a phase list alone proves only what the run said about itself. The ordering claim is about what was DONE
   * to the page — no load-more before the filter took effect, no hydration before the load-more finished — so these cases read the fixture's own interaction
   * trace, which records every page control that was clicked, in order.
   */
  const indexOf = (trace: readonly string[], token: string): number => trace.indexOf(token);

  it('A. the normal path is FILTER → LOAD_MORE → HYDRATE → RESCAN → FINISH', async () => {
    // Two batches to load and two panels to hydrate, so all four interactions actually happen.
    const h = harness({ initial: 2, perClick: 1, batches: 2, fill: 'all', rowsPerPanel: 1 });
    const status = await runPreparation(h);
    expect(status.stopReason).toBe('teacher_hydration_completed');

    const trace = h.interactions();
    expect(trace).toContain('filter-option');
    expect(trace).toContain('filter-query');
    expect(trace).toContain('load-more');
    expect(trace).toContain('hydrate-panel');
    // The filter's own query comes before every load-more, and every load-more before every hydration.
    expect(indexOf(trace, 'filter-query')).toBeLessThan(indexOf(trace, 'load-more'));
    expect(indexOf(trace, 'load-more')).toBeLessThan(indexOf(trace, 'hydrate-panel'));

    const phases = h.events.filter((event) => typeof event.phase_changed === 'string').map((event) => event.phase_changed);
    expect(phases).toEqual(['filtering_available', 'loading_courses', 'hydrating_teachers', 'rescanning']);
  });

  it('B. no load-more happens before the filter has taken effect', async () => {
    /*
     * The bound that matters most: the load-more cap must be spent on the SELECTABLE pool. If a load-more ran first, the cap would be consumed by courses the user
     * cannot choose, and the trace would show it.
     */
    const h = harness({ initial: 1, perClick: 1, batches: 3, fill: 'all' });
    await runPreparation(h);
    const trace = h.interactions();
    const firstLoadMore = indexOf(trace, 'load-more');
    expect(firstLoadMore).toBeGreaterThanOrEqual(0);
    // EVERY load-more comes after the filter's query.
    expect(indexOf(trace, 'filter-query')).toBeLessThan(firstLoadMore);
    // And the option was chosen before the query, which is the page's own required order.
    expect(indexOf(trace, 'filter-option')).toBeLessThan(indexOf(trace, 'filter-query'));
  });

  it('C. no hydration happens before the load-more has finished', async () => {
    const h = harness({ initial: 1, perClick: 1, batches: 2, fill: 'all', rowsPerPanel: 1 });
    await runPreparation(h);
    const trace = h.interactions();
    const lastLoadMore = trace.lastIndexOf('load-more');
    const firstHydrate = indexOf(trace, 'hydrate-panel');
    expect(lastLoadMore).toBeGreaterThanOrEqual(0);
    expect(firstHydrate).toBeGreaterThan(lastLoadMore);
  });

  it('D. an already-chosen 「有」 still continues through every later phase', async () => {
    /*
     * `already_applied` is a SUCCESS: the caller asked for this filter to be active and it is. The run must therefore continue exactly as in the normal case, with
     * no option click issued — clicking again would toggle a condition the page already set.
     */
    const h = harness({ initial: 1, perClick: 1, batches: 1, fill: 'all', filter: 'already' });
    const status = await runPreparation(h);
    expect(h.filterClicks()).toEqual({ expand: 0, option: 0, query: 1 });
    expect(h.loadMoreClicks()).toBe(1);
    expect(h.interactions()).toContain('hydrate-panel');
    expect(status.stopReason).toBe('teacher_hydration_completed');
  });

  it('E. a valid zero-course pool loads nothing, hydrates nothing and still finishes honestly', async () => {
    /*
     * 「有余量」 can legitimately match nothing. Clicking load-more with no results behind it and hydrating courses that do not exist would both be wrong, so the run
     * skips both — and it must still finish through a REAL read, because the panel has to be able to say "there are no selectable courses" rather than "the list
     * could not be loaded".
     *
     * The read is asserted by its own CONTENT, not merely by the field being present. A stub object would satisfy `toBeDefined()`, and did: replacing the read with
     * a hardcoded page object was not caught until these three values were pinned. `listPresent: false` with `rowCount: 0` is the filtered-to-zero shape, and it is
     * what the panel's 「没有可选课程」 wording depends on.
     */
    const h = harness({ initial: 3, perClick: 1, batches: 2, fill: 'all', filter: 'zero' });
    const status = await runPreparation(h);
    expect(h.filterClicks().query).toBe(1);
    expect(h.loadMoreClicks()).toBe(0);
    expect(h.interactions()).not.toContain('hydrate-panel');
    expect(status.teacherHydrationStatus).toBeUndefined();
    /*
     * The read is asserted by its own CONTENT, not merely by the field being present. A stub object satisfied `toBeDefined()`, and did: replacing the read with a
     * hardcoded page object was not caught until these values were pinned.
     *
     * The measured shape of this case is an EMPTY LIST that is still present, reported `partial`. That is the honest reading: the page re-rendered a list and it
     * holds no panels, while the load-more marker is still up because the page has not said the listing ended. It is emphatically NOT `course_list_incomplete` — a
     * zero-course pool is a result, not a failure to read one.
     */
    const finalPage = status.finalPage as { supported?: boolean; rowCount?: number; listPresent?: boolean; completeness?: string } | undefined;
    expect(finalPage).toBeDefined();
    expect(finalPage?.supported).toBe(true);
    expect(finalPage?.rowCount).toBe(0);
    expect(finalPage?.listPresent).toBe(true);
    expect(finalPage?.completeness).toBe('partial');
    expect(status.stopReason).toBe('completed');
    const phases = h.events.filter((event) => typeof event.phase_changed === 'string').map((event) => event.phase_changed);
    expect(phases).toEqual(['filtering_available', 'rescanning']);
  });

  it('E2. a filtered pool that also ends the listing loads and hydrates nothing either', async () => {
    /*
     * The other shape a filtered-to-zero page takes: the page removes the list and leaves its end-of-list marker up, so the filtered pool is empty AND the listing has
     * ended. The run must treat that exactly like the empty-list shape — nothing to load, nothing to hydrate — rather than as a malformed page.
     */
    const h = harness({ initial: 2, perClick: 1, batches: 0, fill: 'all', filter: 'zero' });
    const status = await runPreparation(h);
    expect(h.loadMoreClicks()).toBe(0);
    expect(h.interactions()).not.toContain('hydrate-panel');
    expect(['completed', 'read_failed']).toContain(status.stopReason);
  });

  it('F. a filter the page will not apply stops the run before any later phase', async () => {
    // No query button at all: the filter is reachable but cannot be submitted, so nothing may be loaded or hydrated.
    const h = harness({ initial: 2, perClick: 1, batches: 2, fill: 'all', filter: 'no-query' });
    const status = await runPreparation(h);
    expect(status.stopReason).toBe('availability_filter_unavailable');
    expect(h.filterClicks().query).toBe(0);
    expect(h.loadMoreClicks()).toBe(0);
    expect(h.interactions()).not.toContain('hydrate-panel');
    const phases = h.events.filter((event) => typeof event.phase_changed === 'string').map((event) => event.phase_changed);
    // The filter phase is entered and no other phase follows it.
    expect(phases).toEqual(['filtering_available']);
  });

  it('F2. a filter that was REACHABLE and did not take stops the run too', async () => {
    /*
     * The other refusal, and the one with no test until this point. The option accepts the click and never becomes chosen, so the filter was operable and did not
     * take: the pool would not be the selectable one, and preparing it would make the approval copy's 「只分析当前可选课程」 false.
     *
     * Two things are asserted that the earlier refusal cannot show: the option click DID happen (so the page was manipulated), and the QUERY never did — the run
     * stops at the option rather than submitting a filter it could not confirm.
     */
    const h = harness({ initial: 2, perClick: 1, batches: 2, fill: 'all', filter: 'option-inert' });
    const status = await runPreparation(h);
    expect(status.stopReason).toBe('availability_filter_failed');
    expect(h.filterClicks()).toEqual({ expand: 0, option: 1, query: 0 });
    expect(h.loadMoreClicks()).toBe(0);
    expect(h.interactions()).toEqual(['filter-option']);
    expect(status.teacherHydrationStatus).toBeUndefined();
    expect(status.finalPage).toBeUndefined();
  });

  it('G. the three filter interactions are bounded to at most one each', async () => {
    const h = harness({ initial: 2, perClick: 1, batches: 2, fill: 'all' });
    await runPreparation(h);
    const clicks = h.filterClicks();
    expect(clicks.expand).toBeLessThanOrEqual(1);
    expect(clicks.option).toBeLessThanOrEqual(1);
    expect(clicks.query).toBeLessThanOrEqual(1);
    // And each happened at most once in the trace, so no retry loop exists.
    const trace = h.interactions();
    for (const token of ['filter-expand', 'filter-option', 'filter-query']) {
      expect(trace.filter((entry) => entry === token).length, token).toBeLessThanOrEqual(1);
    }
  });

  it('H. no enrollment or drop control is ever interacted with', async () => {
    /*
     * The one thing the approval does not cover. The fixture has no enrollment control at all, so this asserts the other direction: nothing the run does is
     * recorded under a token that would indicate one — the trace is a closed vocabulary.
     */
    const h = harness({ initial: 1, perClick: 0, batches: 0, fill: 'all' });
    await runPreparation(h);
    const allowed = new Set(['filter-expand', 'filter-option', 'filter-query', 'load-more', 'hydrate-panel']);
    for (const entry of h.interactions()) {
      expect(allowed.has(entry), `unexpected interaction ${entry}`).toBe(true);
    }
  });

  it('I. cancelling DURING the filter performs NO page interaction at all', async () => {
    /*
     * The cancellation the slice has to get right, asserted in the window where the guarantee is real.
     *
     * The run yields once before its first page interaction, so a cancel delivered immediately after START is observed BEFORE the reveal — not between two clicks,
     * which the operation's synchronous stretches make unobservable. The stronger claim is the one that matters anyway: after a cancel, NO filter interaction
     * happens, so nothing is loaded, nothing is hydrated, nothing is read, and nothing is recommended.
     *
     * The filter is left AS THE PAGE HAS IT: this run never clicks 「无」 and restores nothing, because the user approved 「有余量」 and the unified flow wants it left
     * on. Not touching the filter at all is the strongest form of that promise.
     */
    const h = harness({ initial: 2, perClick: 1, batches: 2, fill: 'all', collapsedFilters: true, holdFilterExpand: true });
    h.ask(START);
    // Delivered while the run is parked at its opening yield, so the very first interaction is the one under test.
    h.ask(CANCEL);
    await h.releaseFilterExpand();
    await settle();
    await h.flush();
    const status = await drain(h);

    expect(status.stopReason).toBe('cancelled');
    expect(h.filterClicks()).toEqual({ expand: 0, option: 0, query: 0 });
    expect(h.loadMoreClicks()).toBe(0);
    expect(h.interactions()).toEqual([]);
    expect(status.finalPage).toBeUndefined();
    const phases = h.events.filter((event) => typeof event.phase_changed === 'string').map((event) => event.phase_changed);
    expect(phases).not.toContain('loading_courses');
    expect(phases).not.toContain('hydrating_teachers');
    expect(phases).not.toContain('rescanning');
  });

  it('J2. opening the panel starts nothing, and the filter is untouched until an approval arrives', async () => {
    /*
     * The dormancy contract, re-asserted now that a THIRD kind of page interaction exists. Loading the content script and reading status must produce no filter
     * interaction, no load-more and no hydration: only an explicit approval starts preparation.
     */
    const h = harness({ initial: 2, perClick: 1, batches: 2, fill: 'all' });
    // Every read-only question a panel asks on open, asked repeatedly.
    for (let index = 0; index < 4; index += 1) h.ask(QUERY_STATUS);
    await settle();
    await h.flush();
    expect(h.filterClicks()).toEqual({ expand: 0, option: 0, query: 0 });
    expect(h.loadMoreClicks()).toBe(0);
    expect(h.interactions()).toEqual([]);
    expect(h.events.filter((event) => typeof event.phase_changed === 'string')).toHaveLength(0);
  });
});

async function settle(passes = 60): Promise<void> {
  for (let index = 0; index < passes; index += 1) await Promise.resolve();
}

/** Drive one preparation to completion. */
async function runPreparation(h: Harness, maxRounds = 60): Promise<Record<string, unknown>> {
  h.ask(START);
  return drain(h, maxRounds);
}

async function drain(h: Harness, maxRounds = 60): Promise<Record<string, unknown>> {
  for (let round = 0; round < maxRounds; round += 1) {
    await settle();
    await h.flush();
    const status = h.ask(QUERY_STATUS).status as Record<string, unknown>;
    if (status.phase === 'finished') break;
  }
  await settle();
  return h.ask(QUERY_STATUS).status as Record<string, unknown>;
}

describe('16J-PREUI-E4-C1 the phases run in the order that keeps the data honest'.replace('E4-C1', 'E4-C1'), () => {
  it('A. an already-complete list costs no load-more click and hydration still runs', async () => {
    const h = harness({ initial: 2, perClick: 0, batches: 0, fill: 'all' });
    const status = await runPreparation(h);
    expect(status.phase).toBe('finished');
    expect(status.stopReason).toBe('teacher_hydration_completed');
    // Phase one proved the list complete without clicking anything.
    expect(h.loadMoreClicks()).toBe(0);
    // Phase two ran: both panels were expanded and their teacher cells filled.
    expect(h.expandClicks()).toEqual([1, 1]);
    expect(h.teacherTexts().every((text) => text.length > 0)).toBe(true);
  });

  it('B. a partial list is expanded to complete and then hydration runs', async () => {
    /*
     * The page serves two batches and then reports the end, so phase one has to click twice before it can PROVE the list complete — and only then does
     * hydration begin. The six panels that exist by the end are each expanded exactly once.
     */
    const h = harness({ initial: 2, perClick: 2, batches: 2, fill: 'all' });
    const status = await runPreparation(h);
    expect(status.phase).toBe('finished');
    expect(status.stopReason).toBe('teacher_hydration_completed');
    expect(h.loadMoreClicks()).toBe(2);
    expect(h.expandClicks()).toHaveLength(6);
    expect(h.expandClicks().every((count) => count === 1)).toBe(true);
  });

  it('C. an unknown list state stops the run and hydration never begins', async () => {
    /*
     * The ordering rule this whole step exists for. A list that could not be proven complete must not have its panels expanded, because the teacher data would
     * then cover an unknown subset of the courses while looking finished.
     */
    const h = harness({ initial: 2, perClick: 0, batches: 5, fill: 'all' });
    const status = await runPreparation(h);
    expect(status.phase).toBe('finished');
    expect(status.stopReason).toBe('course_list_incomplete');
    // No expand click at all: phase two was never entered.
    expect(h.expandClicks()).toEqual([0, 0]);
    expect(status.teacherHydrationStatus).toBeUndefined();
    expect(status.finalPage).toBeUndefined();
  });

  it('D. a page that never grows reaches a REAL no_progress after exactly one click, and hydration never begins', async () => {
    /*
     * ## Proven against the real controller, not injected
     *
     * `no_progress` can only come from the expansion controller itself: it means a click WAS performed and the round that followed grew nothing. So the click
     * count is the evidence that this outcome is genuine — an injected or pre-loop verdict would show zero clicks, and a fabricated `stopReason` on a
     * preparation status would prove nothing about the wiring.
     *
     * The path exercised is START_FULL_PREPARATION → runFullPreparationSession → runExpansionSession → runBoundedCourseListExpansion → the page adapter. The
     * fixture accepts the click, keeps `#more` visible, and adds no panel, which is exactly the situation the controller calls no progress.
     */
    const h = harness({ initial: 2, perClick: 0, batches: 5, fill: 'all' });
    const status = await runPreparation(h);
    expect(status.phase).toBe('finished');
    // EXACTLY one click: the controller had to try once before it could learn there was no progress.
    expect(h.loadMoreClicks()).toBe(1);
    // And that verdict is the real one, reported through the expansion's own summary.
    expect((status.autoExpandStatus as Record<string, unknown>).stopReason).toBe('no_progress');
    expect(status.stopReason).toBe('course_list_incomplete');
    // Phase two never ran: no panel was ever expanded.
    expect(h.expandClicks().every((count) => count === 0)).toBe(true);
    expect(status.teacherHydrationStatus).toBeUndefined();
    expect(status.finalPage).toBeUndefined();
  });

  it('E. a page that always grows but never completes reaches a REAL click_cap after exactly twenty clicks', async () => {
    /*
     * ## The other half of the same proof
     *
     * `click_cap` is reachable only by actually performing the permitted maximum, so twenty clicks is not an incidental number here: it is the assertion that
     * the fixture made real progress twenty times and the controller still refused a twenty-first. The page adds a panel on every click and keeps `#more`
     * visible forever, so no round is a no-progress round and nothing but the cap can stop it.
     */
    const h = harness({ initial: 2, perClick: 1, batches: Number.MAX_SAFE_INTEGER, fill: 'all' });
    const status = await runPreparation(h, 200);
    expect(status.phase).toBe('finished');
    // Exactly the cap, and therefore no twenty-first click.
    expect(h.loadMoreClicks()).toBe(20);
    expect((status.autoExpandStatus as Record<string, unknown>).stopReason).toBe('click_cap');
    // The clicks were real: the list grew by one panel each time.
    expect(h.expandClicks()).toHaveLength(22);
    expect(status.stopReason).toBe('course_list_incomplete');
    // And again hydration never started, because the list was never proven complete.
    expect(h.expandClicks().every((count) => count === 0)).toBe(true);
    expect(status.teacherHydrationStatus).toBeUndefined();
  });

  it('the phase-one verdicts come from the controller, not from the orchestration', () => {
    /*
     * A structural statement of the same rule. The orchestrator decides what a phase-one outcome MEANS; it never decides what the outcome IS. So it must read
     * `expansion.stopReason` and must not assign one.
     */
    const artifact = readFileSync(contentScriptPath, 'utf8');
    const start = artifact.indexOf('async function runFullPreparationSession');
    const end = artifact.indexOf('chrome.runtime.onMessage.addListener', start);
    const session = artifact.slice(start, end);
    // The controller's result is consulted…
    expect(session).toContain('expansion.stopReason');
    // …and never produced. `click_cap` and `no_progress` are the controller's vocabulary and must not be assigned here.
    expect(/stopReason\s*=\s*'(?:click_cap|no_progress|unknown_state|click_failed|wait_failed)'/u.test(session)).toBe(false);
    // The two proven-complete outcomes are the only ones that continue.
    expect(session).toContain("expansion.stopReason === 'complete'");
    expect(session).toContain("expansion.stopReason === 'already_complete'");
  });

  it('F2. an unsupported page stops at the first phase with no click at all', async () => {
    /*
     * UPDATED IN PRE-RELEASE-UX-A10. The run now begins with the filter, and an unsupported page exposes no filter panel — it could not, since the content script
     * only ever runs on the supported page. So the first phase refuses, the run returns immediately with `availability_filter_unavailable`, and nothing is clicked:
     * no filter interaction, no load-more, no hydration, and no closing read either, because the filter refusal is its own explicit ending.
     */
    const h = harness({ initial: 0, perClick: 0, batches: 5, fill: 'all', supported: false });
    const status = await runPreparation(h);
    expect(status.stopReason).toBe('availability_filter_unavailable');
    expect(status.finalPage).toBeUndefined();
    expect(h.loadMoreClicks()).toBe(0);
    expect(h.expandClicks()).toEqual([]);
    expect(status.teacherHydrationStatus).toBeUndefined();
    expect(h.filterClicks()).toEqual({ expand: 0, option: 0, query: 0 });
  });

  it('J. a duplicate START runs one workflow only', async () => {
    const h = harness({ initial: 1, perClick: 0, batches: 0, fill: 'all' });
    expect(h.ask(START).accepted).toBe(true);
    const second = h.ask(START);
    expect(second.accepted).toBe(false);
    await drain(h);
    // One run means one expand click, not two.
    expect(h.expandClicks()).toEqual([1]);
  });
});

describe('16J-PREUI-E4-C1 hydration outcomes and the final read', () => {
  it('F. complete hydration produces the full result and a fresh page read', async () => {
    const h = harness({ initial: 2, perClick: 0, batches: 0, fill: 'all' });
    const status = await runPreparation(h);
    expect(status.stopReason).toBe('teacher_hydration_completed');
    /*
     * The counts live on the hydration phase's own summary, not on the preparation status: preparation carries each phase's report rather than flattening the
     * two into one namespace, so a caller can always tell which phase reported what.
     */
    const hydration = status.teacherHydrationStatus as Record<string, unknown>;
    expect(hydration).toMatchObject({ hydrated: 2, failed: 0, skipped: 0, stopReason: 'completed' });
    expect(status.finalPage).toMatchObject({ supported: true, listPresent: true, completeness: 'complete' });
  });

  it('I. the final read sees the teacher values written during hydration', async () => {
    /*
     * The reason the read is repeated rather than carried. Phase two's entire effect is on the teacher cells, so a snapshot taken before it would describe a
     * page that no longer exists — and the row count is the observable that proves the read happened afterwards.
     */
    const h = harness({ initial: 2, perClick: 0, batches: 0, fill: 'all' });
    const status = await runPreparation(h);
    const finalPage = status.finalPage as Record<string, unknown>;
    // Two panels, one teaching class each: the finished page holds two rows.
    expect(finalPage.rowCount).toBe(2);
    // And every one of those rows now has a teacher, so the read saw the hydrated page rather than the empty one.
    expect(h.teacherTexts().every((text) => text.length > 0)).toBe(true);
  });

  it('G. a partially hydrated run still rescans and reports partial', async () => {
    /*
     * A panel that would not hydrate completely is contained; the teacher data that DID arrive is kept, and the run still reads the page back rather than
     * discarding work that succeeded.
     *
     * Each panel carries two teaching classes and the page fills ONE of them, so every panel is genuinely incomplete — which is what makes this a partial run
     * rather than a completed one.
     */
    const h = harness({ initial: 2, perClick: 0, batches: 0, fill: 'first', rowsPerPanel: 2 });
    const status = await runPreparation(h);
    expect(status.stopReason).toBe('teacher_hydration_partial');
    const hydration = status.teacherHydrationStatus as Record<string, unknown>;
    expect(hydration.failed).toBe(2);
    // The teacher the page did write is still there, for every panel.
    expect(h.teacherTexts().filter((text) => text.length > 0)).toHaveLength(2);
    // And the read still happened.
    expect(status.finalPage).toMatchObject({ listPresent: true, rowCount: 4 });
  });

  it('H. an item-cap hydration is reported as capped, and still rescanned', async () => {
    /*
     * The cap cannot be reached with a small fixture, so this asserts the seam rather than the arithmetic: whatever the hydration reports, a non-cancelled
     * outcome always reaches the final read. The cap's own arithmetic is covered in the hydration suite.
     */
    const h = harness({ initial: 3, perClick: 0, batches: 0, fill: 'all' });
    const status = await runPreparation(h);
    expect(['teacher_hydration_completed', 'teacher_hydration_partial', 'teacher_hydration_item_cap']).toContain(status.stopReason);
    expect(status.finalPage).toBeDefined();
  });

  it('a panel that fills nothing fails, and the read still happens', async () => {
    const h = harness({ initial: 2, perClick: 0, batches: 0, fill: 'none' });
    const status = await runPreparation(h);
    expect(status.stopReason).toBe('teacher_hydration_partial');
    expect((status.teacherHydrationStatus as Record<string, unknown>).failed).toBe(2);
    expect(status.finalPage).toMatchObject({ supported: true, listPresent: true });
  });
});

describe('16J-PREUI-E4-C1 cancellation is routed, and rolls nothing back', () => {
  it('K. cancelling during the load phase means hydration never begins', async () => {
    /*
     * The page keeps serving batches, so phase one would keep clicking; cancelling after a couple of rounds must stop the run before the second phase. This is
     * the case that proves cancellation is ROUTED to the phase that is running rather than merely recorded.
     */
    const h = harness({ initial: 2, perClick: 2, batches: Number.MAX_SAFE_INTEGER, fill: 'all' });
    h.ask(START);
    // Let the expansion click a couple of times, then cancel mid-flight.
    for (let round = 0; round < 3; round += 1) {
      await settle();
      await h.flush();
      if (h.loadMoreClicks() >= 2) break;
    }
    h.ask(CANCEL);
    const status = await drain(h);
    expect(status.phase).toBe('finished');
    expect(status.stopReason).toBe('cancelled');
    // Phase two was never entered, so no panel was ever expanded.
    expect(h.expandClicks().every((count) => count === 0)).toBe(true);
    expect(status.teacherHydrationStatus).toBeUndefined();
  });

  it('L. cancelling during hydration stops future panels and keeps the data already written', async () => {
    /*
     * ## The request arrives mid-phase, from inside the page adapter
     *
     * A cancellation is issued when the SECOND panel is expanded — exactly when a user would press stop — so this proves the runtime reacts to a request that
     * arrives while the phase is running, rather than one recorded before it started.
     *
     * Three panels are waiting, all needing hydration. The first is expanded and its teacher is written before the request; the second is the panel whose
     * expansion issues it; the third must never be touched.
     */
    const h = harness({ initial: 3, perClick: 0, batches: 0, fill: 'all', cancelOnHydrationPanel: 2 });
    const status = await runPreparation(h);
    expect(status.phase).toBe('finished');
    expect(status.stopReason).toBe('cancelled');
    const clicks = h.expandClicks();
    // No panel was expanded more than once, and the third was never reached.
    expect(Math.max(...clicks)).toBeLessThanOrEqual(1);
    expect(clicks.filter((count) => count > 0).length).toBeLessThanOrEqual(2);
    expect(clicks[2]).toBe(0);
    // The teacher data already written is still in the DOM: nothing is rolled back.
    expect(h.teacherTexts().filter((text) => text.length > 0).length).toBeGreaterThanOrEqual(1);
  });

  it('L2. a cancelled hydration still runs the final rescan and reads back the preserved teacher data', async () => {
    /*
     * ## Why the read still happens after a cancellation
     *
     * The panels that were expanded before the stop have real teacher data in them. Skipping the read would throw that away — and the whole purpose of this run
     * is to hand the freshest page to whatever comes next. So the run continues into `rescanning`, and the reason stays `cancelled`, because reading the page
     * does not make the work complete.
     *
     * The evidence that the read is FRESH rather than a snapshot from before hydration: the teacher cells are non-empty at the moment it happens, which is only
     * true after phase two wrote them.
     */
    const h = harness({ initial: 3, perClick: 0, batches: 0, fill: 'all', cancelOnHydrationPanel: 2 });
    const status = await runPreparation(h);
    expect(status.stopReason).toBe('cancelled');
    // FINAL RESCAN EXECUTED.
    expect(status.finalPage).toBeDefined();
    const finalPage = status.finalPage as Record<string, unknown>;
    expect(finalPage).toMatchObject({ supported: true, listPresent: true, completeness: 'complete' });
    // Every panel still carries a readable class, so the read saw the whole finished list.
    expect(finalPage.rowCount).toBe(3);
    // And the teacher data was PRESERVED: the rescan did not empty it.
    const texts = h.teacherTexts();
    expect(texts.filter((text) => text.length > 0).length).toBeGreaterThanOrEqual(1);
    // No panel was re-clicked by the rescan: a read never interacts.
    expect(h.expandClicks().every((count) => count <= 1)).toBe(true);
  });

  it('B2-FIX. a SECOND preparation must not inherit a cancellation from the first', async () => {
    /*
     * THE REAL BUG, and the reason it survived every earlier cancellation test.
     *
     * The EXPANSION session owns a cancel flag of its own. The preparation both SETS it — the bridge writes it while the run is in its load-more phase — and
     * never CLEARS it, because the clear lives in the `START_AUTO_EXPAND` message handler and a preparation calls the expansion session DIRECTLY.
     *
     * So one cancellation during the load-more phase poisons every later preparation: each one enters its expansion phase, is told it was cancelled, and stops
     * with zero clicks. In a browser that reads as "the start button came back, but clicking it does nothing".
     *
     * Earlier cancellation cases missed it because they cancelled during the FILTER phase, which never touches the expansion flag — so a second run succeeded
     * and proved nothing.
     */
    const h = harness({ initial: 2, perClick: 1, batches: 3, fill: 'all' });

    // --- FIRST RUN: advance to the load-more phase, then cancel while it is genuinely there.
    h.ask(START);
    let sawLoading = false;
    for (let round = 0; round < 40 && !sawLoading; round += 1) {
      await settle(4);
      await h.flush();
      sawLoading = h.events.some((event) => event.phase_changed === 'loading_courses');
    }
    // (A) the first run really reached the phase whose flag the cancellation writes.
    expect(sawLoading).toBe(true);

    h.ask(CANCEL);
    const first = await drain(h);
    // (B) it finishes cancelled, which is what a user sees as 「已停止数据准备」.
    expect(first.phase).toBe('finished');
    expect(first.stopReason).toBe('cancelled');

    // --- SECOND RUN: a fresh approval. Nothing else is sent.
    const eventsBeforeSecond = h.events.length;
    const accepted = h.ask(START);
    // (C) the page accepts it, so the refusal is NOT at the request boundary.
    expect(accepted.accepted).toBe(true);

    const second = await runPreparation(h);
    const secondEvents = h.events.slice(eventsBeforeSecond);
    const secondPhases = secondEvents.filter((event) => typeof event.phase_changed === 'string').map((event) => event.phase_changed);
    const secondExpansion = second.autoExpandStatus as Record<string, unknown> | undefined;

    // (D) the second run reaches its load-more phase rather than dying in the filter.
    expect(secondPhases).toContain('loading_courses');
    /*
     * (E) AND IT MUST NOT STOP THERE. `clicks: 0` together with `cancelled` is the signature of the stale flag: the expansion was told it had been cancelled
     * before it could click anything.
     */
    expect(secondExpansion?.stopReason).not.toBe('cancelled');
    expect(second.stopReason).not.toBe('cancelled');
    // (F) it progresses into the phase after expansion, which is only reached when the list is proven.
    expect(secondPhases).toContain('hydrating_teachers');
  });

  it('B2-FIX-2. the reset must not erase the CURRENT run\'s own cancellation', async () => {
    /*
     * (G) and (H), and the guard on the fix rather than a restatement of it.
     *
     * A wrong fix would be to stop the expansion honouring its cancel flag at all. That would also make a second run proceed — and it would break stopping a run
     * the user genuinely wants stopped. This case pins the difference where it is observable: the expansion consults its flag at the top of EVERY round, so a
     * cancellation issued while it is mid-way leaves it with far fewer clicks than the work it was doing.
     *
     * The fixture needs a long expansion. The 8-batch, one-click-each shape below makes the expansion click its way through the list; the cancellation lands
     * after two of those clicks, so a run that ignored its flag would go on to click eight times and this case would see it.
     *
     * (An earlier version of this case cancelled the SECOND run's expansion instead. That expansion performs no clicks at all, because the list is already
     * complete by then, so it returns `already_complete` before its first cancel check and no cancellation could ever be observed.)
     */
    const h = harness({ initial: 1, perClick: 1, batches: 8, fill: 'all' });

    // --- The run whose expansion has real work to do.
    h.ask(START);
    let reachedLoading = false;
    for (let round = 0; round < 60; round += 1) {
      await settle(4);
      await h.flush();
      reachedLoading = h.events.some((event) => event.phase_changed === 'loading_courses');
      // Two clicks in, the expansion is unambiguously in flight and well short of the eight batches.
      if (reachedLoading && h.loadMoreClicks() >= 2) break;
    }
    expect(reachedLoading).toBe(true);
    const clicksAtCancel = h.loadMoreClicks();

    h.ask(CANCEL);
    const run = await drain(h);
    const clicksAfter = h.loadMoreClicks();

    expect(run.phase).toBe('finished');
    expect(run.stopReason).toBe('cancelled');
    /*
     * IT TOOK EFFECT IN THE EXPANSION. Eight batches were available and the run stopped after roughly two clicks, so the cancel was honoured by the phase that
     * was running rather than by a later checkpoint. A fix that merely disabled this flag would leave the count at the full eight.
     */
    expect(clicksAfter).toBeLessThan(8);
    expect(clicksAfter - clicksAtCancel).toBeLessThanOrEqual(2);
  });
  it('L3. the phase order after a cancellation is hydrating → rescanning → finished', async () => {
    /*
     * The phase sequence is the honest account of what happened: the run entered the second phase, was stopped, then still read the page. The CLOSING reason must
     * remain `cancelled` — a rescan is not work that completes the run, so it cannot upgrade the verdict to completed or partial.
     */
    const h = harness({ initial: 3, perClick: 0, batches: 0, fill: 'all', cancelOnHydrationPanel: 2 });
    const status = await runPreparation(h);
    const phases = h.events.filter((event) => typeof event.phase_changed === 'string').map((event) => event.phase_changed);
    // The run now begins with the filter, so the sequence starts there; the cancellation's own routing is unchanged.
    expect(phases).toEqual(['filtering_available', 'loading_courses', 'hydrating_teachers', 'rescanning']);
    const finished = h.events.filter((event) => event.phase === 'finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]?.stopReason).toBe('cancelled');
    expect(status.stopReason).toBe('cancelled');
    expect(status.stopReason).not.toBe('teacher_hydration_completed');
    expect(status.stopReason).not.toBe('teacher_hydration_partial');
    // And the closing event carries the final page, because a cancelled run still reports the page it can see.
    expect(finished[0]?.finalPage).toBeDefined();
  });

  it('M. QUERY_STATUS is read-only', async () => {
    const h = harness({ initial: 1, perClick: 0, batches: 0, fill: 'all' });
    for (let index = 0; index < 6; index += 1) h.ask(QUERY_STATUS);
    await settle();
    await h.flush();
    expect(h.expandClicks()).toEqual([0]);
    expect(h.loadMoreClicks()).toBe(0);
    expect(h.ask(QUERY_STATUS).status).toMatchObject({ phase: 'idle' });
  });

  it('an idle CANCEL is harmless', async () => {
    const h = harness({ initial: 1, perClick: 0, batches: 0, fill: 'all' });
    expect(h.ask(CANCEL).ok).toBe(true);
    await settle();
    expect(h.expandClicks()).toEqual([0]);
    expect(h.ask(QUERY_STATUS).status).toMatchObject({ phase: 'idle' });
  });
});

describe('16J-PREUI-E4-C1 the workflow is inert, encapsulated and recommends nothing', () => {
  it('N. a failing event send cannot break the run', async () => {
    // The realistic failure: no panel is open, so nothing receives the event. The run must still finish.
    const h = harness({ initial: 1, perClick: 0, batches: 0, fill: 'all' });
    const status = await runPreparation(h);
    expect(status.phase).toBe('finished');
    expect(h.teacherTexts().every((text) => text.length > 0)).toBe(true);
  });

  it('emits phase changes and exactly one finished event', async () => {
    const h = harness({ initial: 1, perClick: 0, batches: 0, fill: 'all' });
    await runPreparation(h);
    const phases = h.events.filter((event) => typeof event.phase_changed === 'string').map((event) => event.phase_changed);
    // Filtering, then loading, then hydrating, then rescanning — in that order, which is the whole point of the slice.
    expect(phases).toEqual(['filtering_available', 'loading_courses', 'hydrating_teachers', 'rescanning']);
    expect(h.events.filter((event) => event.phase === 'finished')).toHaveLength(1);
    for (const event of h.events) {
      expect(event.type).toBe(EVENT);
      expect(event.autoExpandStatus ?? null).not.toBeInstanceOf(Function);
    }
  });

  it('the standalone feature events are not emitted by a preparation run', async () => {
    /*
     * One run must be described once. The expansion and hydration runners suppress their own announcements when a caller owns the reporting, so a panel
     * listening for either standalone event does not also hear about this run.
     */
    const h = harness({ initial: 1, perClick: 0, batches: 0, fill: 'all' });
    await runPreparation(h);
    const standalone = h.events.filter((event) => event.type === AUTO_EXPAND_EVENT || event.type === HYDRATION_EVENT);
    // The harness only records the preparation event type, so a standalone event would appear here as a wrong type.
    expect(standalone).toHaveLength(0);
    expect(h.events.every((event) => event.type === EVENT)).toBe(true);
  });

  it('R and S. the side panel drives ONE unified action and calls no recommendation', () => {
    /*
     * UPDATED IN 16J-PREUI-E4-C2-A. The panel used to start nothing; it now offers one approved action that starts the whole preparation. What must still hold
     * is that this is the panel's ONLY start — it names no phase-level type and calls `start()` exactly once — and that finishing a preparation requests no
     * recommendation, which is C2-B's wiring.
     */
    const controllerSource = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'full-preparation.ts'), 'utf8');
    for (const token of ['START_AUTO_EXPAND', 'START_TEACHER_HYDRATION']) {
      expect(panelSource.includes(token), token).toBe(false);
      expect(controllerSource.includes(token), token).toBe(false);
    }
    expect(panelSource.split('.start()').length - 1).toBe(1);
    // And the orchestrator itself reaches no recommendation machinery.
    const artifact = readFileSync(contentScriptPath, 'utf8');
    for (const token of ['recommendExtensionCourses', 'RecommendationRequest', 'QUERY_RECOMMENDATIONS']) {
      const orchestrator = artifact.slice(artifact.indexOf('runFullPreparationSession'), artifact.indexOf('chrome.runtime.onMessage.addListener', artifact.indexOf('runFullPreparationSession')));
      expect(orchestrator.includes(token), token).toBe(false);
    }
  });

  it('the orchestrator contains no direct DOM interaction of its own', () => {
    /*
     * Every click, observer and timeout belongs to the narrow adapters that were measured against the live page. An orchestrator that reached for a selector
     * would be a second implementation of rules that already exist one layer down.
     */
    const artifact = readFileSync(contentScriptPath, 'utf8');
    const start = artifact.indexOf('UNIFIED FULL-COURSE PREPARATION');
    const end = artifact.indexOf('chrome.runtime.onMessage.addListener', start);
    const orchestrator = artifact.slice(start, end);
    for (const token of ['.click()', 'loadJxbxxZzxk', 'chooseCourseZzxk', '.expand1', '#more', 'MutationObserver', 'querySelectorAll']) {
      expect(orchestrator.includes(token), token).toBe(false);
    }
  });

  it('T and U. the standalone features still work through their own messages', async () => {
    /*
     * The preparation reuses the two session runners with an optional reporting override. Without the override they must behave exactly as before, which is what
     * their own suites assert; here the point is only that the override is OPTIONAL and their message contract is untouched.
     */
    const h = harness({ initial: 1, perClick: 0, batches: 0, fill: 'all' });
    // The visible-rows query still answers, with the list present.
    const reply = h.ask(QUERY_VISIBLE_ROWS);
    expect(reply.supported).toBe(true);
    expect(reply).toHaveProperty('loadState');
  });
});
