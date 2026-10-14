/**
 * PART 16B-B3 — proof that a real `@course-copilot/core` function enters and RUNS inside the production worker bundle.
 *
 * ## Why a marker check is not enough on its own
 *
 * "The bundle contains core code" and "the bundle runs core code" are different claims. A marker only supports the first, and
 * since the probe throws when its expectation is unmet, loading the artifact is what supports the second: a worker whose core
 * call returned the wrong value would fail to initialise.
 *
 * ## Why the core function is DELETED from the bundle before the marker check
 *
 * A marker check that cannot fail proves nothing. This file removes exactly the harness-added `availabilityFromSeats`
 * declaration from the artifact's text and asserts the marker disappears, which shows the marker tracks the real code instead of
 * matching incidental text. The deletion is scoped to the function's own body, so the rest of the bundle is untouched.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = join(repoRoot, 'apps', 'extension', 'dist', 'background', 'service-worker.js');
const workerSourcePath = join(repoRoot, 'apps', 'extension', 'src', 'background', 'service-worker.ts');

/**
 * Core's seat→availability expression, matched with either quote style.
 *
 * esbuild rewrites string literals to double quotes, so searching for the single-quoted source form can never match a bundled
 * artifact. Matching the expression rather than one spelling keeps the check about the CODE.
 */
const CORE_MARKER = />\s*0\s*\?\s*["']available["']\s*:\s*["']full["']/u;

/** Load the worker bundle against a stub environment. Throws if the worker aborts during initialisation. */
function loadWorker(source: string): { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chrome = {
    runtime: {
      id: 'test-extension-id',
      // The worker reads the manifest version, so the stub must provide it or initialisation fails for an unrelated reason.
      getManifest: () => ({ version: '0.0.0-test', name: 'Course Copilot' }),
      onInstalled: { addListener: () => { calls.push({ method: 'onInstalled.addListener', args: [] }); } },
      onMessage: { addListener: () => { calls.push({ method: 'onMessage.addListener', args: [] }); } },
      /*
       * Deliberately a FAILING sendMessage. The worker calls it during initialisation, so if the bundle ever started depending
       * on a resolved promise this stub would surface that rather than hiding it.
       */
      sendMessage: (message: unknown) => {
        calls.push({ method: 'runtime.sendMessage', args: [message] });
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
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.reject(new Error('Receiving end does not exist.')),
    },
  };

  /*
   * No accessor for `availabilityFromSeats` here.
   *
   * An earlier version defined one on the sandbox to make an absent core function loud. That backfired for a `node:vm` reason
   * worth recording: an own accessor property SHADOWS a top-level function declaration of the same name inside the context, so
   * the accessor fired even though the bundle declared the function — the test failed while the code was correct. Absence is
   * instead modelled the honest way, by deleting the declaration from the bundle text (see the tree-shaking test below).
   */
  const sandbox: Record<string, unknown> = {
    chrome,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  sandbox['globalThis'] = sandbox;

  vm.createContext(sandbox);
  new vm.Script(source, { filename: 'service-worker.js' }).runInContext(sandbox);
  return { calls };
}

/**
 * Locate the inlined `availabilityFromSeats` declaration and return its exact span.
 *
 * Brace DEPTH is tracked rather than searching for the first `\n  }`, because the function body contains braces of its own: the
 * naive search ended the span early, left an unbalanced brace behind, and made the test fail on a `SyntaxError` instead of on the
 * missing core code.
 */
function coreCodeSpan(source: string): { start: number; end: number } {
  const start = source.indexOf('function availabilityFromSeats');
  if (start < 0) throw new Error('产物中找不到 availabilityFromSeats 声明');
  const open = source.indexOf('{', start);
  if (open < 0) throw new Error('无法定位 availabilityFromSeats 的函数体起点');
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return { start, end: index + 1 };
    }
  }
  throw new Error('无法定位 availabilityFromSeats 的函数体结尾');
}

/** Replace the inlined core function with a syntactically valid stub that contains no core logic. */
function withStubbedCore(source: string): string {
  const { start, end } = coreCodeSpan(source);
  const noCore = 'function availabilityFromSeats() {\n    return "no-core";\n  }';
  return source.slice(0, start) + noCore + source.slice(end);
}

const workerSource = readFileSync(workerPath, 'utf8');

describe('16B-B3 core runs inside the production worker bundle', () => {
  it('the production source imports core by its declared public path, and nothing wider', () => {
    /*
     * UPDATED IN 16F-C. This used to require that core was the ONLY import, which was true while the worker did one thing. The
     * wiring step deliberately added the provider package, one core TYPE, and the worker's own cache, so the assertion now fixes
     * the complete set — a stricter statement than the old one, since anything unexpected fails rather than merely not matching a
     * single-element list.
     *
     * UPDATED IN 16I-E for the recommendation package, IN 16I-F for the extension's own policy module, IN 16I-G for the runner,
     * IN 16J-B for the visible-row sender primitive, IN 16J-E for the composed page reader, IN 16J-F-B for the full composition that
     * supersedes `./visible-courses.js`, and IN 16J-F-B-R1 which REMOVED `./recommendation-runtime.js` as redundant. The runner
     * REPLACED the direct engine import, so `@course-copilot/recommendation` is not here either — the runner is the worker's route to
     * the engine, and it carries this host's policy binding. The runner itself now arrives through the composition.
     *
     * What this test exists for is unchanged: core arrives by a DECLARED public subpath, and no wide core surface rides along.
     *
     * UPDATED IN PRE-RELEASE-UX-A4C. The list had been frozen before the three FORWARDING modules landed, so it still named seven
     * specifiers while the worker imports ten. Each addition is a relay the unified preparation workflow needs, and each is
     * exercised by its own part: `./auto-expand-forward.js` carries the load-more session, `./teacher-hydration-forward.js` carries
     * the teacher-hydration session, and `./preparation-forward.js` carries the full-preparation session. All three are imported
     * for their `*_FORWARDED_TYPES` sets and their `forward*Message` relays, both of which the worker uses at its listener.
     *
     * The list stays EXACT, so a new import still fails here rather than passing unnoticed.
     */
    const source = readFileSync(workerSourcePath, 'utf8');
    const specifiers = [...source.matchAll(/^\s*import\s[^\n]*?from\s*['"]([^'"]+)['"]/gmu)].map((match) => match[1] ?? '');
    expect(specifiers.sort()).toEqual([
      '@course-copilot/core/course',
      '@course-copilot/core/eligibility',
      '@course-copilot/provider',
      './auto-expand-forward.js',
      './availability-filter-forward.js',
      './memory-cache.js',
      './preparation-forward.js',
      './public-review-fetch.js',
      './recommendation-policy.js',
      './teacher-hydration-forward.js',
      './visible-recommendations.js',
    ].sort());
    // The imported name is the one the probe calls, and nothing wider is pulled in.
    expect(source.includes('availabilityFromSeats')).toBe(true);
    for (const forbidden of ['ranking', 'matcher', 'aspects/lexicon', 'core/parse']) {
      expect(new RegExp(`from '[^']*${forbidden}`, 'iu').test(source), forbidden).toBe(false);
    }
    /*
     * The recommendation dependency is the RUNNER's, not the worker's. UPDATED IN 16I-G, which moved the route: the runner is the
     * module that binds this host's policy, so it is where the package import belongs. What must never happen — and is asserted
     * both here and in the runner's own tests — is reaching the application's compatibility wrapper.
     */
    const runnerPath = join(repoRoot, 'apps', 'extension', 'src', 'background', 'recommendation-runtime.ts');
    expect(readFileSync(runnerPath, 'utf8').includes("from '@course-copilot/recommendation'")).toBe(true);
    expect(/from\s*'[^']*src\/pipeline/u.test(source)).toBe(false);
  });

  it('core code is physically present in the built bundle', () => {
    expect(CORE_MARKER.test(workerSource)).toBe(true);
    expect(workerSource.includes('availabilityFromSeats')).toBe(true);
  });

  it('TREE-SHAKING NEGATIVE: a worker without core logic fails its own probe', () => {
    /*
     * This is the check that makes "the source imports core" insufficient on its own. With the core function replaced by a stub,
     * the artifact still parses and the probe still runs — and must now THROW, because there is no core logic behind the call.
     *
     * A probe that had been optimised away, or an import that had been dropped, could not produce this failure; and a build that
     * merely happened to succeed would be caught here rather than reported as proof.
     */
    const stubbed = withStubbedCore(workerSource);
    expect(CORE_MARKER.test(stubbed)).toBe(false);
    expect(() => loadWorker(stubbed)).toThrow(/core bundle probe 失败/u);
  });

  it('the bundle EXECUTES the core call: the worker initialises without throwing', () => {
    /*
     * The probe throws unless `availabilityFromSeats(0) === 'full'`, so reaching the end of this call means the inlined core
     * code actually ran and answered correctly.
     *
     * The failure is caught and re-thrown with its name and message, because a bare "ReferenceError was thrown" says nothing
     * about WHICH reference was missing.
     */
    try {
      loadWorker(workerSource);
    } catch (error) {
      throw new Error(`worker 初始化失败：${(error as Error).name}: ${(error as Error).message}`);
    }
  });

  it('a wrong core expectation would abort initialisation', () => {
    /*
     * The control for the test above: with the bundle's expectation flipped, the probe must throw. Without this, "it did not
     * throw" could mean the probe is inert.
     */
    const flipped = workerSource.replace(
      /if \(coreBundleProbe !== "full"\)/u,
      'if (coreBundleProbe !== "available")',
    );
    expect(flipped).not.toBe(workerSource);
    expect(() => loadWorker(flipped)).toThrow();
  });

  it('no message type was added for the probe, and its result never leaves the worker', () => {
    /*
     * UPDATED IN 16G-C: the public-review message is a fifth type. The set is still fixed exactly, so this continues to fail if a
     * message is added for a debug probe.
     *
     * UPDATED IN 16J-B, and the SCOPE of each number is now stated because a bare count had become ambiguous. Two artifacts are
     * being read and they are not the same thing:
     *
     * - `workerSource` in this file is the BUILT BUNDLE, so it is the BACKGROUND RUNTIME — the worker plus every module it
     *   imports. It gained `COURSE_COPILOT_QUERY_VISIBLE_ROWS` when the worker began importing the visible-row sender, and the
     *   type is declared in THAT module, not in the worker.
     * - the worker's own SOURCE file still declares five.
     *
     * The regex must also accept EITHER quote style. esbuild rewrites string literals to double quotes, so a single-quoted pattern
     * can never match a bundled artifact by construction — the same trap the skeleton gate documents for its core marker. That is
     * what made an earlier version of this check report zero declarations.
     *
     * UPDATED IN PRE-RELEASE-UX-A4C. The runtime gained the three forwarding modules, and each names the message types it relays so
     * it can match on them. That takes the runtime's surface from seven to SIXTEEN, which is the natural result of the unified
     * preparation workflow rather than anything added for a probe: nine of the ten new names are the auto-expand, teacher-hydration
     * and full-preparation start/cancel/status/event types, and the tenth is `QUERY_VISIBLE_ROWS`, which the runtime already had.
     *
     * The check's PURPOSE is unchanged — it still fails if a type is added for a debug probe — and the list is still exact.
     *
     * UPDATED IN RELEASE-BLOCKER-B1, which added one name: `COURSE_COPILOT_FULL_PREPARATION_EVENT`. Unlike the availability-filter event above, this one IS
     * named by the worker, because the worker relays it onward to extension pages so the panel can learn that a run ended. Naming it for attribution is not the
     * same as receiving it back from a tab: the relay's source guard requires a content-script tab, and the worker sends nothing to a tab on this path.
     */
    const bundleTypes = [...workerSource.matchAll(/COURSE_COPILOT_[A-Z_]+/gu)].map((match) => match[0]);
    expect([...new Set(bundleTypes)].sort()).toEqual([
      /*
       * The availability filter contributes three names here, not four: the worker RELAYS start, cancel and status, while
       * `COURSE_COPILOT_AVAILABILITY_FILTER_EVENT` travels FROM the content script UP and is deliberately never received by the worker — a branch for it
       * would hand the message back to the script that sent it. Its absence from this list is therefore a fact about the design, not an omission.
       */
      'COURSE_COPILOT_CANCEL_AUTO_EXPAND',
      'COURSE_COPILOT_CANCEL_AVAILABILITY_FILTER',
      'COURSE_COPILOT_CANCEL_FULL_PREPARATION',
      'COURSE_COPILOT_CANCEL_TEACHER_HYDRATION',
      'COURSE_COPILOT_FULL_PREPARATION_EVENT',
      'COURSE_COPILOT_PAGE_STATUS',
      'COURSE_COPILOT_PANEL_COUNT',
      'COURSE_COPILOT_PING',
      'COURSE_COPILOT_QUERY_AUTO_EXPAND_STATUS',
      'COURSE_COPILOT_QUERY_AVAILABILITY_FILTER_STATUS',
      'COURSE_COPILOT_QUERY_FULL_PREPARATION_STATUS',
      'COURSE_COPILOT_QUERY_PUBLIC_REVIEWS',
      'COURSE_COPILOT_QUERY_RECOMMENDATIONS',
      'COURSE_COPILOT_QUERY_STATUS',
      'COURSE_COPILOT_QUERY_TEACHER_HYDRATION_STATUS',
      'COURSE_COPILOT_QUERY_VISIBLE_ROWS',
      'COURSE_COPILOT_START_AUTO_EXPAND',
      'COURSE_COPILOT_START_AVAILABILITY_FILTER',
      'COURSE_COPILOT_START_FULL_PREPARATION',
      'COURSE_COPILOT_START_TEACHER_HYDRATION',
    ]);
    /*
     * BACKGROUND RUNTIME declarations, read from the bundle: either quote style, and any declaration keyword. EIGHT after RELEASE-BLOCKER-B1, which made the
     * worker name the preparation report so it can be relayed — seven declared by the worker itself, one by the transport helper it imports.
     */
    const runtimeDeclared = [...workerSource.matchAll(/(?:var|const|let) \w+_MESSAGE = ['"](COURSE_COPILOT_[A-Z_]+)['"]/gu)].map((match) => match[1]);
    expect(runtimeDeclared).toHaveLength(8);
    // SERVICE-WORKER FILE declarations, read from the source file, are seven.
    const workerFileSource = readFileSync(workerSourcePath, 'utf8');
    const fileDeclared = [...workerFileSource.matchAll(/(?:var|const|let) \w+_MESSAGE = ['"](COURSE_COPILOT_[A-Z_]+)['"]/gu)].map((match) => match[1]);
    expect(fileDeclared).toHaveLength(7);
    // The eighth is declared by the helper the worker imports, which is exactly why the runtime count is higher.
    const helperSource = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'background', 'visible-rows.ts'), 'utf8');
    expect([...helperSource.matchAll(/(?:var|const|let) \w+_MESSAGE = ['"](COURSE_COPILOT_[A-Z_]+)['"]/gu)].map((match) => match[1]))
      .toEqual(['COURSE_COPILOT_QUERY_VISIBLE_ROWS']);
    for (const forbidden of ['CORE_PROBE', 'TEST_CORE', 'DEBUG_CORE']) {
      expect(workerSource.includes(forbidden), forbidden).toBe(false);
    }
    // The probe binding is read into a local and compared; it is never sent anywhere.
    expect(/sendMessage\([^)]*coreBundleProbe/u.test(workerSource)).toBe(false);
  });

  it('the bundle stays self-contained and Node-free', () => {
    /*
     * UPDATED IN 16F-C. `WhucoursesProvider` and `RequestLimiter` were on the forbidden list because nothing may ride in on the
     * core import. They are now BUNDLED ON PURPOSE — that is the wiring — so the list keeps only what must never appear: the Node
     * host's cache, its filesystem modules, and any leftover module syntax.
     *
     * The properties this test is actually about are untouched: the bundle has no imports left (everything is inlined), reaches no
     * `node:` built-in, and calls no `require`.
     */
    const specifiers = [...workerSource.matchAll(/(?:^|\n)\s*import\s[^\n]*from\s*['"]([^'"]+)['"]/gmu)]
      .map((match) => match[1] ?? '');
    expect(specifiers).toEqual([]);
    expect(/['"]node:[^'"]+['"]/u.test(workerSource)).toBe(false);
    expect(/\brequire\s*\(\s*['"]/u.test(workerSource)).toBe(false);
    // The browser cache rode in, but the Node host's cache and filesystem must not have.
    expect(workerSource.includes('MemoryCache')).toBe(true);
    for (const symbol of ['TtlCache', 'node:fs/promises', 'node:path', 'createNodeWhucoursesProvider']) {
      expect(workerSource.includes(symbol), symbol).toBe(false);
    }
  });
});
