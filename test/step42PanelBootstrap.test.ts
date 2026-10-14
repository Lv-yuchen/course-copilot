/**
 * PART 16J-REAL-E2E-1: the side panel must BOOTSTRAP, and its approved control must be wired.
 *
 * ## The failure this exists for, and why nothing else caught it
 *
 * In the real Edge release gate the approved button did nothing at all. The cause was an initialisation-order bug in `sidepanel.ts`:
 * `createFullPreparationController` calls its `onView` sink ONCE DURING CONSTRUCTION to publish the initial view, that sink is `renderPreparation`, and
 * `renderPreparation` reached for a `const handoff` declared further down the file. That is the temporal dead zone, so the module threw
 * `ReferenceError: Cannot access 'handoff' before initialization` while it was still evaluating — which aborted the script partway through and left the button's
 * click listener unattached. Everything that HAD already run still showed on screen (version, page status, card sections), which is exactly why the panel looked
 * healthy while being completely inert.
 *
 * The existing suites could not see it: they import the controllers and drive them directly, and none of them evaluates `sidepanel.ts` as a program. That is the
 * gap this test closes, and it is the reason it asserts on OBSERVABLE BOOTSTRAP EFFECTS rather than on the shape of the source.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const panelArtifactPath = join(repoRoot, 'apps', 'extension', 'dist', 'sidepanel', 'sidepanel.js');
const panelArtifact = readFileSync(panelArtifactPath, 'utf8');
const panelSource = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');

/** A DOM node with just enough behaviour for the panel and the card renderer. */
class StubNode {
  readonly children: StubNode[] = [];
  readonly attributes: Record<string, string> = {};
  readonly listeners = new Map<string, Array<() => void>>();
  readonly classListChanges: Array<[string, boolean]> = [];
  textContent = '';
  className = '';
  hidden = false;
  id = '';

  get classList(): { toggle: (token: string, force?: boolean) => void; add: (token: string) => void } {
    return {
      toggle: (token: string, force?: boolean) => { this.classListChanges.push([token, force === true]); },
      add: (token: string) => { this.classListChanges.push([token, true]); },
    };
  }

  append(...nodes: StubNode[]): void { this.children.push(...nodes); }

  replaceChildren(...nodes: StubNode[]): void { this.children.length = 0; this.children.push(...nodes); }

  setAttribute(name: string, value: string): void { this.attributes[name] = value; }

  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }

  addEventListener(type: string, listener: () => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  /** How many handlers are attached for one event type. */
  listenerCount(type: string): number { return (this.listeners.get(type) ?? []).length; }
}

/** One panel bootstrap: the stub environment, the elements it produced, and any error the script threw. */
interface BootResult {
  readonly error: unknown;
  readonly elements: Map<string, StubNode>;
  readonly runtimeListeners: number;
  readonly sentMessages: Array<Record<string, unknown>>;
  readonly tabQueries: number;
}

/**
 * Evaluate the built panel script as a program against a stub browser.
 *
 * The artifact is the thing that ships, so it is what runs here. Errors are CAUGHT rather than thrown, because "the script threw" is itself the assertion in the
 * failure case and a throwing test would only report a stack.
 */
function boot(): BootResult {
  const elements = new Map<string, StubNode>();
  const sentMessages: Array<Record<string, unknown>> = [];
  let runtimeListeners = 0;
  let tabQueries = 0;

  const elementFor = (id: string): StubNode => {
    const existing = elements.get(id);
    if (existing !== undefined) return existing;
    const created = new StubNode();
    created.id = id;
    elements.set(id, created);
    return created;
  };

  const sandbox: Record<string, unknown> = {
    document: {
      // Every id the panel asks for exists, so the script follows its happy path and cannot pass by taking an early error exit.
      getElementById: (id: string): StubNode => elementFor(id),
      createElement: (): StubNode => new StubNode(),
      querySelectorAll: (): StubNode[] => [],
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    chrome: {
      runtime: {
        id: 'test-extension-id',
        getManifest: (): { version: string } => ({ version: '0.0.1' }),
        sendMessage: (_message: unknown, callback?: (response: unknown) => void): Promise<unknown> => {
          sentMessages.push(_message as Record<string, unknown>);
          // The panel uses both forms; answering the callback keeps the status path exercised.
          if (typeof callback === 'function') callback({ ok: true, reply: { ok: true, status: { phase: 'idle' } } });
          return Promise.resolve({ ok: true, reply: { ok: true, status: { phase: 'idle' } } });
        },
        onMessage: { addListener: (): void => { runtimeListeners += 1; } },
      },
      tabs: {
        query: (): Promise<Array<{ id: number }>> => { tabQueries += 1; return Promise.resolve([{ id: 11 }]); },
      },
      sidePanel: { setPanelBehavior: (): Promise<void> => Promise.resolve() },
    },
  };
  sandbox['globalThis'] = sandbox;
  sandbox['self'] = sandbox;

  let error: unknown;
  try {
    vm.createContext(sandbox);
    new vm.Script(panelArtifact, { filename: 'sidepanel.js' }).runInContext(sandbox);
  } catch (thrown) {
    error = thrown;
  }
  return { error, elements, runtimeListeners, sentMessages, tabQueries };
}

describe('16J-REAL-E2E-1 the panel bootstraps without throwing'.replace('REAL-E2E-1', 'REAL-E2E-1'), () => {
  it('the built panel script evaluates to completion', () => {
    /*
     * This is the case that failed in Edge. A `ReferenceError` from the temporal dead zone aborts evaluation partway, so asserting that nothing was thrown is the
     * direct expression of the bug.
     */
    const result = boot();
    expect(result.error).toBeUndefined();
  });

  it('the approved control receives its click listener', () => {
    /*
     * The consequence the user saw: the button existed, was visible, was the topmost element at its own centre — and did nothing, because the script died before
     * reaching this line. A listener count is the observable form of "wired".
     */
    const result = boot();
    const start = result.elements.get('full-preparation-start');
    expect(start, 'the start button was never touched by the panel').toBeDefined();
    expect(start?.listenerCount('click'), 'the start button has no click handler').toBe(1);
  });

  it('the cancel control receives its listener too', () => {
    const result = boot();
    expect(result.elements.get('full-preparation-cancel')?.listenerCount('click')).toBe(1);
  });

  it('the panel registers exactly one runtime listener, and queries the tab for its status', () => {
    const result = boot();
    expect(result.runtimeListeners).toBe(1);
    // The startup path asks the worker for the page facts and the preparation status; it must never send a START.
    expect(result.tabQueries).toBeGreaterThan(0);
    const types = result.sentMessages.map((message) => String(message.type));
    expect(types).not.toContain('COURSE_COPILOT_START_FULL_PREPARATION');
  });

  it('the initial view is published, so the panel is not blank', () => {
    // The controller publishes once during construction; that is the call whose receiver threw. A rendered message element proves the sink ran.
    const result = boot();
    const message = result.elements.get('full-preparation-message');
    expect(message).toBeDefined();
    expect(message?.hidden).toBe(true);
    // The start button is offered and the cancel control is not, which is the idle view.
    expect(result.elements.get('full-preparation-start')?.hidden).toBe(false);
  });

  it('every element the panel needs exists in the shipped HTML', () => {
    /*
     * The stub answers `getElementById` for ANY id, so it cannot notice a missing element in the real document. The HTML is therefore checked directly, against the
     * ids the panel asks for.
     */
    const html = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'sidepanel.html'), 'utf8');
    const ids = [...panelSource.matchAll(/getElementById\('([^']+)'\)/gu)].map((match) => match[1]);
    // A handful of call sites pass the id as a literal; the rest go through named constants, which the manifest-name checks below cover.
    expect(ids.length).toBeGreaterThan(3);
    for (const id of new Set(ids)) {
      expect(html.includes(`id="${id}"`), id).toBe(true);
    }
    /*
     * The ids that ARRIVE THROUGH CONSTANTS are checked by their names, because those are the ones a rename would silently break: the lookup would return null and
     * the panel would log a missing-element notice instead of failing loudly.
     */
    for (const id of ['full-preparation-start', 'full-preparation-cancel', 'full-preparation-message', 'recommendation', 'recommendation-message', 'recommendation-counts', 'card-list-recommended', 'card-list-rated', 'card-list-insufficient', 'cards-recommended', 'cards-rated', 'cards-insufficient']) {
      expect(html.includes(`id="${id}"`), id).toBe(true);
    }
  });

  it('no collaborator is referenced from the render sink before it can exist', () => {
    /*
     * A structural restatement, because the DOM stub cannot reproduce the temporal dead zone of the real module scope: the sink that runs DURING construction must
     * reach its collaborators through accessors rather than through `const` bindings declared below it.
     */
    expect(panelSource).toContain('deferredHandoff()?.consider(');
    expect(panelSource).toContain('deferredPreparation()?.operationTabId()');
    // The accessors are declared BEFORE the controller whose construction calls the sink.
    const accessorAt = panelSource.indexOf('let preparationRef');
    const controllerAt = panelSource.indexOf('createFullPreparationController({ onView: renderPreparation })');
    expect(accessorAt).toBeGreaterThan(-1);
    expect(controllerAt).toBeGreaterThan(accessorAt);
    // And the sink no longer reaches for the bare bindings.
    expect(panelSource).not.toContain('handoff.consider(view.phase, view.stopReason, preparation.operationTabId())');
  });
});
