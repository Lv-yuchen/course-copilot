/**
 * PART 16J-PREUI-E4-B2-R2 — a missing course list must not read as "no courses".
 *
 * ## The regression this locks down
 *
 * Scoping the scanner to `#contentBox .tjxk_list` (the fix in E4-B2-R1) introduced a distinction the E1 contract already required and that had gone missing: a
 * supported page whose course list cannot be found is NOT a page with no courses. The list is the thing that holds them, so its absence means the read could
 * not be performed.
 *
 * Measured before the fix: with the list missing, `rows` was empty while the two load-state markers — which sit OUTSIDE the list — still reported `partial`, so
 * the reply was byte-identical to a genuinely empty page, and the envelope could even claim `completeness: 'complete'`.
 *
 * The three cases below must stay structurally distinct:
 *
 *   1. supported + list present + zero rows  → a successful read that found nothing
 *   2. supported + list missing              → the read could not be performed
 *   3. unsupported page                      → a successful recognition of a page this extension does not operate on
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { requestVisibleRows } from '../apps/extension/src/background/visible-rows.js';
import { requestVisibleRecommendations } from '../apps/extension/src/background/visible-recommendations.js';
import type { ReviewProvider } from '@course-copilot/provider';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contentScriptPath = join(repoRoot, 'apps', 'extension', 'dist', 'content', 'content-script.js');

const QUERY_VISIBLE_ROWS = 'COURSE_COPILOT_QUERY_VISIBLE_ROWS';

// ---------------------------------------------------------------------------- a page with or without its course list

type Listener = () => void;

/** One element. Only the parts the content script touches. */
class Element {
  readonly tagName: string;
  readonly style: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly children: Element[] = [];
  parent: Element | null = null;
  readonly classes = new Set<string>();
  text: string | null = null;

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase();
  }

  get className(): string { return [...this.classes].join(' '); }

  classList = { contains: (token: string): boolean => this.classes.has(token) };

  matchesCompound(selector: string): boolean {
    const parts = selector.split('.');
    const tag = parts[0] ?? '';
    if (tag.startsWith('#')) return this.attributes.id === tag.slice(1);
    if (tag.length > 0 && this.tagName !== tag) return false;
    return parts.slice(1).every((token) => this.classes.has(token));
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

  get childElementCount(): number { return this.children.length; }

  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }

  getBoundingClientRect(): { width: number; height: number; top: number } { return { width: 100, height: 20, top: 0 }; }

  click(): void { for (const listener of listenersOf(this)) listener(); }

  addEventListener(type: string, listener: Listener): void {
    const set = clickListeners.get(this) ?? new Map<string, Set<Listener>>();
    const typed = set.get(type) ?? new Set<Listener>();
    typed.add(listener);
    set.set(type, typed);
    clickListeners.set(this, set);
  }
}

const clickListeners = new WeakMap<Element, Map<string, Set<Listener>>>();
function listenersOf(element: Element): Listener[] {
  return [...(clickListeners.get(element)?.get('click') ?? [])];
}

class FakeObserver {
  observe(): void {}
  disconnect(): void {}
}

/**
 * Build a page.
 *
 * `list` decides whether the REAL course list exists: `'present-empty'` is a page that answered successfully and has no courses, `'missing'` is a page whose
 * structure could not be read. The two load-state markers are present in both, because that is exactly the trap — they live OUTSIDE the list.
 */
function page(options: { list: 'present-empty' | 'missing'; complete?: boolean; supported?: boolean }): Element {
  const root = new Element('div');
  const contentBox = new Element('div');
  contentBox.attributes.id = 'contentBox';
  if (options.list === 'present-empty') {
    const list = new Element('div');
    list.classes.add('tjxk_list');
    contentBox.children.push(list);
    list.parent = contentBox;
  }
  const more = new Element('div');
  more.attributes.id = 'more';
  more.style.display = options.complete === true ? 'none' : 'block';
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
  return root;
}

/** Ask the real content artifact for its visible-rows reply against this page. */
function askContent(root: Element, supported: boolean): Record<string, unknown> {
  const listeners: Array<(message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => unknown> = [];
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
    location: {
      hostname: supported ? 'jwgl.whu.edu.cn' : 'example.invalid',
      pathname: supported ? '/xsxk/zzxkyzb_cxZzxkYzbIndex.html' : '/',
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    MutationObserver: FakeObserver,
    HTMLElement: Element,
    window: { setTimeout: () => 0 },
    setTimeout: () => 0,
    clearTimeout: () => {},
    chrome: { runtime: { id: 'x', sendMessage: () => Promise.resolve(), onMessage: { addListener: (listener: never) => { listeners.push(listener); } } } },
  };
  sandbox['globalThis'] = sandbox;
  sandbox['self'] = sandbox;
  vm.createContext(sandbox);
  new vm.Script(readFileSync(contentScriptPath, 'utf8'), { filename: 'content-script.js' }).runInContext(sandbox);
  let response: unknown;
  const listener = listeners[0];
  if (listener === undefined) throw new Error('content script registered no listener');
  listener({ type: QUERY_VISIBLE_ROWS }, { tab: { id: 7 } }, (value: unknown) => { response = value; });
  return response as Record<string, unknown>;
}

/** Install a chrome stub whose content reply is fixed, and run one background read. */
async function withReply<T>(reply: unknown, run: () => Promise<T>): Promise<T> {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals.chrome;
  globals.chrome = {
    tabs: { sendMessage: () => Promise.resolve(reply) },
    runtime: { sendMessage: () => Promise.resolve(), onMessage: { addListener: () => {} } },
    sidePanel: { setPanelBehavior: () => Promise.resolve() },
  };
  try {
    return await run();
  } finally {
    globals.chrome = previous;
  }
}

/** A provider that answers with nothing, so the engine can run without a network. */
const emptyProvider = {
  id: 'empty', label: 'empty', homepage: 'https://example.invalid', isAvailable: async () => true,
  searchCourse: async () => ({ reviews: [], provider: 'empty', fromCache: false, warnings: [] }),
} as unknown as ReviewProvider;

describe('16J-PREUI-E4-B2-R2 a missing course list is not "no courses"'.replace('E4-B2-R2', 'E4-B2-R2'), () => {
  it('A. a supported page with an EMPTY list reads successfully and reports a genuine zero', async () => {
    // Case 1: the read happened and found nothing. This is the only case allowed to read `ok` with zero rows.
    const reply = askContent(page({ list: 'present-empty' }), true);
    expect(reply.supported).toBe(true);
    expect(reply.rows).toEqual([]);
    // The load state is present because the list it describes exists.
    expect(reply).toHaveProperty('loadState');

    const snapshot = await withReply(reply, () => requestVisibleRows(3));
    expect(snapshot.read).toBe('ok');
    expect(snapshot.supported).toBe(true);
    expect(snapshot.rows).toEqual([]);
    expect(snapshot.loadState?.completeness).toBe('partial');
  });

  it('B. a supported page with NO list does not read ok, and is structurally distinct from A', async () => {
    /*
     * Case 2. `rows` is empty either way, so the distinction cannot rest on the row list — it rests on the reply no longer carrying a load state for a page
     * whose course structure is unreadable, which the background reports as `malformed`.
     */
    const missing = askContent(page({ list: 'missing' }), true);
    const genuine = askContent(page({ list: 'present-empty' }), true);
    expect(missing.supported).toBe(true);
    expect(missing.rows).toEqual([]);
    // The two replies are NOT the same shape any more, which is the whole point.
    expect(missing).not.toEqual(genuine);
    expect(missing).not.toHaveProperty('loadState');

    const snapshot = await withReply(missing, () => requestVisibleRows(3));
    expect(snapshot.read).toBe('malformed');
    expect(snapshot.read).not.toBe('ok');
    /*
     * The rows we DID read are still carried back. A missing course list means no rows were found, so this is empty here — but the rule is that the row list is
     * not thrown away over the verdict, which the diagnostic case below exercises with rows present.
     */
    expect(snapshot.rows).toEqual([]);
    // And no load state is invented for it.
    expect(snapshot.loadState).toBeUndefined();
  });

  it('B2. rows that were read survive the malformed verdict', async () => {
    /*
     * A supported reply with a misshapen load state is malformed for the same reason a missing list is — no usable state means the course structure could not
     * be described — but the ROWS in it were read successfully. Discarding them would lose real data over a diagnostic.
     */
    const snapshot = await withReply(
      { supported: true, rows: [{ courseName: 'G' }], loadState: { morePresent: true } },
      () => requestVisibleRows(3),
    );
    expect(snapshot.read).toBe('malformed');
    expect(snapshot.rows).toHaveLength(1);
  });

  it('C. an unsupported page is NOT malformed, even with no list', async () => {
    /*
     * Case 3. Recognising a page this extension does not operate on is a SUCCESS, so it must stay `ok`. The supported check therefore has to run first and the
     * list must only be consulted for a page the extension claims.
     */
    const reply = askContent(page({ list: 'missing' }), false);
    expect(reply.supported).toBe(false);

    const snapshot = await withReply(reply, () => requestVisibleRows(3));
    expect(snapshot.read).toBe('ok');
    expect(snapshot.supported).toBe(false);
    expect(snapshot.rows).toEqual([]);
    expect(snapshot.loadState).toBeUndefined();
  });

  it('D. completeness is unknown when the list is missing, whatever the markers say', async () => {
    /*
     * The markers live OUTSIDE the course list, so with the list gone they can still describe a finished or half-loaded list of nothing. Measured before the
     * fix: a page with no list and both markers claiming completion reported `completeness: 'complete'`, which is the exact claim the extension is not
     * entitled to make.
     */
    for (const complete of [false, true]) {
      const reply = askContent(page({ list: 'missing', complete }), true);
      expect(reply, String(complete)).not.toHaveProperty('loadState');
      const outcome = await withReply(reply, () => requestVisibleRecommendations(3, { provider: emptyProvider }));
      expect(outcome.page.completeness, String(complete)).toBe('unknown');
      expect(outcome.page.completeness, String(complete)).not.toBe('complete');
      expect(outcome.page.completeness, String(complete)).not.toBe('partial');
    }
  });

  it('E. the recommendation envelope distinguishes A from B', async () => {
    /*
     * Both cases produce zero rows and an empty result, so the envelope is the only place a caller can tell them apart. If these two were equal, the panel
     * would have no way to say "I could not read this page" instead of "this page has no courses".
     */
    const genuine = await withReply(askContent(page({ list: 'present-empty' }), true), () => requestVisibleRecommendations(3, { provider: emptyProvider }));
    const missing = await withReply(askContent(page({ list: 'missing' }), true), () => requestVisibleRecommendations(3, { provider: emptyProvider }));

    expect(genuine.page).toMatchObject({ read: 'ok', supported: true, rowCount: 0, courseCount: 0, completeness: 'partial' });
    expect(missing.page).toMatchObject({ read: 'malformed', supported: true, rowCount: 0, courseCount: 0, completeness: 'unknown' });
    expect(missing.page).not.toEqual(genuine.page);
    // The count fields alone cannot carry the distinction, which is why the read status has to.
    expect(missing.page.rowCount).toBe(genuine.page.rowCount);
    expect(missing.page.courseCount).toBe(genuine.page.courseCount);
    // The engine's answer is a canonical empty result either way; the envelope is what explains it.
    expect(missing.result.recommendations).toEqual([]);
    expect(genuine.result.recommendations).toEqual([]);
  });

  it('F. teacher hydration is refused when the list is missing, not accepted as an empty batch', async () => {
    /*
     * The hydration seam. With no list, the queue is empty — and an empty queue would otherwise finish as `completed` with `queued: 0`, which reads as "there
     * was nothing to hydrate". That is the same false claim as "this page has no courses": the pass did not run over a list with nothing in it, there was no
     * list. The refusal comes from the completeness gate, which sees `unknown` because no load state was reported.
     */
    const root = page({ list: 'missing' });
    const listeners: Array<(message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => unknown> = [];
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
      window: { setTimeout: () => 0 },
      setTimeout: () => 0,
      clearTimeout: () => {},
      chrome: { runtime: { id: 'x', sendMessage: () => Promise.resolve(), onMessage: { addListener: (listener: never) => { listeners.push(listener); } } } },
    };
    sandbox['globalThis'] = sandbox;
    sandbox['self'] = sandbox;
    vm.createContext(sandbox);
    new vm.Script(readFileSync(contentScriptPath, 'utf8'), { filename: 'content-script.js' }).runInContext(sandbox);

    const ask = (type: string): Record<string, unknown> => {
      let response: unknown;
      const listener = listeners[0];
      if (listener === undefined) throw new Error('content script registered no listener');
      listener({ type }, { tab: { id: 7 } }, (value: unknown) => { response = value; });
      return response as Record<string, unknown>;
    };

    const reply = ask('COURSE_COPILOT_START_TEACHER_HYDRATION');
    expect(reply.ok).toBe(true);
    expect(reply.accepted).toBe(false);
    expect(reply.reason).toBe('course_list_incomplete');
    // And the session never started, so nothing can later report a completed empty batch.
    expect((ask('COURSE_COPILOT_QUERY_TEACHER_HYDRATION_STATUS').status as Record<string, unknown>).phase).toBe('idle');
  });

  it('the content reply omits the load state only when the list is absent', () => {
    // A source-level statement of the same rule, so a future edit that reinstates the unconditional load state fails here too.
    const artifact = readFileSync(contentScriptPath, 'utf8');
    expect(artifact).toContain('supported && listPresent ? { loadState: detectCourseListLoadState() } : {}');
    expect(artifact).toContain('const listPresent = document.querySelector(COURSE_LIST_CONTAINER_SELECTOR) !== null');
  });

  it('the scope is still the real course list, and no global fallback was added', () => {
    /*
     * The fix must not have been paid for by reopening global scanning: the whole point of E4-B2-R1 was that a global panel query includes panels that are not
     * courses, and a missing-container case is exactly where a fallback would be tempting.
     */
    const artifact = readFileSync(contentScriptPath, 'utf8');
    expect(artifact).toContain("const COURSE_LIST_CONTAINER_SELECTOR = '#contentBox .tjxk_list'");
    expect(artifact.includes('document.querySelectorAll(COURSE_PANEL_SELECTOR)')).toBe(false);
  });
});
