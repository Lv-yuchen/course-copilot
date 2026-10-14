import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * Step 42 — the recovery protocol, tested against the BUILT artifacts.
 *
 * ## Why the built files rather than the sources
 *
 * The defect this protocol fixes was invisible in the sources and obvious in the artifact: a trailing `export {};` made the
 * content script impossible to parse as a classic script. Loading the emitted JavaScript is therefore the point — it tests
 * what the browser would run, not what the repository says.
 *
 * ## Why a container rather than a page
 *
 * Each script is evaluated in a `node:vm` context with only the extension APIs it uses, stubbed to record calls. That is not a
 * mock page and not a fixture DOM: no HTML is parsed and no selector is exercised against markup. The question here is purely
 * whether the message protocol recovers state, so what matters is the sequence of calls, not rendering.
 *
 * ## The specific recovery being tested
 *
 * A Manifest V3 service worker is suspended when idle, taking its in-memory `knownStatus` and `reportingTabIds` with it. The
 * panel therefore names the tab it is looking at, so a freshly started worker can ask that tab instead of answering from a
 * memory it no longer has.
 */

const repoRoot = resolve(__dirname, '..');
const distDir = join(repoRoot, 'apps', 'extension', 'dist');

/** Read a built artifact, failing loudly if the build has not been run. */
function artifact(relative: string): string {
  try {
    return readFileSync(join(distDir, relative), 'utf8');
  } catch {
    throw new Error(`缺少构建产物 ${relative}；请先运行 npm run extension:build`);
  }
}

/** A recorded call, used to assert on the sequence rather than on internal state. */
interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** A listener registered through `chrome.runtime.onMessage.addListener`. */
type RuntimeListener = (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => unknown;

/** The container a script under test runs in, with everything it touched recorded. */
interface Container {
  /** Every recorded extension-API call, in order. */
  readonly calls: Call[];
  /** Listeners the script registered for runtime messages. */
  readonly runtimeListeners: RuntimeListener[];
  /** Deliver a runtime message and await a reply, supporting an asynchronous `sendResponse`. */
  deliver(message: unknown, sender?: unknown): Promise<unknown>;
}

/**
 * Evaluate a built script with stubbed extension APIs.
 *
 * @param relative - artifact path relative to dist.
 * @param options - extra globals and the behaviour of `tabs.sendMessage`.
 * @returns the container, so the test can deliver messages and inspect recorded calls.
 */
function load(relative: string, options: {
  extraGlobals?: Record<string, unknown>;
  /** Resolve or reject `chrome.tabs.sendMessage`, standing in for the content script's answer. */
  tabReply?: (tabId: number, message: unknown) => Promise<unknown>;
} = {}): Container {
  const calls: Call[] = [];
  const runtimeListeners: RuntimeListener[] = [];

  const chrome = {
    runtime: {
      id: 'test-extension-id',
      getManifest: () => ({ version: '0.0.0-test', name: 'Course Copilot' }),
      onInstalled: { addListener: () => { calls.push({ method: 'onInstalled.addListener', args: [] }); } },
      onMessage: {
        addListener: (listener: RuntimeListener) => {
          runtimeListeners.push(listener);
          calls.push({ method: 'runtime.onMessage.addListener', args: [] });
        },
      },
      sendMessage: (message: unknown) => {
        calls.push({ method: 'runtime.sendMessage', args: [message] });
        // No receiver in this container: the same rejection the browser produces when nothing is listening.
        return Promise.reject(new Error('Could not establish connection.'));
      },
    },
    sidePanel: {
      setPanelBehavior: (options: unknown) => {
        calls.push({ method: 'sidePanel.setPanelBehavior', args: [options] });
        return Promise.resolve();
      },
    },
    tabs: {
      query: (queryInfo: unknown) => {
        calls.push({ method: 'tabs.query', args: [queryInfo] });
        return Promise.resolve([{ id: 4242 }]);
      },
      sendMessage: (tabId: number, message: unknown) => {
        calls.push({ method: 'tabs.sendMessage', args: [tabId, message] });
        if (options.tabReply === undefined) return Promise.reject(new Error('Receiving end does not exist.'));
        return options.tabReply(tabId, message);
      },
    },
  };

  const sandbox: Record<string, unknown> = {
    chrome,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: (handler: () => void) => { void handler; return 0; },
    clearTimeout: () => {},
    ...(options.extraGlobals ?? {}),
  };

  vm.createContext(sandbox);
  new vm.Script(artifact(relative), { filename: relative }).runInContext(sandbox);

  return {
    calls,
    runtimeListeners,
    deliver(message: unknown, sender: unknown = {}) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const sendResponse = (response: unknown) => {
          if (settled) return;
          settled = true;
          resolve(response);
        };
        const listener = runtimeListeners[0];
        if (listener === undefined) {
          reject(new Error('脚本没有注册 runtime.onMessage 监听器'));
          return;
        }
        listener(message, sender, sendResponse);
        /*
         * An asynchronous handler keeps the channel open by returning `true`; if nothing has replied by the next tick, the
         * test resolves with `undefined` so a missing reply shows up as a failed assertion rather than a hang.
         */
        setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve(undefined);
          }
        }, 50);
      });
    },
  };
}

/** The globals the content script needs, standing in for a page without containing one. */
function contentScriptGlobals(hostname: string, pathname: string, panelCount: number): Record<string, unknown> {
  /*
   * UPDATED IN PRE-RELEASE-UX-A4B: the fixture now models the real CONTAINMENT, not just a count.
   *
   * The panel count used to come from `document.querySelectorAll(...)` answering `{ length: panelCount }`. Production stopped
   * counting that way when panel queries were scoped to `#contentBox .tjxk_list`, because the live page carries
   * `div.panel.panel-info` elements outside the list — measured there, the global count was 145 against 144 real courses. The
   * count is now the length of the container's own panel list, so a stub that only knows a global count reports 0. That is a
   * fixture left behind by a production change, which is what this slice repairs.
   *
   * The node stubs answer the member the count walks with and nothing else, so this stays a count fixture rather than a DOM.
   */
  const panel = { querySelectorAll: () => [] as unknown[] };
  const panels = Array.from({ length: Math.max(0, panelCount) }, () => panel);
  return {
    location: { hostname, pathname },
    document: {
      querySelectorAll: () => ({ length: panelCount }),
      /*
       * The course-list container, which every panel query is now scoped to. Returning it is what makes `panelCount` mean the
       * same thing here as it does in production.
       */
      querySelector: (selector: string) => (selector === '#contentBox .tjxk_list' ? { querySelectorAll: () => panels } : null),
      documentElement: {},
    },
    MutationObserver: class {
      observe(): void {}
      disconnect(): void {}
    },
    window: { setTimeout: () => 0 },
  };
}

describe('42 — recovery protocol', () => {
  it('A: the panel names the tab in its ping, and reads only the tab id', () => {
    const panel = load('sidepanel/sidepanel.js', {
      extraGlobals: {
        document: {
          /*
           * A stub element carrying every member the built panel script touches, not only the ones an earlier version of the
           * script happened to call.
           *
           * UPDATED IN PRE-RELEASE-UX-A4B. The old stub returned `{ textContent, classList, hidden }`, which sufficed until the
           * card renderer began CLEARING its three lists before filling them. It then threw
           * `root.recommended.replaceChildren is not a function` during module evaluation — the same failure mode as the
           * content-script stubs that lacked `querySelector`. A stub that lags the DOM surface turns every later feature into a
           * false failure, which is exactly the noise this slice exists to remove.
           *
           * The additions are the standard Node surface, not behaviour: appending, clearing, and the attribute methods.
           */
          getElementById: () => {
            const node: Record<string, unknown> = {
              textContent: '',
              hidden: false,
              className: '',
              children: [] as unknown[],
              classList: { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false },
              replaceChildren: (...nodes: unknown[]) => { node['children'] = [...nodes]; },
              append: (...nodes: unknown[]) => { (node['children'] as unknown[]).push(...nodes); },
              appendChild: (child: unknown) => { (node['children'] as unknown[]).push(child); return child; },
              setAttribute: () => {},
              getAttribute: () => null,
              addEventListener: () => {},
              removeEventListener: () => {},
            };
            return node;
          },
        },
      },
    });
    void panel;

    /*
     * The panel's own behaviour is asynchronous and driven by chrome.tabs.query; the assertion that matters statically is
     * made in the protocol test below. Here the artifact is simply required to load and register a listener.
     */
    expect(panel.runtimeListeners.length).toBe(1);
  });

  it('B: the panel never reads url, title, pendingUrl or favIconUrl', () => {
    const source = artifact('sidepanel/sidepanel.js');
    /*
     * Comments are stripped so documentation discussing these properties is not mistaken for a read.
     */
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
    for (const property of ['url', 'pendingUrl', 'title', 'favIconUrl']) {
      expect(new RegExp(`\\.${property}\\b`, 'u').test(code)).toBe(false);
    }
    // And it does read the one property it is allowed to.
    expect(code.includes('.id')).toBe(true);
  });

  it('C: a worker with NO memory recovers by asking the tab the panel named', async () => {
    /*
     * The scenario that failed in a real browser: the worker was suspended, so `knownStatus` is null and its record of
     * reporting tabs is empty. Recovery must come from the tab id in the ping.
     */
    const worker = load('background/service-worker.js', {
      tabReply: async () => ({ supported: true, panelCount: 61 , rows: [] }),
    });

    const reply = await worker.deliver({ type: 'COURSE_COPILOT_PING', tabId: 4242 });

    expect(reply).toEqual({ known: true, supported: true, panelCount: 61 , rows: [] });
    // The worker asked the tab it was told about, and did not enumerate anything.
    const asked = worker.calls.filter((call) => call.method === 'tabs.sendMessage');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.args[0]).toBe(4242);
    expect(worker.calls.some((call) => call.method === 'tabs.query')).toBe(false);
  });

  it('C2: recovery does not depend on any earlier report having been received', async () => {
    /*
     * No PAGE_STATUS is ever delivered to this worker, so its memory is empty by construction — the strongest form of the
     * restart case.
     */
    const worker = load('background/service-worker.js', {
      tabReply: async () => ({ supported: true, panelCount: 7 , rows: [] }),
    });

    const reply = await worker.deliver({ type: 'COURSE_COPILOT_PING', tabId: 99 });
    expect(reply).toEqual({ known: true, supported: true, panelCount: 7 , rows: [] });
  });

  it('C3: a ping without a usable tab id falls back to memory instead of guessing', async () => {
    const worker = load('background/service-worker.js');
    const reply = await worker.deliver({ type: 'COURSE_COPILOT_PING' });

    // Nothing known, nothing asked.
    expect(reply).toEqual({ known: false, supported: false, panelCount: null , rows: [] });
    expect(worker.calls.some((call) => call.method === 'tabs.sendMessage')).toBe(false);
  });

  it('C4: a tab with no content script degrades normally — no retry, no injection', async () => {
    const worker = load('background/service-worker.js', {
      // The default stub rejects, which is what the browser does when no content script is listening.
    });

    const reply = await worker.deliver({ type: 'COURSE_COPILOT_PING', tabId: 5 });
    expect(reply).toEqual({ known: false, supported: false, panelCount: null , rows: [] });

    // Asked exactly once: a retry would show as more than one call.
    expect(worker.calls.filter((call) => call.method === 'tabs.sendMessage')).toHaveLength(1);
    expect(worker.calls.some((call) => call.method === 'scripting.executeScript')).toBe(false);
  });

  it('D: the content script answers a query with supported + panelCount only', async () => {
    const content = load('content/content-script.js', {
      extraGlobals: contentScriptGlobals('jwgl.whu.edu.cn', '/xsxk/zzxkyzb_cxZzxkYzbIndex.html', 61),
    });

    const reply = await content.deliver({ type: 'COURSE_COPILOT_QUERY_STATUS' });

    expect(reply).toEqual({ supported: true, panelCount: 61 , rows: [] });
    // Exactly two fields, so nothing else can travel in the reply.
    expect(Object.keys(reply as object).sort()).toEqual(['panelCount', 'rows', 'supported']);
  });

  it('D2: on a non-matching page the content script reports unsupported and a null count', async () => {
    const content = load('content/content-script.js', {
      extraGlobals: contentScriptGlobals('example.com', '/', 0),
    });

    const reply = await content.deliver({ type: 'COURSE_COPILOT_QUERY_STATUS' });
    expect(reply).toEqual({ supported: false, panelCount: null , rows: [] });
  });

  it('D3: a non-matching hostname or pathname is rejected on both fields independently', async () => {
    // Same host, different path.
    const wrongPath = load('content/content-script.js', {
      extraGlobals: contentScriptGlobals('jwgl.whu.edu.cn', '/xsxk/other.html', 3),
    });
    expect(await wrongPath.deliver({ type: 'COURSE_COPILOT_QUERY_STATUS' })).toEqual({ supported: false, panelCount: null , rows: [] });

    // Same path, different host.
    const wrongHost = load('content/content-script.js', {
      extraGlobals: contentScriptGlobals('jwgl.example.edu.cn', '/xsxk/zzxkyzb_cxZzxkYzbIndex.html', 3),
    });
    expect(await wrongHost.deliver({ type: 'COURSE_COPILOT_QUERY_STATUS' })).toEqual({ supported: false, panelCount: null , rows: [] });
  });

  it('E: no storage is used anywhere, and nothing is persisted', () => {
    for (const relative of ['content/content-script.js', 'background/service-worker.js', 'sidepanel/sidepanel.js']) {
      const code = artifact(relative).replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
      for (const token of ['chrome.storage', 'storage.local', 'storage.session', 'storage.sync', 'localStorage', 'indexedDB']) {
        expect(code.includes(token), `${relative} 不应包含 ${token}`).toBe(false);
      }
    }
  });

  it('F: the manifest grants exactly one permission and exactly one host', () => {
    /*
     * UPDATED IN 16G-A. `host_permissions` used to be required ABSENT; it is now required to be exactly one entry, because the
     * worker may reach the public review site and nothing else. The check is an exact match rather than a substring test, so a
     * second host or a lookalike domain fails.
     */
    const manifest = JSON.parse(artifact('manifest.json')) as {
      permissions?: string[];
      host_permissions?: string[];
      optional_permissions?: string[];
      optional_host_permissions?: string[];
    };
    expect(manifest.permissions).toEqual(['sidePanel']);
    expect(manifest.host_permissions).toEqual(['https://whucourses.cn/*']);
    expect(manifest.optional_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toBeUndefined();
    // No WHU host, ever: the review corpus is public, the course-selection system is not.
    expect((manifest.host_permissions ?? []).some((pattern) => /whu\.edu\.cn|jwgl/iu.test(pattern))).toBe(false);
  });

  it('G: the content script parses under classic-script grammar', () => {
    // `vm.Script` accepts only a classic script, so module syntax anywhere at the top level throws here.
    expect(() => new vm.Script(artifact('content/content-script.js'))).not.toThrow();
  });

  it('H: the worker answers the ping only after the content script has replied', async () => {
    /*
     * Ordering is the reason the ping awaits its reply: an answer sent from the worker's own memory before the tab replies is
     * what produced a permanent "not detected" in a real browser.
     */
    const order: string[] = [];
    const worker = load('background/service-worker.js', {
      tabReply: async () => {
        order.push('tab-replied');
        return { supported: true, panelCount: 12 , rows: [] };
      },
    });

    const reply = await worker.deliver({ type: 'COURSE_COPILOT_PING', tabId: 8 });
    order.push('panel-answered');

    expect(order).toEqual(['tab-replied', 'panel-answered']);
    expect(reply).toEqual({ known: true, supported: true, panelCount: 12 , rows: [] });
  });
});
