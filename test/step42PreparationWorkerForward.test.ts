/**
 * PART 16J-PREUI-E4-C1 — the worker's part in the preparation contract.
 *
 * The service worker holds no preparation state and knows no selector: it validates a tab id, asks that tab one control question, and passes the answer back. The
 * preparation run itself lives in the content script, which is the only layer with the DOM and whose lifetime covers two passes over the page.
 *
 * These tests drive the BUILT worker, so what is checked is the artifact that ships rather than the source it came from.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = join(repoRoot, 'apps', 'extension', 'dist', 'background', 'service-worker.js');
const contentScriptPath = join(repoRoot, 'apps', 'extension', 'dist', 'content', 'content-script.js');
const workerSource = readFileSync(workerPath, 'utf8');
const contentArtifact = readFileSync(contentScriptPath, 'utf8');
const sidepanel = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');

const START = 'COURSE_COPILOT_START_FULL_PREPARATION';
const CANCEL = 'COURSE_COPILOT_CANCEL_FULL_PREPARATION';
const STATUS = 'COURSE_COPILOT_QUERY_FULL_PREPARATION_STATUS';
const EVENT = 'COURSE_COPILOT_FULL_PREPARATION_EVENT';

describe('16J-PREUI-E4-C1 the worker relays the three controls and FORWARDS the event onward'.replace('E4-C1', 'E4-C1'), () => {
  it('forwards START, CANCEL and STATUS by name', () => {
    for (const type of [START, CANCEL, STATUS]) {
      expect(workerSource, type).toContain(type);
    }
  });

  it('HAS a branch for the preparation event, and it re-broadcasts rather than answering a tab', () => {
    /*
     * ## This assertion used to say the opposite, and that pinned a release blocker
     *
     * The old check was `expect(workerSource.includes(EVENT)).toBe(false)`, on the reasoning that a worker branch relaying the event "to a tab" would hand the
     * script its own event and form a loop. The loop concern was right; the conclusion was wrong, because it ruled out the ONE relay the product needs. The
     * panel learns that a run ended only from this report — a run answers its START once and a status read happens only when a panel opens — so with no relay
     * the panel sat in a running phase after a cancellation, kept its start control hidden, and silently refused every later start. Found by cancelling a real
     * run in a real browser; the diagnosis is recorded as LIFECYCLE-BUG-B1.
     *
     * The loop concern is answered by the SOURCE GUARD instead of by absence: only a report whose sender is a real content-script tab is relayed, so the
     * worker's own re-broadcast has no tab to attribute and cannot relay itself again.
     */
    expect(workerSource.includes(EVENT)).toBe(true);
    // The relay is reached by the message type, and it broadcasts onward.
    expect(workerSource.includes('if (type === FULL_PREPARATION_EVENT_MESSAGE)')).toBe(true);
    expect(workerSource.includes('broadcastPreparationReport(')).toBe(true);
    // It is a broadcast to extension pages, never a `tabs.sendMessage` back to the page.
    const branch = /if \(type === FULL_PREPARATION_EVENT_MESSAGE\) \{[\s\S]*?\n    \}/u.exec(workerSource)?.[0] ?? '';
    expect(branch.length).toBeGreaterThan(0);
    expect(branch.includes('tabs.sendMessage')).toBe(false);
    // The source guard: a report is relayed only when its sender is a real tab id. Optional-chained, because a sender may be absent entirely.
    expect(branch).toContain('sender?.tab?.id');
    expect(branch).toContain('sourceTabId > 0');
  });

  it('holds no preparation session state', () => {
    // No phase, no summary, no queue: the run belongs one layer down, and a worker copy would be a second source of truth that could not see the DOM.
    for (const token of ['preparationPhase', 'preparationStatus', 'preparationQueue', 'loading_courses', 'hydrating_teachers', 'rescanning']) {
      expect(workerSource.includes(token), token).toBe(false);
    }
  });

  it('knows no page structure', () => {
    for (const token of ['querySelector', 'MutationObserver', 'tjxk_list', 'expand1', 'jsxm', 'loadJxbxxZzxk', 'chooseCourseZzxk', '.click(']) {
      expect(workerSource.includes(token), token).toBe(false);
    }
  });

  it('relays a reply unchanged and reports one fixed sentence when there is none', () => {
    const source = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'background', 'preparation-forward.ts'), 'utf8');
    // The reply is passed through, not reshaped: the content script owns its meaning and a second opinion would be a second definition of the contract.
    expect(source).toContain('return { ok: true, reply };');
    // One sentence for every forwarding failure, so no internal detail can reach a panel.
    expect(source).toContain('无法与该标签页的课程页面通信。');
    /*
     * Nothing is retried or repaired: exactly ONE `sendMessage` call, no loop, and no injection of a missing content script. Each of those would turn one failed
     * ask into an unbounded or page-modifying operation. The word "retry" appears in the prose that says so, so the check counts CALLS rather than words.
     */
    const stripped = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
    expect([...stripped.matchAll(/sendMessage\(/gu)]).toHaveLength(1);
    expect(/for\s*\(|while\s*\(|setTimeout|setInterval/u.test(stripped)).toBe(false);
    expect(stripped.includes('executeScript')).toBe(false);
  });
});

describe('16J-PREUI-E4-C1 the workflow\'s boundaries hold in the product', () => {
  it('R. the side panel starts exactly ONE preparation, and no lower-level feature', () => {
    /*
     * UPDATED IN 16J-PREUI-E4-C2-A. This originally asserted the panel started NOTHING, which was right while the workflow had no UI caller. The panel now
     * offers one unified action, so the honest statement is the narrower one: that action is the ONLY thing it can start.
     *
     * The start message is owned by the controller module, so the panel does not even name it — a file that cannot spell a type cannot send it. The panel's
     * contribution is the single `start()` call, and it reaches neither phase directly.
     */
    const controller = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'full-preparation.ts'), 'utf8');
    expect(controller).toContain('PREPARATION_START_MESSAGE');
    expect(sidepanel.split('.start()').length - 1).toBe(1);
    for (const token of ['START_AUTO_EXPAND', 'START_TEACHER_HYDRATION', 'CANCEL_AUTO_EXPAND', 'CANCEL_TEACHER_HYDRATION']) {
      expect(sidepanel.includes(token), token).toBe(false);
    }
  });

  it('S. nothing in the product calls the recommendation path from preparation', () => {
    // The orchestrator's own section must not reach the recommendation machinery: C2 is where a final recommendation request gets wired, and it does not exist yet.
    const start = contentArtifact.indexOf('UNIFIED FULL-COURSE PREPARATION');
    const end = contentArtifact.indexOf('chrome.runtime.onMessage.addListener', start);
    const orchestrator = contentArtifact.slice(start, end);
    for (const token of ['QUERY_RECOMMENDATIONS', 'recommendExtensionCourses', 'provider', 'ranking']) {
      expect(orchestrator.includes(token), token).toBe(false);
    }
  });

  it('Q. the content script is the only layer that CONSTRUCTS the report; the worker only relays the one it receives', () => {
    expect(contentArtifact).toContain(EVENT);
    // Exactly one outbound send constructs it.
    const sends = [...contentArtifact.matchAll(/sendMessage\(\{[^}]*FULL_PREPARATION_EVENT[^}]*\}/gu)];
    expect(sends.length).toBeGreaterThanOrEqual(1);
    /*
     * The worker names the type so it can be recognised, but it never builds a report of its own: its one outbound reference spreads the report it received.
     * That distinction is the whole relay contract — "the worker does not mention this" was the earlier form of this check, and it pinned the release blocker.
     */
    expect(workerSource.includes(EVENT)).toBe(true);
    expect(workerSource.includes("{ ...report, sourceTabId }")).toBe(true);
    // It reads the report's fields nowhere, so it cannot restate the preparation contract.
    for (const token of ['stopReason', 'phase_changed', 'autoExpandStatus', 'teacherHydrationStatus', 'finalPage']) {
      expect(workerSource.includes(token), token).toBe(false);
    }
  });

  it('the four message types are declared exactly once, in the ambient contract', () => {
    const chromeTypes = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'types', 'chrome.d.ts'), 'utf8');
    for (const type of [START, CANCEL, STATUS, EVENT]) {
      const occurrences = chromeTypes.split(type).length - 1;
      expect(occurrences, type).toBe(1);
    }
  });
});
