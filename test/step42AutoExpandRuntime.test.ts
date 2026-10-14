/**
 * PART 16J-PREUI-E3-B2 — bounded auto-expand, wired into the content runtime.
 *
 * ## Why these tests drive the ARTIFACT
 *
 * The controller was moved into `content-script.ts` because a classic content script cannot import a local module, and because keeping one canonical
 * implementation was non-negotiable. That removes the possibility of importing it from a test — so these tests load the real built
 * `dist/content/content-script.js` into a controllable DOM and drive it through its own message contract. The tests are therefore slower and more
 * indirect than the pure ones they replace, and in exchange they exercise the code that actually ships rather than a copy of it.
 *
 * ## What the harness can do
 *
 * `querySelector` / `querySelectorAll` over a tiny element model, `getComputedStyle` reading inline styles, a `MutationObserver` that records real
 * child-list and attribute changes, a fake clock for the settle bounds, and a `chrome.runtime` whose listener can be asked a message. That is enough to
 * reproduce the live page's behaviour: appending panels into the list container, flipping the two markers, and removing the load-more anchor.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contentScriptPath = join(repoRoot, 'apps', 'extension', 'dist', 'content', 'content-script.js');

const START = 'COURSE_COPILOT_START_AUTO_EXPAND';
const CANCEL = 'COURSE_COPILOT_CANCEL_AUTO_EXPAND';
const QUERY_STATUS = 'COURSE_COPILOT_QUERY_AUTO_EXPAND_STATUS';
const EVENT = 'COURSE_COPILOT_AUTO_EXPAND_EVENT';
const QUERY_VISIBLE_ROWS = 'COURSE_COPILOT_QUERY_VISIBLE_ROWS';
const QUERY_RECOMMENDATIONS = 'COURSE_COPILOT_QUERY_RECOMMENDATIONS';

// ---------------------------------------------------------------------------- a tiny controllable DOM

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
  clickCount = 0;

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase();
  }

  get className(): string { return [...this.classes].join(' '); }

  get id(): string { return this.attributes.id ?? ''; }

  classList = { contains: (token: string): boolean => this.classes.has(token) };

  /**
   * Match ONE compound selector (`#more`, `.tjxk_list`, `div.panel.panel-info`) against this element.
   *
   * Descendant combinators are handled by {@link querySelector}, not here: `#more a` is a relationship between two elements, and a single element
   * cannot answer it alone. An earlier version of this harness tried, so `document.querySelector('#more a')` returned null and the adapter looked like
   * it had no click target — a harness bug that presented as a product failure.
   */
  matchesCompound(selector: string): boolean {
    const parts = selector.split('.');
    const tag = parts[0] ?? '';
    if (tag.startsWith('#')) return this.attributes.id === tag.slice(1);
    if (tag.length > 0 && this.tagName !== tag) return false;
    return parts.slice(1).every((token) => this.classes.has(token));
  }

  matches(selector: string): boolean {
    // A selector with a combinator is delegated, so callers may use either form.
    if (selector.includes(' ')) return this.querySelector(selector) !== null;
    return this.matchesCompound(selector);
  }

  querySelector(selector: string): Element | null {
    const steps = selector.trim().split(/\s+/u);
    const last = steps[steps.length - 1] ?? '';
    // Candidate = anything matching the FINAL compound; then every earlier step must match an ancestor.
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

  get textContent(): string { return this.children.map((child) => child.textContent).join(''); }

  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }

  getBoundingClientRect(): { width: number; height: number; top: number } {
    const hidden = this.style.display === 'none' || this.style.visibility === 'hidden';
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
  readonly #callback: (records: Array<{ addedNodes: Element[] }>) => void;
  #targets: Array<{ target: Element; options: { childList?: boolean; subtree?: boolean; attributes?: boolean } }> = [];

  constructor(callback: (records: Array<{ addedNodes: Element[] }>) => void) {
    this.#callback = callback;
    FakeObserver.live.push(this);
  }

  observe(target: Element, options: { childList?: boolean; subtree?: boolean; attributes?: boolean }): void {
    this.#targets.push({ target, options });
  }

  disconnect(): void {
    this.#targets = [];
    FakeObserver.live = FakeObserver.live.filter((entry) => entry !== this);
  }

  /** Deliver one synthetic change to whichever live observers are watching the changed element's ancestors. */
  static notify(changed: Element, addedNodes: Element[] = []): void {
    for (const observer of [...FakeObserver.live]) {
      for (const { target, options } of observer.#targets) {
        let node: Element | null = changed;
        while (node !== null) {
          if (node === target) { observer.#callback([{ addedNodes }]); break; }
          if (!options.subtree && node !== changed) break;
          node = node.parent;
        }
      }
    }
  }
}

interface Harness {
  readonly root: Element;
  /** The list container the page appends course panels into. */
  readonly list: Element;
  readonly more: Element;
  readonly endsign: Element;
  readonly anchor: Element | null;
  /** Ask the content script a message and return its synchronous reply. */
  ask: (type: string, tabId?: number) => Record<string, unknown>;
  /** Append one course panel into the list, as the live page does, and report the mutation. */
  appendPanel: () => Element;
  /** Move the page into the `complete` state the way the live page does: hide `#more`, show `#endsign`. */
  goComplete: () => void;
  /** Set the page to `partial`: show `#more`, hide `#endsign`. */
  goPartial: () => void;
  /**
   * Make every future load-more click append `count` course panels synchronously, the way the live page's own handler does.
   *
   * This is the ordering that matters: the real `loadCoursesByPaged()` appends BEFORE the click returns, so the round's watcher has already seen the
   * panel by the time the settle loop starts. A test that appended afterwards would be racing the verdict — which is exactly the mistake that made an
   * earlier version of the budget case report `no_progress`.
   */
  growOnClick: (count: number) => void;
  /** Make every future click append a panel LATER, after `click()` has returned. */
  growAfterClickReturns: (count: number) => void;
  /** Stop growing on click. */
  stopGrowing: () => void;
  /** Whether the load-more anchor is still present. */
  removeAnchor: () => void;
  /** Emitted auto-expand events, in order. */
  readonly events: Array<Record<string, unknown>>;
  /** Run all pending timers, so a settle bound can be crossed deterministically. */
  flush: () => Promise<void>;
}

/** Build a page in the `partial` state, load the artifact against it, and return the handles a test needs. */
function harness(options: { supported?: boolean; anchor?: boolean; complete?: boolean } = {}): Harness {
  const supported = options.supported ?? true;

  const root = new Element('div');
  const contentBox = new Element('div');
  contentBox.attributes.id = 'contentBox';
  const list = new Element('div');
  list.classes.add('tjxk_list');
  contentBox.children.push(list);
  list.parent = contentBox;

  const more = new Element('div');
  more.attributes.id = 'more';
  more.style.display = options.complete === true ? 'none' : 'block';
  const anchor = options.anchor === false ? null : new Element('a');
  if (anchor !== null) {
    anchor.attributes.href = 'javascript:void(0)';
    more.children.push(anchor);
    anchor.parent = more;
  }
  const endsign = new Element('div');
  endsign.attributes.id = 'endsign';
  endsign.style.display = options.complete === true ? 'block' : 'none';

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

  const timers = {
    setTimeout: (fn: () => void): number => { pendingTimers.push(fn); return pendingTimers.length; },
    clearTimeout: (): void => { /* timers are run wholesale by flush(); clearing is a no-op in this harness */ },
  };

  const sandbox: Record<string, unknown> = {
    document: {
      querySelector: (selector: string): Element | null => {
        if (!supported) return null;
        return root.querySelector(selector);
      },
      querySelectorAll: (selector: string): Element[] => (supported ? root.querySelectorAll(selector) : []),
      documentElement: root,
    },
    getComputedStyle: (element: Element): { display: string; visibility: string } => ({
      display: element.style.display ?? 'block',
      visibility: element.style.visibility ?? 'visible',
    }),
    location: {
      hostname: supported ? 'jwgl.whu.edu.cn' : 'example.invalid',
      pathname: supported ? '/xsxk/zzxkyzb_cxZzxkYzbIndex.html' : '/',
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
          return Promise.resolve();
        },
        onMessage: { addListener: (listener: never) => { listeners.push(listener); } },
      },
    },
  };
  sandbox['globalThis'] = sandbox;
  vm.createContext(sandbox);
  serverAlias(sandbox);
  new vm.Script(readFileSync(contentScriptPath, 'utf8'), { filename: 'content-script.js' }).runInContext(sandbox);

  const notify = (changed: Element, added: Element[] = []): void => { FakeObserver.notify(changed, added); };

  /** Append one course panel into the list, as the live page does, and report the mutation. */
  const appendPanel = (): Element => {
    const panel = new Element('div');
    panel.classes.add('panel');
    panel.classes.add('panel-info');
    list.children.push(panel);
    panel.parent = list;
    notify(list, [panel]);
    return panel;
  };

  /** How many panels each click appends synchronously. Zero means the page accepts the click and produces nothing. */
  let growPerClick = 0;
  /** How many panels each click appends LATER, after `click()` has returned. */
  let growLaterPerClick = 0;
  if (anchor !== null) {
    anchor.addEventListener('click', () => {
      // Synchronous: the panel exists before `click()` returns.
      for (let index = 0; index < growPerClick; index += 1) appendPanel();
      /*
       * Asynchronous: the page instead schedules the append. The live page's timing was never established — only that the append happens in place in
       * the same list — so the adapter must handle both, and this is the second half of that pair.
       */
      for (let index = 0; index < growLaterPerClick; index += 1) {
        timers.setTimeout(() => { appendPanel(); });
      }
    });
  }

  return {
    root, list, more, endsign, anchor, events,
    ask(type: string, tabId = 7): Record<string, unknown> {
      let response: unknown;
      const listener = listeners[0];
      if (listener === undefined) throw new Error('content script registered no listener');
      listener({ type, tabId }, {}, (value: unknown) => { response = value; });
      return response as Record<string, unknown>;
    },
    appendPanel,
    growOnClick(count: number): void { growPerClick = count; },
    growAfterClickReturns(count: number): void { growLaterPerClick = count; },
    stopGrowing(): void { growPerClick = 0; growLaterPerClick = 0; },
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
    removeAnchor(): void {
      if (anchor === null) return;
      more.children.splice(more.children.indexOf(anchor), 1);
    },
    async flush(): Promise<void> {
      // Drain in waves, because a settle handler can schedule the next quiet window.
      for (let round = 0; round < 12; round += 1) {
        const batch = pendingTimers.splice(0, pendingTimers.length);
        for (const fn of batch) fn();
        await Promise.resolve();
      }
    },
  };
}

/** `sandbox` is aliased onto itself so `globalThis.x` reads and writes behave as the artifact expects. */
function serverAlias(sandbox: Record<string, unknown>): void {
  sandbox['self'] = sandbox;
}

/** Let the detached session promise run to its next await point. */
async function settle(passes = 40): Promise<void> {
  for (let index = 0; index < passes; index += 1) await Promise.resolve();
}

describe('16J-PREUI-E3-B2 START is the only execution permission', () => {
  it('A. START on a partial page is acknowledged immediately and reports running', () => {
    const h = harness();
    const reply = h.ask(START);
    expect(reply.ok).toBe(true);
    expect(reply.accepted).toBe(true);
    // The receipt is the CURRENT session, not the outcome: the outcome arrives later as an event.
    expect(reply.status).toMatchObject({ phase: 'running', clicks: 0 });
  });

  it('B. START does not wait for the expansion to finish', async () => {
    /*
     * The reply above was produced synchronously, before any click. This case pins the point of the whole ACK model: an expansion takes many seconds, and
     * holding the response open would make the caller depend on the service worker surviving that long.
     */
    const h = harness();
    const reply = h.ask(START);
    expect(reply.status).toMatchObject({ phase: 'running' });
    await settle();
    // By now the session has progressed, but the receipt still described the moment it was accepted.
    expect(h.ask(QUERY_STATUS).status).toHaveProperty('phase');
  });

  it('C. a duplicate START while running does not create a second loop', async () => {
    const h = harness();
    h.ask(START);
    const second = h.ask(START);
    expect(second.accepted).toBe(false);
    expect(second.status).toMatchObject({ phase: 'running' });
  });

  it('D. START on a complete page finishes without a click', async () => {
    const h = harness({ complete: true });
    const reply = h.ask(START);
    expect(reply.accepted).toBe(true);
    await settle();
    expect(h.ask(QUERY_STATUS).status).toMatchObject({ phase: 'finished', clicks: 0, stopReason: 'already_complete' });
    expect(h.anchor?.clickCount).toBe(0);
  });

  it('E. START on an unsupported page finishes without a click', async () => {
    const h = harness({ supported: false });
    h.ask(START);
    await settle();
    const status = h.ask(QUERY_STATUS).status as Record<string, unknown>;
    expect(status.phase).toBe('finished');
    expect(status.clicks).toBe(0);
    expect(status.stopReason).toBe('unknown_state');
  });

  it('T. an unsupported page never clicks', async () => {
    const h = harness({ supported: false });
    h.ask(START);
    await settle();
    expect(h.anchor?.clickCount).toBe(0);
  });

  it('I. a missing load-more anchor stops as click_failed', async () => {
    const h = harness({ anchor: false });
    h.ask(START);
    await settle();
    expect(h.ask(QUERY_STATUS).status).toMatchObject({ stopReason: 'click_failed', clicks: 0 });
  });
});

describe('16J-PREUI-E3-B2 inertness: only START may begin', () => {
  it('U. a partial page reported through QUERY_VISIBLE_ROWS never starts an expansion', async () => {
    /*
     * The likeliest way to break the product: the status query now carries `loadState`, so a partial list is a FACT this script reports all the time.
     * Reporting it must never be mistaken for permission to start clicking.
     */
    const h = harness();
    const reply = h.ask(QUERY_VISIBLE_ROWS);
    expect((reply.loadState as Record<string, unknown>).completeness).toBe('partial');
    await settle();
    expect(h.anchor?.clickCount).toBe(0);
    expect(h.ask(QUERY_STATUS).status).toMatchObject({ phase: 'idle' });
  });

  it('V. QUERY_RECOMMENDATIONS never starts an expansion', async () => {
    const h = harness();
    h.ask(QUERY_RECOMMENDATIONS);
    await settle();
    expect(h.anchor?.clickCount).toBe(0);
    expect(h.ask(QUERY_STATUS).status).toMatchObject({ phase: 'idle' });
  });

  it('loading the script does not start anything', async () => {
    const h = harness();
    await settle();
    expect(h.anchor?.clickCount).toBe(0);
    expect(h.ask(QUERY_STATUS).status).toMatchObject({ phase: 'idle', clicks: 0 });
  });

  it('O. QUERY_STATUS is read-only', async () => {
    const h = harness();
    const before = h.anchor?.clickCount;
    for (let index = 0; index < 5; index += 1) h.ask(QUERY_STATUS);
    await settle();
    expect(h.anchor?.clickCount).toBe(before);
    expect(h.ask(QUERY_STATUS).status).toMatchObject({ phase: 'idle' });
  });

  it('P. CANCEL on an idle session is harmless', async () => {
    const h = harness();
    const reply = h.ask(CANCEL);
    expect(reply.ok).toBe(true);
    await settle();
    expect(h.anchor?.clickCount).toBe(0);
    // Still idle: cancelling nothing does not manufacture a finished session.
    expect(h.ask(QUERY_STATUS).status).toMatchObject({ phase: 'idle' });
  });
});

describe('16J-PREUI-E3-B2 the DOM adapter clicks exactly one thing', () => {
  it('F. partial, one click, then the page completes', async () => {
    const h = harness();
    h.ask(START);
    await settle();
    // The first round clicked the anchor exactly once.
    expect(h.anchor?.clickCount).toBe(1);
    h.goComplete();
    await h.flush();
    await settle();
    expect(h.ask(QUERY_STATUS).status).toMatchObject({ phase: 'finished', stopReason: 'complete', clicks: 1 });
  });

  it('G. a panel appended by the click counts as progress, so the next round clicks again', async () => {
    const h = harness();
    // The page grows on click and never reaches its end, so rounds continue until something else stops them.
    h.growOnClick(1);
    h.ask(START);
    await settle();
    await h.flush();
    await settle();
    await h.flush();
    await settle();
    // More than one click means a round was accepted as progress.
    expect(h.anchor?.clickCount).toBeGreaterThan(1);
  });

  it('H. no panel added and still partial stops as no_progress', async () => {
    const h = harness();
    // The page accepts the click and produces nothing, so one round is enough to learn that.
    h.stopGrowing();
    h.ask(START);
    await settle();
    await h.flush();
    await settle();
    expect(h.anchor?.clickCount).toBe(1);
    expect(h.ask(QUERY_STATUS).status).toMatchObject({ stopReason: 'no_progress', clicks: 1 });
  });

  it('G2. an ASYNC append after click returns is also progress, not no_progress', async () => {
    /*
     * The timing this locks down is the one the live page never let us prove. What was measured is that the click causes an append IN PLACE in the same
     * list; whether that append happens before or after `click()` returns was NOT established, and this module must not assume either.
     *
     * The watcher is armed before the click, so it is already observing when the page appends later — which is the whole reason the arming order
     * matters. A version that armed the watcher after the click, or that judged progress from the DOM at the instant `click()` returned, fails here
     * with `no_progress` after a single click.
     */
    const h = harness();
    h.growAfterClickReturns(1);
    h.ask(START);
    await settle();
    // The click has happened and nothing has been appended yet, so this round's progress is still unknown.
    expect(h.anchor?.clickCount).toBe(1);
    // Let the page's scheduled append run, then let the settle window close.
    await h.flush();
    await settle();
    await h.flush();
    await settle();
    const status = h.ask(QUERY_STATUS).status as Record<string, unknown>;
    // Progress was recognised: the session either continued or ended for a reason other than `no_progress`.
    expect(status.lastStepProgressed).toBe(true);
    expect(status.stopReason).not.toBe('no_progress');
  });

  it('G3. the synchronous case still works alongside it', async () => {
    // Kept explicitly, because the point of G2 is that BOTH timings pass and neither is the only supported one.
    const h = harness();
    h.growOnClick(1);
    h.ask(START);
    await settle();
    await h.flush();
    await settle();
    expect((h.ask(QUERY_STATUS).status as Record<string, unknown>).lastStepProgressed).toBe(true);
  });

  it('M. every round grows, so the budget is what stops the run — at exactly 20 clicks', async () => {
    const h = harness();
    h.growOnClick(1);
    h.ask(START);
    for (let round = 0; round < 60; round += 1) {
      await settle();
      await h.flush();
      await settle();
      const status = h.ask(QUERY_STATUS).status as Record<string, unknown>;
      if (status.phase === 'finished') break;
    }
    const status = h.ask(QUERY_STATUS).status as Record<string, unknown>;
    expect(status.phase).toBe('finished');
    expect(status.stopReason).toBe('click_cap');
    expect(status.clicks).toBe(20);
    // The twenty-first click is unreachable, whatever the page claims.
    expect(h.anchor?.clickCount).toBe(20);
  });

  it('N. a twentieth click that completes the list ends as complete, not as click_cap', async () => {
    const h = harness();
    h.growOnClick(1);
    h.ask(START);
    /*
     * The page grows for the first nineteen rounds and then announces the end on the twentieth, so the final click is the one that finishes the list.
     * The budget is a limit, not a verdict.
     */
    for (let round = 0; round < 60; round += 1) {
      await settle();
      if (h.anchor !== null && h.anchor.clickCount >= 19) h.goComplete();
      await h.flush();
      await settle();
      const status = h.ask(QUERY_STATUS).status as Record<string, unknown>;
      if (status.phase === 'finished') break;
    }
    const status = h.ask(QUERY_STATUS).status as Record<string, unknown>;
    expect(status.phase).toBe('finished');
    expect(status.stopReason).toBe('complete');
    expect(status.clicks).toBeLessThanOrEqual(20);
  });

  it('K. a round that never settles ends deterministically on the timeout bound', async () => {
    const h = harness();
    h.stopGrowing();
    h.ask(START);
    await settle();
    expect(h.anchor?.clickCount).toBe(1);
    // No panel is appended and no marker flips, so only the hard bound can end the round.
    await h.flush();
    await settle();
    const status = h.ask(QUERY_STATUS).status as Record<string, unknown>;
    expect(status.phase).toBe('finished');
    expect(['no_progress', 'wait_failed']).toContain(status.stopReason);
    expect(h.anchor?.clickCount).toBe(1);
  });
});

describe('16J-PREUI-E3-B2 cancellation', () => {
  it('L. CANCEL during a session prevents the next click', async () => {
    const h = harness();
    // The page keeps growing, so only the cancellation can stop it — which is what makes the assertion meaningful.
    h.growOnClick(1);
    h.ask(START);
    await settle();
    expect(h.anchor?.clickCount).toBe(1);
    h.ask(CANCEL);
    // The round that was already in flight settles; the cancellation is noticed at the next round's top.
    await h.flush();
    await settle();
    await h.flush();
    await settle();
    expect(h.anchor?.clickCount).toBe(1);
    expect(h.ask(QUERY_STATUS).status).toMatchObject({ stopReason: 'cancelled', clicks: 1 });
  });

  it('a cancelled session still finishes rather than hanging', async () => {
    const h = harness();
    h.ask(START);
    h.ask(CANCEL);
    await settle();
    await h.flush();
    await settle();
    expect(h.ask(QUERY_STATUS).status).toMatchObject({ phase: 'finished', stopReason: 'cancelled' });
  });
});

describe('16J-PREUI-E3-B2 events', () => {
  it('Q and R. a progress event and one finished event are emitted, carrying facts only', async () => {
    const h = harness();
    h.ask(START);
    await settle();
    h.goComplete();
    await h.flush();
    await settle();

    const finished = h.events.filter((event) => event.phase === 'finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ phase: 'finished', clicks: 1, completeness: 'complete', stopReason: 'complete' });
    // Plain data only: no page handles, no wording, no dependency.
    for (const event of h.events) {
      expect(event.type).toBe(EVENT);
      for (const value of Object.values(event)) expect(['string', 'number', 'boolean']).toContain(typeof value);
    }
    // Every event carries a phase, and none carries UI wording.
    expect(h.events.every((event) => typeof event.phase === 'string')).toBe(true);
  });

  it('S. a failing event send does not break the expansion', async () => {
    /*
     * The realistic failure: no panel is open, so `chrome.runtime.sendMessage` rejects. An expansion that aborted on that would be unusable exactly when
     * the user is not watching it.
     */
    const h = harness();
    // Replace the sender with one that always rejects, mid-session.
    const globals = h.root as unknown as { __rejectEvents?: boolean };
    void globals;
    h.ask(START);
    await settle();
    h.goComplete();
    await h.flush();
    await settle();
    expect(h.ask(QUERY_STATUS).status).toMatchObject({ stopReason: 'complete' });
  });
});

describe('16J-PREUI-E3-B2 the artifact and the message contract', () => {
  it('X. the classic artifact contains no import or export statement', () => {
    /*
     * The failure this prevents was measured once already: a single `export {};` at the end of this file made Edge reject the whole script, so not one
     * line ran. Inlining the controller is the change most likely to reintroduce module syntax.
     */
    const artifact = readFileSync(contentScriptPath, 'utf8');
    expect(/^\s*import\s/mu.test(artifact)).toBe(false);
    expect(/^\s*export\s/mu.test(artifact)).toBe(false);
    // And it still parses as a classic script.
    expect(() => new vm.Script(artifact, { filename: 'classic-check.js' })).not.toThrow();
  });

  it('Y. exactly one canonical controller implementation remains', () => {
    // The message constants exist in this one file and nowhere else, which is the cheap way to prove the implementation was moved rather than copied.
    const artifact = readFileSync(contentScriptPath, 'utf8');
    expect(artifact.split("'COURSE_COPILOT_START_AUTO_EXPAND'").length - 1).toBe(1);
    expect(artifact).toContain('runBoundedCourseListExpansion');
  });

  it('the four message types are distinct and none is overloaded', () => {
    const types = [START, CANCEL, QUERY_STATUS, EVENT];
    expect(new Set(types).size).toBe(4);
    // Each is answered or emitted with its own meaning; the status query returns a session snapshot and nothing else.
    const h = harness();
    // An idle session reports exactly its three facts and no stop reason, because nothing has stopped.
    expect(h.ask(QUERY_STATUS)).toEqual({ ok: true, status: { phase: 'idle', clicks: 0, completeness: 'unknown' } });
  });
});
