/**
 * PART 16J-B — the worker's visible-row sender primitive.
 *
 * ## What is being proved
 *
 * `COURSE_COPILOT_QUERY_VISIBLE_ROWS` is an existing content-side contract; this step adds the worker-side way to ask. The
 * primitive is deliberately narrow, and every boundary of that narrowness is asserted here:
 *
 * - an unusable tab id sends NOTHING (no message is attempted at all)
 * - a valid tab id sends exactly one message, with exactly one field
 * - every failure mode returns `[]` rather than throwing: a rejected send, a reply that is not an object, and a reply whose `rows`
 *   is not an array
 * - it caches nothing and mutates none of the worker's status state
 *
 * The primitive is also carried — not used — by the production worker, and that dormancy is asserted separately.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { requestVisibleRows } from '../apps/extension/src/background/visible-rows.js';

/** A counter that makes each dynamic worker import a DISTINCT URL, so module side effects run on every load. */
let initSerial = 0;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = join(repoRoot, 'apps', 'extension');
const helperPath = join(extensionRoot, 'src', 'background', 'visible-rows.ts');
const helperSource = readFileSync(helperPath, 'utf8');
const helperCode = helperSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

interface Send {
  readonly tabId: unknown;
  readonly message: unknown;
}

/**
 * Install a `chrome` stub that records sends, and run the helper against it.
 *
 * The helper reads `chrome` as a global at call time, so the stub only has to exist while the call runs. `outcome` decides what
 * the stub does: answer with a value, or reject.
 *
 * A reply that carries `rows` but no `supported` gains `supported: true`. Since 16J-PREUI-E1 the content script must report the page verdict, so a
 * rows-only reply is a MALFORMED one — and these fixtures are about the transport, not about malformed replies. The cases that are about a
 * malformed reply supply shapes this does not rewrite (a non-object, or an object without `rows`), and state `supported` explicitly when the page
 * verdict itself is under test.
 *
 * UPDATED IN 16J-PREUI-E4-B2-R2: such a reply also gains a well-formed `loadState`. Since the load state is present exactly when the page's course list
 * exists, a supported reply WITHOUT one now means the course structure could not be read — which the transport reports as `malformed`. These fixtures are
 * about the transport, so they supply the state a readable page would send; the missing-container semantics have their own suite.
 */
async function withChrome<T>(
  outcome: { reply?: unknown; reject?: unknown },
  run: () => Promise<T>,
): Promise<{ result: T; sends: Send[] }> {
  const sends: Send[] = [];
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals.chrome;
  const READABLE_LOAD_STATE = { morePresent: true, moreVisible: true, endSignPresent: true, endSignVisible: false, completeness: 'partial' };
  const answer = typeof outcome.reply === 'object' && outcome.reply !== null
    && 'rows' in (outcome.reply as object) && !('supported' in (outcome.reply as object))
    ? { supported: true, loadState: READABLE_LOAD_STATE, ...(outcome.reply as object) }
    : outcome.reply;
  globals.chrome = {
    tabs: {
      sendMessage: (tabId: unknown, message: unknown): Promise<unknown> => {
        sends.push({ tabId, message });
        if (outcome.reject !== undefined) return Promise.reject(outcome.reject);
        return Promise.resolve(answer);
      },
    },
    runtime: { sendMessage: () => Promise.resolve(), onMessage: { addListener: () => {} } },
    sidePanel: { setPanelBehavior: () => Promise.resolve() },
  };
  try {
    return { result: await run(), sends };
  } finally {
    globals.chrome = previous;
  }
}

/** One row in the shape the content script publishes. */
const ROWS = [
  { courseName: 'COURSE_A', teacher: 'TEACHER_A', remainingSeats: 3 },
  { courseName: 'COURSE_B', courseCode: 'CODE_B', credits: 2 },
];

describe('16J-B A tab id that cannot be used sends nothing', () => {
  it('an invalid tab id reports unavailable and attempts NO message', async () => {
    for (const bad of [undefined, null, '7', 7.5, Number.NaN, {}, [], true]) {
      const { result, sends } = await withChrome({ reply: { rows: ROWS } }, () => requestVisibleRows(bad));
      // Nothing was sent at all: the validation comes before the request, not after it.
      expect(sends, `tabId=${String(bad)}`).toHaveLength(0);
      /*
       * `unavailable`, not an empty page: no tab could be named, so no page was ever asked about. Reporting `supported: false` here would be the
       * extension asserting a page verdict it never obtained.
       */
      expect(result, `tabId=${String(bad)}`).toEqual({ read: 'unavailable', rows: [] });
    }
  });

  it('a rejected send reports unavailable and does not throw', async () => {
    const { result, sends } = await withChrome({ reject: new Error('no content script') }, () => requestVisibleRows(1));
    expect(sends).toHaveLength(1);
    await expect(Promise.resolve(result)).resolves.toEqual({ read: 'unavailable', rows: [] });
  });
});

describe('16J-B B a valid tab id sends exactly one message', () => {
  it('sends once and returns the SAME rows, by identity', async () => {
    const { result, sends } = await withChrome({ reply: { rows: ROWS } }, () => requestVisibleRows(42));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.tabId).toBe(42);
    // Identity, not deep equality: the primitive must not clone, normalize or re-shape what the page reported.
    expect(result.rows).toBe(ROWS);
    expect(result.read).toBe('ok');
    expect(result.supported).toBe(true);
  });

  it('E: the payload is exactly { type: QUERY_VISIBLE_ROWS } — one field, no extras', async () => {
    const { sends } = await withChrome({ reply: { rows: [] } }, () => requestVisibleRows(1));
    expect(sends[0]?.message).toEqual({ type: 'COURSE_COPILOT_QUERY_VISIBLE_ROWS' });
    // Exactly one key, so a future addition has to be deliberate.
    expect(Object.keys(sends[0]?.message as object)).toEqual(['type']);
    // The message names the EXISTING contract, not a new one.
    expect((sends[0]?.message as { type?: string }).type).toBe('COURSE_COPILOT_QUERY_VISIBLE_ROWS');
  });

  it('an empty row list on a READABLE page is a successful empty read, not a failure', async () => {
    const { result } = await withChrome({ reply: { rows: [] } }, () => requestVisibleRows(1));
    /*
     * The page answered, its course list exists and it genuinely had nothing: that is `ok` with an empty row list. The harness supplies the load state a
     * readable page sends, because since 16J-PREUI-E4-B2-R2 a supported reply WITHOUT one means the course structure could not be read.
     */
    expect(result).toMatchObject({ read: 'ok', supported: true, rows: [] });
    expect(result.loadState?.completeness).toBe('partial');
  });

  it('the page verdict is carried through as the script reported it', async () => {
    /*
     * Both page verdicts stay `ok`, and that includes the unsupported one with no load state: recognising a page this extension does not operate on is a
     * success, not a structural failure. Only a page that CLAIMS support and reports no readable list is `malformed`.
     *
     * The supported fixture therefore carries the load state a readable page sends. Leaving it out would make the reply deliberately malformed, which is a
     * different case and has its own test above.
     */
    for (const supported of [true, false]) {
      const reply = supported
        ? { supported, rows: ROWS, loadState: { morePresent: true, moreVisible: true, endSignPresent: true, endSignVisible: false, completeness: 'partial' } }
        : { supported, rows: [] };
      const { result } = await withChrome({ reply }, () => requestVisibleRows(1));
      expect(result.supported, String(supported)).toBe(supported);
      expect(result.read, String(supported)).toBe('ok');
    }
  });
});

describe('16J-B C+D every malformed reply is reported as malformed', () => {
  it('a reply that is not an object is malformed', async () => {
    for (const reply of [undefined, null, 'rows', 42, true]) {
      const { result } = await withChrome({ reply }, () => requestVisibleRows(1));
      expect(result, `reply=${String(reply)}`).toEqual({ read: 'malformed', rows: [] });
    }
  });

  it('a reply whose rows is not an array is malformed', async () => {
    for (const rows of [undefined, null, 'x', 42, {}, { length: 1 }]) {
      const { result } = await withChrome({ reply: { rows } }, () => requestVisibleRows(1));
      expect(result, `rows=${JSON.stringify(rows)}`).toEqual({ read: 'malformed', rows: [] });
    }
  });

  it('a reply with neither field at all is malformed', async () => {
    const { result } = await withChrome({ reply: { status: 'ok' } }, () => requestVisibleRows(1));
    // An object with neither `supported` nor `rows` is not the agreed shape, so it is malformed rather than "empty".
    expect(result).toEqual({ read: 'malformed', rows: [] });
  });
});

describe('16J-B F the primitive is stateless', () => {
  it('names none of the worker status path state', () => {
    /*
     * The status path owns `knownStatus`, `knownPanelCount` and `reportingTabIds`. A full-row request is a different question, so
     * this module must not read or write them — a failure here must not change the worker's view of a tab.
     */
    for (const forbidden of ['knownStatus', 'knownPanelCount', 'reportingTabIds', 'sendResponse', 'onMessage']) {
      expect(helperCode.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('caches nothing: no storage, no module-level table, no second call avoided', async () => {
    for (const forbidden of ['chrome.storage', 'localStorage', 'sessionStorage', 'indexedDB', 'Map(', 'new Map', 'cache']) {
      expect(helperCode.includes(forbidden), forbidden).toBe(false);
    }
    // Two consecutive calls both reach the content script — nothing was remembered from the first.
    const first = await withChrome({ reply: { rows: ROWS } }, () => requestVisibleRows(7));
    expect(first.sends).toHaveLength(1);
    const second = await withChrome({ reply: { rows: ROWS } }, () => requestVisibleRows(7));
    expect(second.sends).toHaveLength(1);
  });

  it('reads nothing about the tab beyond its id', () => {
    // No URL, no title, no location, no cookies: the helper is given an id and sends a message.
    for (const forbidden of ['url', 'title', 'location', 'cookie', 'pendingUrl', 'favIconUrl', '.query(']) {
      expect(helperCode.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('does not compute anything: no recommendation, no provider, no fetch', () => {
    for (const forbidden of ['recommend', 'provider', 'fetch(', 'searchCourse', 'policy']) {
      expect(helperCode.includes(forbidden), forbidden).toBe(false);
    }
  });
});

describe('16J-B the production worker carries the primitive and does not call it', () => {
  const workerSource = readFileSync(join(extensionRoot, 'src', 'background', 'service-worker.ts'), 'utf8');
  const workerCode = workerSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

  it('reaches the primitive TRANSITIVELY, through the compositions imported in 16J-E and 16J-F-B', () => {
    /*
     * UPDATED TWICE. The worker first imported this primitive directly behind its own `typeof` guard (16J-B), then the page-reader
     * composition (16J-E), and now the FULL page-to-recommendation composition (16J-F-B). What the worker carries is the whole
     * chain, and this module sits at the bottom of it.
     *
     * These assertions are about the PRIMITIVE, so they are stated at the level it actually sits at: the worker's own source must
     * not name it, and the capability must still reach the artifact through the composition chain.
     */
    expect(workerCode.includes('requestVisibleRows')).toBe(false);
    expect(workerCode.includes("from './visible-rows.js'")).toBe(false);
    // The full composition IS imported and IS guarded, which is what keeps everything beneath it in the bundle.
    expect(/import \{ requestVisibleRecommendations \} from '\.\/visible-recommendations\.js'/u.test(workerCode)).toBe(true);
    expect(/typeof requestVisibleRecommendations !== 'function'/u.test(workerCode)).toBe(true);
    // And the primitive really is in the shipped artifact.
    const bundle = readFileSync(join(extensionRoot, 'dist', 'background', 'service-worker.js'), 'utf8');
    expect(bundle.includes('COURSE_COPILOT_QUERY_VISIBLE_ROWS')).toBe(true);
  });

  it('never calls it, outside the guard and the import', () => {
    // Scanned at the level the primitive lives at now: the composition calls the transport exactly once, in its body.
    const composeSource = readFileSync(join(extensionRoot, 'src', 'background', 'visible-courses.ts'), 'utf8');
    const composeCode = composeSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
    expect([...composeCode.matchAll(/requestVisibleRows\(/gu)]).toHaveLength(1);
    // And nothing in the worker's own source calls it, because the worker does not name it at all.
    expect(workerCode.includes('requestVisibleRows')).toBe(false);
  });

  it('declares no message type for it: the sender lives in the helper module', () => {
    /*
     * The message type is declared in `visible-rows.ts`, which is what makes the scope counts meaningful:
     * SERVICE-WORKER FILE message types do not include it, while the BACKGROUND RUNTIME gains it by importing the helper.
     *
     * UPDATED IN 16J-G-B, which added the worker's own `QUERY_RECOMMENDATIONS` type. The worker file is therefore six — but still
     * NOT the transport's, which is the point of this check and is asserted directly below.
     */
    const workerTypes = [...workerCode.matchAll(/'(COURSE_COPILOT_[A-Z_]+)'/gu)].map((m) => m[1]);
    expect([...new Set(workerTypes)].sort()).toEqual([
      'COURSE_COPILOT_FULL_PREPARATION_EVENT',
      'COURSE_COPILOT_PAGE_STATUS',
      'COURSE_COPILOT_PANEL_COUNT',
      'COURSE_COPILOT_PING',
      'COURSE_COPILOT_QUERY_PUBLIC_REVIEWS',
      'COURSE_COPILOT_QUERY_RECOMMENDATIONS',
      'COURSE_COPILOT_QUERY_STATUS',
    ]);
    // The transport literal appears only in the helper, and only once.
    expect(workerCode.includes('COURSE_COPILOT_QUERY_VISIBLE_ROWS')).toBe(false);
    expect([...helperCode.matchAll(/COURSE_COPILOT_QUERY_VISIBLE_ROWS/gu)]).toHaveLength(1);
  });

  it('no panel trigger, and PING was not extended', () => {
    // This step adds a primitive only: no panel→worker message, and PING keeps its shape.
    const panelCode = readFileSync(join(extensionRoot, 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');
    expect(panelCode.includes('VISIBLE_ROWS_MESSAGE')).toBe(false);
    expect(panelCode.includes('QUERY_VISIBLE_ROWS_MESSAGE')).toBe(false);
    expect(/sendMessage\(\{ type: PING_MESSAGE, tabId \}\)/u.test(panelCode)).toBe(true);
  });
});

describe('16J-B the shipped worker carries it and stays dormant', () => {
  const distDir = join(extensionRoot, 'dist');
  const workerBundle = join(distDir, 'background', 'service-worker.js');

  interface InitObservation {
    readonly visibleRowSends: number;
    readonly fetchCalls: number;
    readonly listeners: number;
  }

  /** Load the BUILT worker with a stubbed chrome, and count what initialisation actually reached for. */
  async function observeInit(): Promise<InitObservation> {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previous = { chrome: globals.chrome, fetch: globals.fetch, log: console.log };
    console.log = () => {};
    let visibleRowSends = 0;
    let fetchCalls = 0;
    let listeners = 0;
    try {
      globals.chrome = {
        runtime: {
          onInstalled: { addListener: () => {} },
          onMessage: { addListener: () => { listeners += 1; } },
          sendMessage: () => Promise.resolve(),
        },
        tabs: {
          // A tab message at INIT time is exactly what must not happen.
          sendMessage: () => { visibleRowSends += 1; return Promise.resolve({ rows: [] }); },
        },
        sidePanel: { setPanelBehavior: () => Promise.resolve() },
      };
      globals.fetch = () => { fetchCalls += 1; return Promise.reject(new Error('no fetch expected')); };
      // A distinct URL per load, so module side effects actually run each time.
      await import(`${pathToFileURL(workerBundle).href}?init=${(initSerial += 1)}`);
    } finally {
      globals.chrome = previous.chrome;
      globals.fetch = previous.fetch;
      console.log = previous.log;
    }
    return { visibleRowSends, fetchCalls, listeners };
  }

  it('initialisation sends NO visible-row request, executes no recommendation and fetches nothing', async () => {
    const observed = await observeInit();
    console.log(`  init: visibleRowSends=${observed.visibleRowSends} fetchCalls=${observed.fetchCalls} listeners=${observed.listeners}`);
    expect(observed.visibleRowSends).toBe(0);
    expect(observed.fetchCalls).toBe(0);
    // The worker really did load and register, so the zeros are not a failed import.
    expect(observed.listeners).toBe(1);
  }, 60_000);

  it('the artifact carries the primitive, and no standalone module was emitted', () => {
    const bundle = readFileSync(workerBundle, 'utf8');
    // The literal survives, which is what "the worker carries the capability" means.
    expect(bundle.includes('COURSE_COPILOT_QUERY_VISIBLE_ROWS')).toBe(true);
    expect(existsSync(join(distDir, 'background', 'visible-rows.js'))).toBe(false);
    // Still exactly six artifacts.
    const files: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) { walk(join(dir, entry.name), relative); continue; }
        files.push(relative);
      }
    };
    walk(distDir, '');
    expect(files.sort()).toEqual([
      'background/service-worker.js',
      'content/content-script.js',
      'manifest.json',
      'sidepanel/sidepanel.css',
      'sidepanel/sidepanel.html',
      'sidepanel/sidepanel.js',
    ]);
  });
});
