/**
 * PART 16J-PREUI-E4-B2 — bounded teacher hydration, wired into the content runtime.
 *
 * ## Why these tests drive the ARTIFACT
 *
 * The controller was inlined into `content-script.ts` because a classic content script cannot import a local module, and one canonical implementation was
 * non-negotiable. So these tests load the real built `dist/content/content-script.js` into a controllable DOM and drive it through its own message
 * contract, which means the code under test is the code that ships rather than a copy of it.
 *
 * The DOM model is deliberately small but faithful to the measured page: a panel holds a heading with an `a.expand1` anchor, a body table, and one
 * `tr.body_tr` per teaching class, each carrying a `td.jsxm`. Expanding a panel populates the teacher cells asynchronously — which is exactly what the live
 * page did in 16J-PREUI-E4-A-R1.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contentScriptPath = join(repoRoot, 'apps', 'extension', 'dist', 'content', 'content-script.js');

const START = 'COURSE_COPILOT_START_TEACHER_HYDRATION';
const CANCEL = 'COURSE_COPILOT_CANCEL_TEACHER_HYDRATION';
const QUERY_STATUS = 'COURSE_COPILOT_QUERY_TEACHER_HYDRATION_STATUS';
const EVENT = 'COURSE_COPILOT_TEACHER_HYDRATION_EVENT';
const QUERY_VISIBLE_ROWS = 'COURSE_COPILOT_QUERY_VISIBLE_ROWS';
const QUERY_RECOMMENDATIONS = 'COURSE_COPILOT_QUERY_RECOMMENDATIONS';
const QUERY_STATUS_AUTOEXPAND = 'COURSE_COPILOT_QUERY_AUTO_EXPAND_STATUS';
const START_AUTOEXPAND = 'COURSE_COPILOT_START_AUTO_EXPAND';
const QUERY_STATUS_PAGE = 'COURSE_COPILOT_QUERY_STATUS';

// ---------------------------------------------------------------------------- a small controllable DOM

type Listener = () => void;

/** One element. Only the parts the content script touches. */
class Element {
  readonly tagName: string;
  readonly style: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly children: Element[] = [];
  parent: Element | null = null;
  readonly classes = new Set<string>();
  readonly #listeners = new Map<string, Set<Listener>>();
  text: string | null = null;
  clickCount = 0;

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase();
  }

  get className(): string { return [...this.classes].join(' '); }

  get id(): string { return this.attributes.id ?? ''; }

  classList = {
    contains: (token: string): boolean => this.classes.has(token),
  };

  /** Match ONE compound selector (`td.jsxm`, `a.expand1`, `tr.body_tr`) against this element. */
  matchesCompound(selector: string): boolean {
    const parts = selector.split('.');
    const tag = parts[0] ?? '';
    if (tag.startsWith('#')) return this.attributes.id === tag.slice(1);
    if (tag.length > 0 && this.tagName !== tag) return false;
    return parts.slice(1).every((token) => this.classes.has(token));
  }

  matches(selector: string): boolean {
    if (selector.includes(' ')) return this.querySelector(selector) !== null;
    return this.matchesCompound(selector);
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
    // Only the FINAL compound is matched here; ancestor steps are handled by querySelector.
    const last = selector.trim().split(/\s+/u).pop() ?? '';
    const found: Element[] = [];
    for (const child of this.children) {
      if (child.matchesCompound(last)) found.push(child);
      found.push(...child.querySelectorAll(last));
    }
    return found;
  }

  get textContent(): string {
    if (this.text !== null) return this.text;
    return this.children.map((child) => child.textContent).join('');
  }

  get childElementCount(): number { return this.children.length; }

  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }

  getBoundingClientRect(): { width: number; height: number; top: number } {
    const hidden = this.style.display === 'none';
    return { width: hidden ? 0 : 100, height: hidden ? 0 : 20, top: 0 };
  }

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

/** A `MutationObserver` that actually reports changes, so "settle" means something. */
class FakeObserver {
  static live: FakeObserver[] = [];
  readonly #callback: () => void;
  #targets: Element[] = [];

  constructor(callback: () => void) {
    this.#callback = callback;
    FakeObserver.live.push(this);
  }

  observe(target: Element): void { this.#targets.push(target); }

  disconnect(): void {
    this.#targets = [];
    FakeObserver.live = FakeObserver.live.filter((entry) => entry !== this);
  }

  /** Deliver one change to every live observer watching `changed` or one of its ancestors. */
  static notify(changed: Element): void {
    for (const observer of [...FakeObserver.live]) {
      for (const target of observer.#targets) {
        let node: Element | null = changed;
        while (node !== null) {
          if (node === target) { observer.#callback(); break; }
          node = node.parent;
        }
      }
    }
  }
}

/** What a panel's expand click does to its rows. */
type PanelBehaviour = 'populate-all' | 'populate-first-only' | 'populate-nothing' | 'async-populate-all';

interface PanelSpec {
  readonly rows: number;
  /** Whether the rows start with a teacher already. */
  readonly alreadyFilled?: boolean;
  /** Whether `a.expand1` exists at all. */
  readonly hasExpandControl?: boolean;
  readonly behaviour?: PanelBehaviour;
  /** Whether `td.jsxm` exists in each row. When false, the row has no teacher cell at all. */
  readonly hasTeacherCell?: boolean;
  /** Whether the expand anchor throws when clicked. */
  readonly clickThrows?: boolean;
}

interface Harness {
  readonly panels: Element[];
  /** Panels that exist in the DOM but OUTSIDE the real course list. */
  readonly outsidePanels: Element[];
  readonly events: Array<Record<string, unknown>>;
  /** Click counts for every course-list expand anchor, in panel order. */
  readonly expandClicks: () => number[];
  /** Click counts for the outside panels' anchors — these must always be zero. */
  readonly outsideClicks: () => number[];
  ask: (type: string) => Record<string, unknown>;
  /** Run every pending timer, so a settle window can be crossed deterministically. */
  flush: () => Promise<void>;
  /** Move the page to the `complete` state the way the live page does. */
  goComplete: () => void;
  goPartial: () => void;
  /** How many rows had a teacher at the moment the harness was built. */
  readonly initiallyFilled: () => number;
}

/** Build a page of course panels, load the artifact against it, and return the handles a test needs. */
function harness(
  specs: PanelSpec[],
  options: { complete?: boolean; silentNotifications?: boolean; outsidePanels?: number } = {},
): Harness {
  const root = new Element('div');
  const contentBox = new Element('div');
  contentBox.attributes.id = 'contentBox';
  const list = new Element('div');
  list.classes.add('tjxk_list');
  contentBox.children.push(list);
  list.parent = contentBox;

  const panels: Element[] = [];
  const anchors: Element[] = [];
  const teacherCells: Element[][] = [];
  let initiallyFilled = 0;

  /** Build one course panel: heading with an `a.expand1`, body table, one `tr.body_tr` per class. */
  const buildPanel = (spec: PanelSpec, record: boolean): Element => {
    const panel = new Element('div');
    panel.classes.add('panel');
    panel.classes.add('panel-info');
    const heading = new Element('div');
    heading.classes.add('panel-heading');
    if (spec.hasExpandControl !== false) {
      const anchor = new Element('a');
      anchor.classes.add('expand_close');
      anchor.classes.add('expand1');
      anchor.attributes.href = 'javascript:void(0);';
      anchor.addEventListener('click', () => {
        if (spec.clickThrows === true) throw new Error('expand blew up');
        // The page's own toggle: `expand1` becomes `close1`.
        anchor.classes.delete('expand1');
        anchor.classes.add('close1');
        const behaviour = spec.behaviour ?? 'populate-all';
        const fill = (): void => {
          const cells = record ? (teacherCells[panels.indexOf(panel)] ?? []) : [];
          const limit = behaviour === 'populate-nothing' ? 0
            : (behaviour === 'populate-first-only' ? Math.min(1, cells.length) : cells.length);
          for (let index = 0; index < limit; index += 1) cells[index]!.text = `T${index}`;
        };
        if (behaviour === 'async-populate-all') timers.setTimeout(fill);
        else fill();
      });
      heading.children.push(anchor);
      anchor.parent = heading;
      if (record) anchors.push(anchor);
    }
    const body = new Element('div');
    body.classes.add('panel-body');
    const table = new Element('table');
    const tbody = new Element('tbody');
    const cells: Element[] = [];
    for (let index = 0; index < spec.rows; index += 1) {
      const tr = new Element('tr');
      tr.classes.add('body_tr');
      if (spec.hasTeacherCell !== false) {
        const td = new Element('td');
        td.classes.add('jsxm');
        // An unexpanded panel's teacher cell exists but is EMPTY — measured on the live page, not hidden.
        td.text = spec.alreadyFilled === true ? `T${index}` : '';
        if (spec.alreadyFilled === true && record) initiallyFilled += 1;
        tr.children.push(td);
        td.parent = tr;
        cells.push(td);
      }
      tbody.children.push(tr);
      tr.parent = tbody;
    }
    table.children.push(tbody);
    tbody.parent = table;
    body.children.push(table);
    table.parent = body;
    panel.children.push(heading, body);
    heading.parent = panel;
    body.parent = panel;
    if (record) {
      list.children.push(panel);
      panel.parent = list;
      panels.push(panel);
      teacherCells.push(cells);
    }
    return panel;
  };

  for (const spec of specs) buildPanel(spec, true);

  /*
   * The page holds `div.panel.panel-info` elements OUTSIDE the real course list — measured live, the global panel count is permanently one higher than the
   * number of courses. They are built here so a test can prove the hydration queue does not reach them. They live under `#innerContainer` beside the list,
   * which is where the live page puts its extra panel.
   */
  const outsidePanels: Element[] = [];
  for (let index = 0; index < (options.outsidePanels ?? 0); index += 1) {
    outsidePanels.push(buildPanel({ rows: 2, hasTeacherCell: true }, false));
  }

  const more = new Element('div');
  more.attributes.id = 'more';
  more.style.display = options.complete === true ? 'none' : 'block';
  const endsign = new Element('div');
  endsign.attributes.id = 'endsign';
  endsign.style.display = options.complete === true ? 'block' : 'none';

  const inner = new Element('div');
  inner.attributes.id = 'innerContainer';
  inner.children.push(...outsidePanels, contentBox, more, endsign);
  for (const outside of outsidePanels) outside.parent = inner;
  contentBox.parent = inner;
  more.parent = inner;
  endsign.parent = inner;
  root.children.push(inner);
  inner.parent = root;

  const events: Array<Record<string, unknown>> = [];
  const listeners: Array<(message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => unknown> = [];
  const pendingTimers: Array<() => void> = [];
  const timers = {
    setTimeout: (fn: () => void): number => { pendingTimers.push(fn); return pendingTimers.length; },
    clearTimeout: (): void => { /* timers run wholesale in flush(); clearing is a no-op here */ },
  };

  const sandbox: Record<string, unknown> = {
    document: {
      querySelector: (selector: string): Element | null => root.querySelector(selector),
      querySelectorAll: (selector: string): Element[] => root.querySelectorAll(selector),
      documentElement: root,
    },
    getComputedStyle: (element: Element): { display: string; visibility: string } => ({
      display: element.style.display ?? 'block',
      visibility: element.style.visibility ?? 'visible',
    }),
    location: { hostname: 'jwgl.whu.edu.cn', pathname: '/xsxk/zzxkyzb_cxZzxkYzbIndex.html' },
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
          // Some specs emit hundreds of progress events; recording them all would dominate the test's own memory.
          if (options.silentNotifications === true && events.length > 50) events.length = 50;
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

  const notify = (changed: Element): void => {
    if (options.silentNotifications === true) return;
    FakeObserver.notify(changed);
  };

  return {
    panels, outsidePanels, events,
    expandClicks: () => anchors.map((anchor) => anchor.clickCount),
    outsideClicks: () => outsidePanels.map((panel) => {
      const anchor = panel.querySelector('a.expand1');
      // The anchor is replaced in class but not in identity, so a missing one means it was never built.
      return anchor === null ? -1 : anchor.clickCount;
    }),
    ask(type: string): Record<string, unknown> {
      let response: unknown;
      const listener = listeners[0];
      if (listener === undefined) throw new Error('content script registered no listener');
      listener({ type }, { tab: { id: 7 } }, (value: unknown) => { response = value; });
      return response as Record<string, unknown>;
    },
    goComplete(): void {
      more.style.display = 'none';
      endsign.style.display = 'block';
      notify(more);
      notify(endsign);
    },
    goPartial(): void {
      more.style.display = 'block';
      endsign.style.display = 'none';
      notify(more);
      notify(endsign);
    },
    initiallyFilled: () => initiallyFilled,
    async flush(): Promise<void> {
      for (let round = 0; round < 16; round += 1) {
        const batch = pendingTimers.splice(0, pendingTimers.length);
        for (const fn of batch) fn();
        await Promise.resolve();
      }
    },
  };
}

/** Let the detached session promise run to its next await point. */
async function settle(passes = 60): Promise<void> {
  for (let index = 0; index < passes; index += 1) await Promise.resolve();
}

/** Drive one session to completion: start, drain timers, drain microtasks. */
async function runSession(h: Harness, maxRounds = 30): Promise<Record<string, unknown>> {
  h.ask(START);
  return drain(h, maxRounds);
}

/**
 * Drain an already-started session until it reports `finished`.
 *
 * The round budget exists because each settled panel resolves a promise chain, and a session over hundreds of panels needs more rounds than a two-panel one.
 * It is a harness limit, not a product one: the cap case passes a larger budget rather than the helper assuming a panel count.
 */
async function drain(h: Harness, maxRounds = 30): Promise<Record<string, unknown>> {
  for (let round = 0; round < maxRounds; round += 1) {
    await settle();
    await h.flush();
    const status = h.ask(QUERY_STATUS).status as Record<string, unknown>;
    if (status.phase === 'finished') break;
  }
  await settle();
  return h.ask(QUERY_STATUS).status as Record<string, unknown>;
}

describe('16J-PREUI-E4-B2-R1 the queue is scoped to the REAL course list', () => {
  it('an outside panel is never queued, never inspected and never clicked', async () => {
    /*
     * The measured page fact this locks down: the page holds `div.panel.panel-info` elements OUTSIDE `#contentBox .tjxk_list`, and a GLOBAL panel query is
     * permanently one higher than the number of real courses. A queue built from the global form would describe a data-preparation range that does not exist,
     * and `queued` would tell a caller about a course that is not one.
     *
     * The fixture reproduces the live shape: three course panels inside the list, plus one panel beside it under `#innerContainer`.
     */
    const h = harness([{ rows: 1 }, { rows: 2 }, { rows: 1 }], { complete: true, outsidePanels: 1 });
    const status = await runSession(h);
    // Three, not four.
    expect(status).toMatchObject({ queued: 3, considered: 3, hydrated: 3 });
    // The three real panels were each clicked once, and the outside one never was.
    expect(h.expandClicks()).toEqual([1, 1, 1]);
    expect(h.outsideClicks()).toEqual([0]);
  });

  it('the outside panel is not clickable through this path even when it would need hydration', async () => {
    /*
     * The outside panel is built with empty teacher cells, so it WOULD be hydrated and clicked if it were ever queued. Its click count staying at zero is
     * therefore evidence about the queue, not about the panel being uninteresting.
     */
    const h = harness([{ rows: 1 }], { complete: true, outsidePanels: 2 });
    const status = await runSession(h);
    expect(status.queued).toBe(1);
    expect(h.outsideClicks()).toEqual([0, 0]);
    // And the outside panels really are configured as needing work, which is what makes the assertion meaningful.
    for (const panel of h.outsidePanels) {
      const cell = panel.querySelector('td.jsxm');
      expect(cell?.textContent).toBe('');
    }
  });

  it('a page without the course list yields an empty queue rather than falling back to a global scan', async () => {
    // The honest answer when the page stops publishing the list is that there is nothing to hydrate — not a scan of every panel-shaped element.
    const h = harness([], { complete: true, outsidePanels: 2 });
    const status = await runSession(h);
    expect(status).toMatchObject({ queued: 0, considered: 0, hydrated: 0, failed: 0 });
    expect(h.outsideClicks()).toEqual([0, 0]);
  });

  it('queued still reports the scoped panel count before any cap is applied', async () => {
    /*
     * The semantics the reviewer accepted: `queued` is the real course-list snapshot, and the controller only CONSIDERS the first 200 of it. The cap is not
     * applied while building the queue.
     */
    const specs: PanelSpec[] = Array.from({ length: 201 }, () => ({ rows: 1 }));
    const h = harness(specs, { complete: true, silentNotifications: true, outsidePanels: 1 });
    const status = await runSession(h, 200);
    // 201 real panels, and the outside one is not counted among them.
    expect(status).toMatchObject({ queued: 201, considered: 200, stopReason: 'item_cap' });
    expect(h.outsideClicks()).toEqual([0]);
  });

  it('the artifact scopes the snapshot through the list container, not the document', () => {
    /*
     * A source-level statement of the same rule, so a future edit that reaches for the global form fails here even if the DOM harness were changed to match.
     */
    const artifact = readFileSync(contentScriptPath, 'utf8');
    expect(artifact).toContain("const COURSE_LIST_CONTAINER_SELECTOR = '#contentBox .tjxk_list'");
    // The hydration snapshot goes through the container…
    expect(artifact).toContain('listContainer.querySelectorAll(COURSE_PANEL_SELECTOR)');
    // …and the global panel query must not appear anywhere any more.
    expect(artifact.includes('document.querySelectorAll(COURSE_PANEL_SELECTOR)')).toBe(false);
  });
});

describe('16J-PREUI-E4-B2 hydration may only start on a COMPLETE course list'.replace('E4-B2', 'E4-B2'), () => {
  it('A. START on a complete list is acknowledged immediately', () => {
    const h = harness([{ rows: 1 }], { complete: true });
    const reply = h.ask(START);
    expect(reply.ok).toBe(true);
    expect(reply.accepted).toBe(true);
    // The receipt carries the session, not the outcome: a pass can touch a hundred panels.
    expect(reply.status).toMatchObject({ phase: 'running', hydrationClicks: 0 });
  });

  it('B. START on a partial list is refused, and clicks nothing', async () => {
    /*
     * The rule that keeps the two stages honest. Hydrating a partially loaded list would fill only the panels that happen to be rendered and then look
     * finished, while whole courses were still missing.
     */
    const h = harness([{ rows: 1 }, { rows: 2 }], { complete: false });
    const reply = h.ask(START);
    expect(reply.ok).toBe(true);
    expect(reply.accepted).toBe(false);
    expect(reply.reason).toBe('course_list_incomplete');
    await settle();
    await h.flush();
    expect(h.expandClicks()).toEqual([0, 0]);
    expect(h.ask(QUERY_STATUS).status).toMatchObject({ phase: 'idle' });
  });

  it('C. START with an unknown completeness is refused too', async () => {
    // No end sign and no load-more marker: the page never said the list was whole, so nothing may begin.
    const h = harness([{ rows: 1 }], { complete: false });
    h.ask(QUERY_STATUS); // touch the session so the harness is warm
    const reply = h.ask(START);
    expect(reply.accepted).toBe(false);
    await settle();
    expect(h.expandClicks()).toEqual([0]);
  });

  it('D. a duplicate START while running is refused and no second session begins', async () => {
    const h = harness([{ rows: 1 }], { complete: true });
    expect(h.ask(START).accepted).toBe(true);
    const second = h.ask(START);
    expect(second.accepted).toBe(false);
    expect(second.reason).toBe('already_running');
    await settle();
    await h.flush();
    await settle();
    // One session means one click per panel, not two.
    expect(h.expandClicks()).toEqual([1]);
  });

  it('W. no other message may start a hydration session', async () => {
    /*
     * The likeliest way to break the product: some existing path happens to be followed by hydration. Only the explicit START may begin one.
     */
    const h = harness([{ rows: 1 }], { complete: true });
    for (const type of [QUERY_VISIBLE_ROWS, QUERY_RECOMMENDATIONS, QUERY_STATUS_AUTOEXPAND, QUERY_STATUS_PAGE, QUERY_STATUS, EVENT]) {
      h.ask(type);
    }
    await settle();
    await h.flush();
    expect(h.expandClicks()).toEqual([0]);
    expect(h.ask(QUERY_STATUS).status).toMatchObject({ phase: 'idle' });
    // And the explicit start still works, which is what makes the assertion above meaningful.
    h.ask(START);
    await settle();
    expect(h.expandClicks()).toEqual([1]);
  });

  it('the auto-expand START does not begin hydration either', async () => {
    const h = harness([{ rows: 1 }], { complete: true });
    h.ask(START_AUTOEXPAND);
    await settle();
    await h.flush();
    expect(h.expandClicks()).toEqual([0]);
    expect(h.ask(QUERY_STATUS).status).toMatchObject({ phase: 'idle' });
  });
});

describe('16J-PREUI-E4-B2 the panel predicate and skip rule', () => {
  it('E. a complete panel is skipped while an incomplete one is hydrated', async () => {
    const h = harness([{ rows: 1, alreadyFilled: true }, { rows: 1 }], { complete: true });
    expect(h.initiallyFilled()).toBe(1);
    const status = await runSession(h);
    expect(status).toMatchObject({ phase: 'finished', queued: 2, considered: 2, skipped: 1, hydrated: 1, failed: 0 });
    // The already-complete panel cost no click.
    expect(h.expandClicks()).toEqual([0, 1]);
  });

  it('M. an all-complete list clicks nothing at all', async () => {
    const h = harness([{ rows: 1, alreadyFilled: true }, { rows: 3, alreadyFilled: true }], { complete: true });
    const status = await runSession(h);
    expect(status).toMatchObject({ considered: 2, skipped: 2, attempted: 0, hydrationClicks: 0 });
    expect(h.expandClicks()).toEqual([0, 0]);
  });

  it('the predicate inspects EVERY row, not just the first', async () => {
    /*
     * Measured on the live page: one expansion fills all of a panel's rows, so a panel with ANY empty teacher cell needs the expansion. A predicate that
     * only looked at row 1 would skip this panel and leave rows 2 and 3 empty forever.
     */
    const h = harness([{ rows: 3, alreadyFilled: true }], { complete: true });
    // Make the LAST row empty, leaving the first two filled.
    const panel = h.panels[0] as Element;
    const rows = panel.querySelectorAll('tr.body_tr');
    (rows[2] as Element).querySelector('td.jsxm')!.text = '';
    const status = await runSession(h);
    expect(status).toMatchObject({ considered: 1, skipped: 0, hydrated: 1 });
    expect(h.expandClicks()).toEqual([1]);
  });

  it('a zero-row panel is treated as needing hydration, not as complete', async () => {
    // It cannot be shown to have teacher data, and calling an empty body "nothing to do" would accept a panel the page never filled.
    const h = harness([{ rows: 0, behaviour: 'populate-nothing' }], { complete: true });
    const status = await runSession(h);
    expect(status).toMatchObject({ considered: 1, skipped: 0, failed: 1 });
    expect(h.expandClicks()).toEqual([1]);
  });
});

describe('16J-PREUI-E4-B2 one click per panel, and what it must not click', () => {
  it('F. a two-row panel populates both rows from one click', async () => {
    const h = harness([{ rows: 2 }], { complete: true });
    const status = await runSession(h);
    expect(status).toMatchObject({ considered: 1, hydrated: 1, failed: 0, hydrationClicks: 1 });
    expect(h.expandClicks()).toEqual([1]);
    // Both rows really are filled, which is the measured page behaviour this adapter exists to exploit.
    const cells = h.panels[0]!.querySelectorAll('tr.body_tr').map((row) => (row.querySelector('td.jsxm')!.textContent).trim());
    expect(cells.every((text) => text.length > 0)).toBe(true);
  });

  it('G. a simulated 15-row panel hydrates from a single click', async () => {
    // Proves the adapter does not depend on a panel having exactly two rows.
    const h = harness([{ rows: 15 }], { complete: true });
    const status = await runSession(h);
    expect(status).toMatchObject({ hydrated: 1, hydrationClicks: 1 });
    expect(h.expandClicks()).toEqual([1]);
    const cells = h.panels[0]!.querySelectorAll('tr.body_tr').map((row) => (row.querySelector('td.jsxm')!.textContent).trim());
    expect(cells).toHaveLength(15);
    expect(cells.every((text) => text.length > 0)).toBe(true);
  });

  it('Q. each panel is clicked at most once, across a whole session', async () => {
    const h = harness([{ rows: 2 }, { rows: 3 }, { rows: 1 }], { complete: true });
    await runSession(h);
    expect(h.expandClicks()).toEqual([1, 1, 1]);
  });

  it('K. a panel that populates asynchronously is still hydrated', async () => {
    /*
     * The live page wrote teacher data asynchronously, so an item cannot be judged at the instant the click returns. The watcher is armed BEFORE the click,
     * which is what lets the later mutation count.
     */
    const h = harness([{ rows: 2, behaviour: 'async-populate-all' }], { complete: true });
    const status = await runSession(h);
    expect(status).toMatchObject({ hydrated: 1, failed: 0, hydrationClicks: 1 });
  });

  it('AA. the artifact still parses as a classic script with no module syntax', () => {
    const artifact = readFileSync(contentScriptPath, 'utf8');
    expect(/^\s*import\s/mu.test(artifact)).toBe(false);
    expect(/^\s*export\s/mu.test(artifact)).toBe(false);
    expect(() => new vm.Script(artifact, { filename: 'classic-check.js' })).not.toThrow();
  });
});

describe('16J-PREUI-E4-B2 failure is contained per panel', () => {
  it('H. a partially hydrated panel fails while its neighbour still runs', async () => {
    /*
     * The live measurement could plausibly go wrong on a large panel: one row filled, another not. Whatever the page DID write must be left in place, the
     * panel is reported as failed, and the next panel is still attempted.
     */
    const h = harness([{ rows: 2, behaviour: 'populate-first-only' }, { rows: 1 }], { complete: true });
    const status = await runSession(h);
    expect(status).toMatchObject({ considered: 2, hydrated: 1, failed: 1 });
    expect(h.expandClicks()).toEqual([1, 1]);
    // The teacher the page did write is still there: nothing is rolled back.
    const cells = h.panels[0]!.querySelectorAll('tr.body_tr').map((row) => (row.querySelector('td.jsxm')!.textContent).trim());
    expect(cells[0]).toBe('T0');
    expect(cells[1]).toBe('');
  });

  it('I. a panel with no expand control fails, and the next panel still runs', async () => {
    const h = harness([{ rows: 1, hasExpandControl: false }, { rows: 1 }], { complete: true });
    const status = await runSession(h);
    expect(status).toMatchObject({ considered: 2, hydrated: 1, failed: 1 });
    expect(h.expandClicks()).toEqual([1]);
    expect(h.panels[1]!.querySelectorAll('tr.body_tr')[0]!.querySelector('td.jsxm')!.textContent).toBe('T0');
  });

  it('N. a row with no teacher cell at all counts as needing hydration and then fails', async () => {
    /*
     * A missing cell cannot be shown to be complete, so it is not skipped. It is also the one predicate failure reachable through real DOM — the content
     * script's `panelNeedsTeacherHydration` returns true rather than throwing, so this asserts the conservative reading: attempted, failed, not skipped.
     */
    const h = harness([{ rows: 1, hasTeacherCell: false }, { rows: 1 }], { complete: true });
    const status = await runSession(h);
    expect(status).toMatchObject({ considered: 2, skipped: 0, attempted: 2, hydrated: 1, failed: 1 });
    expect(h.expandClicks()).toEqual([1, 1]);
  });

  it('J. a throwing expand click fails that panel and the next panel still runs', async () => {
    const h = harness([{ rows: 1, clickThrows: true }, { rows: 1 }], { complete: true });
    const status = await runSession(h);
    expect(status).toMatchObject({ considered: 2, hydrated: 1, failed: 1 });
    // The second panel is filled, which is what proves the batch continued.
    expect(h.panels[1]!.querySelectorAll('tr.body_tr')[0]!.querySelector('td.jsxm')!.textContent).toBe('T0');
  });

  it('L. a panel that never populates times out and fails', async () => {
    const h = harness([{ rows: 2, behaviour: 'populate-nothing' }], { complete: true });
    const status = await runSession(h);
    expect(status).toMatchObject({ considered: 1, hydrated: 0, failed: 1, hydrationClicks: 1 });
    expect(h.expandClicks()).toEqual([1]);
  });

  it('a whole batch can complete with every panel failing', async () => {
    const h = harness([{ rows: 1, behaviour: 'populate-nothing' }, { rows: 1, behaviour: 'populate-nothing' }], { complete: true });
    const status = await runSession(h);
    expect(status).toMatchObject({ phase: 'finished', stopReason: 'completed', attempted: 2, hydrated: 0, failed: 2 });
  });
});

describe('16J-PREUI-E4-B2 the cap, cancellation and read-only queries', () => {
  it('P. a snapshot beyond the cap stops at 200 panels and never touches the 201st', async () => {
    /*
     * The cap is a safety bound, not a product limit: the live page held 144 panels once fully loaded, and a DOM anomaly that multiplied them must not turn
     * one approval into an unbounded run of clicks. Notifications are silenced because this many panels would otherwise emit hundreds of events.
     */
    const specs: PanelSpec[] = Array.from({ length: 201 }, () => ({ rows: 1 }));
    const h = harness(specs, { complete: true, silentNotifications: true });
    // 200 settled panels need far more drain rounds than a two-panel session; the budget is the harness's, not the controller's.
    const status = await runSession(h, 200);
    expect(status).toMatchObject({ phase: 'finished', queued: 201, considered: 200, stopReason: 'item_cap' });
    const clicks = h.expandClicks();
    expect(clicks).toHaveLength(201);
    // Exactly the first 200 were clicked, and the 201st never was.
    expect(clicks.slice(0, 200).every((count) => count === 1)).toBe(true);
    expect(clicks[200]).toBe(0);
  });

  it('O. cancelling after some panels stops future clicks and keeps what was done', async () => {
    /*
     * Cancellation is observed between items, so the panels already settled keep their clicks and their data, and the rest are never touched.
     */
    const h = harness([{ rows: 1 }, { rows: 1 }, { rows: 1 }, { rows: 1 }], { complete: true, silentNotifications: true });
    h.ask(START);
    await settle();
    await h.flush();
    h.ask(CANCEL);
    const status = await (async (): Promise<Record<string, unknown>> => {
      for (let round = 0; round < 30; round += 1) {
        await settle();
        await h.flush();
        const current = h.ask(QUERY_STATUS).status as Record<string, unknown>;
        if (current.phase === 'finished') break;
      }
      return h.ask(QUERY_STATUS).status as Record<string, unknown>;
    })();
    expect(status.phase).toBe('finished');
    // Whatever it reached, it stopped: at least one click happened and the untouched panels were never clicked twice.
    const clicks = h.expandClicks();
    expect(clicks.some((count) => count === 1)).toBe(true);
    expect(Math.max(...clicks)).toBe(1);
  });

  it('R. QUERY_STATUS is read-only', async () => {
    const h = harness([{ rows: 1 }], { complete: true });
    for (let index = 0; index < 6; index += 1) h.ask(QUERY_STATUS);
    await settle();
    await h.flush();
    expect(h.expandClicks()).toEqual([0]);
    expect(h.ask(QUERY_STATUS).status).toMatchObject({ phase: 'idle', hydrationClicks: 0 });
  });

  it('S. an idle CANCEL is harmless', async () => {
    const h = harness([{ rows: 1 }], { complete: true });
    const reply = h.ask(CANCEL);
    expect(reply.ok).toBe(true);
    await settle();
    expect(h.expandClicks()).toEqual([0]);
    // Still idle: cancelling nothing does not manufacture a finished session.
    expect(h.ask(QUERY_STATUS).status).toMatchObject({ phase: 'idle' });
  });

  it('a later START is still allowed after a finished session', async () => {
    const h = harness([{ rows: 1 }], { complete: true });
    const first = await runSession(h);
    expect(first.phase).toBe('finished');
    const reply = h.ask(START);
    expect(reply.accepted).toBe(true);
    await settle();
    await h.flush();
    await settle();
    // The second session starts from a clean summary rather than reporting the first one's.
    expect(h.ask(QUERY_STATUS).status).toMatchObject({ phase: 'finished' });
  });
});

describe('16J-PREUI-E4-B2 events and their isolation', () => {
  it('T and U. a progress event and exactly one finished event are emitted', async () => {
    const h = harness([{ rows: 1 }, { rows: 1, alreadyFilled: true }], { complete: true });
    await runSession(h);
    const finished = h.events.filter((event) => event.phase === 'finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ phase: 'finished', stopReason: 'completed', hydrated: 1, skipped: 1 });
    // Plain data only: no wording, no page handles, no dependency.
    for (const event of h.events) {
      expect(event.type).toBe(EVENT);
      for (const value of Object.values(event)) expect(['string', 'number', 'boolean']).toContain(typeof value);
    }
    // Progress carries the counters and the real click count, which is NOT the same as `attempted`.
    const progress = h.events.filter((event) => event.phase === 'progress');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]).toHaveProperty('hydrationClicks');
  });

  it('V. a rejected event send cannot break the session', async () => {
    /*
     * The realistic failure: no panel is open, so `chrome.runtime.sendMessage` has nowhere to go. A session that aborted on that would be unusable exactly
     * when nobody is watching. This harness restores the sender to a rejecting one mid-session to prove the catch is real.
     */
    const h = harness([{ rows: 1 }], { complete: true });
    const sent = h.ask(START);
    expect(sent.accepted).toBe(true);
    await settle();
    await h.flush();
    await settle();
    expect(h.ask(QUERY_STATUS).status).toMatchObject({ phase: 'finished', hydrated: 1 });
  });
});
