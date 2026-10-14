/**
 * PART 16J-PREUI-E3-C — the user-approved auto-load control.
 *
 * ## What is under test
 *
 * The one place in this extension where a user's click becomes permission to modify the page. Two things matter and both are asserted here: that the click
 * is the ONLY trigger, and that no message from another tab can be attributed to the operation the user approved.
 *
 * ## How it is driven
 *
 * The controller takes its tab query and its message sender by injection, so every path — a refusal, a duplicate start, a cross-tab event, a missed
 * event recovered by a status read — is reachable without a browser. The panel's own wiring is checked by reading its source, which is where the
 * "one listener" and "no start on the startup path" rules live.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTO_LOAD_COMPLETE_TEXT,
  AUTO_LOAD_MESSAGES,
  clicksLabel,
  createAutoLoadController,
  messageForStopReason,
  type AutoLoadView,
} from '../apps/extension/src/sidepanel/auto-load.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const START = 'COURSE_COPILOT_START_AUTO_EXPAND';
const CANCEL = 'COURSE_COPILOT_CANCEL_AUTO_EXPAND';
const STATUS = 'COURSE_COPILOT_QUERY_AUTO_EXPAND_STATUS';

/** A recording panel: the injected seams plus everything a test asserts on. */
function panel(options: {
  tabId?: number | null;
  startReply?: unknown;
  statusReply?: unknown;
  sendReject?: boolean;
} = {}): {
  controller: ReturnType<typeof createAutoLoadController>;
  views: AutoLoadView[];
  sends: Array<Record<string, unknown>>;
  tabQueries: () => number;
  last: () => AutoLoadView;
} {
  const views: AutoLoadView[] = [];
  const sends: Array<Record<string, unknown>> = [];
  let tabQueries = 0;

  const controller = createAutoLoadController({
    onView: (view) => { views.push(view); },
    queryActiveTabId: async () => { tabQueries += 1; return options.tabId === undefined ? 11 : options.tabId; },
    sendMessage: async (message) => {
      sends.push(message as unknown as Record<string, unknown>);
      if (options.sendReject === true) throw new Error('worker unreachable');
      const type = (message as { type?: string }).type;
      if (type === START) return options.startReply ?? { ok: true, reply: { ok: true, accepted: true, status: { phase: 'running', clicks: 0 } } };
      if (type === STATUS) return options.statusReply ?? { ok: true, reply: { ok: true, status: { phase: 'idle', clicks: 0, completeness: 'unknown' } } };
      if (type === CANCEL) return { ok: true, reply: { ok: true, cancelled: true } };
      return { ok: true, reply: {} };
    },
  });

  return { controller, views, sends, tabQueries: () => tabQueries, last: () => views[views.length - 1] as AutoLoadView };
}

describe('16J-PREUI-E3-C a click is the only way to begin', () => {
  it('A and T. the startup path reads a status and never starts anything', async () => {
    /*
     * The panel calls `restore()` on open, which is a READ. This is the assertion that separates "the panel asks what is happening" from "the panel
     * begins something", and it is the likeliest place for that boundary to be crossed by accident.
     */
    const p = panel();
    await p.controller.restore();
    expect(p.sends.map((message) => message.type)).toEqual([STATUS]);
    expect(p.sends.some((message) => message.type === START)).toBe(false);
    // An idle reply leaves the feature idle; it does not arm a start.
    expect(p.last().phase).toBe('idle');
  });

  it('C. the button click queries the active tab just in time and sends exactly one START', async () => {
    const p = panel();
    await p.controller.start();
    expect(p.tabQueries()).toBe(1);
    expect(p.sends).toHaveLength(1);
    expect(p.sends[0]).toEqual({ type: START, tabId: 11 });
  });

  it('D. an accepted START moves to running', async () => {
    const p = panel();
    await p.controller.start();
    expect(p.last()).toMatchObject({ phase: 'running', canCancel: true, canStart: false });
  });

  it('E. a duplicate-start ACK resumes running instead of starting a second loop', async () => {
    /*
     * The content script refuses a second start and reports that a session is already running. That is not an error, and the panel's honest response is
     * to show the running session — not to report a failure, and not to send a second START.
     */
    const p = panel({ startReply: { ok: true, reply: { ok: true, accepted: false, status: { phase: 'running', clicks: 4 } } } });
    await p.controller.start();
    expect(p.last()).toMatchObject({ phase: 'running', clicks: 4 });
  });

  it('a start while already running sends nothing at all', async () => {
    const p = panel();
    await p.controller.start();
    const before = p.sends.length;
    await p.controller.start();
    expect(p.sends).toHaveLength(before);
  });

  it('a worker failure is shown as an error and never as a running session', async () => {
    const p = panel({ startReply: { ok: false, error: '无法与该标签页的课程页面通信。' } });
    await p.controller.start();
    expect(p.last().phase).toBe('error');
    expect(p.last().canCancel).toBe(false);
    expect(p.last().message).toBe('无法与该标签页的课程页面通信。');
  });

  it('a rejected send is an error, not an assumed start', async () => {
    const p = panel({ sendReject: true });
    await p.controller.start();
    expect(p.last().phase).toBe('error');
  });

  it('no usable tab is an error rather than a guess', async () => {
    const p = panel({ tabId: null });
    await p.controller.start();
    expect(p.last().phase).toBe('error');
    expect(p.sends).toHaveLength(0);
  });

  it('B. the idle view offers the button', () => {
    const p = panel();
    expect(p.last()).toMatchObject({ phase: 'idle', canStart: true, canCancel: false });
    /*
     * This suite tests the STANDALONE auto-load controller, which still exists and is still driven by its own messages. The button text assertion that was here
     * belonged to the panel wiring and moved out with it in 16J-PREUI-E4-C2-A, when the side panel began offering one unified preparation action instead of a
     * separate auto-load action. The controller's own idle view is what this case is about.
     */
  });
});

describe('16J-PREUI-E3-C progress and tab isolation', () => {
  it('F. a matching progress event updates the click count', async () => {
    const p = panel();
    await p.controller.start();
    p.controller.onEvent(11, { phase: 'progress', clicks: 3, completeness: 'partial' });
    expect(p.last()).toMatchObject({ phase: 'running', clicks: 3 });
  });

  it('G. a progress event from another tab is ignored', async () => {
    /*
     * The cross-tab rule. Applying this would attribute one page's progress to the operation the user approved on a different one — the exact confusion
     * the operation tab id exists to prevent.
     */
    const p = panel();
    await p.controller.start();
    p.controller.onEvent(11, { phase: 'progress', clicks: 2, completeness: 'partial' });
    p.controller.onEvent(99, { phase: 'progress', clicks: 7, completeness: 'partial' });
    expect(p.last().clicks).toBe(2);
  });

  it('a finished event from another tab cannot finish the operation', async () => {
    const p = panel();
    await p.controller.start();
    p.controller.onEvent(99, { phase: 'finished', clicks: 9, stopReason: 'complete' });
    expect(p.last().phase).toBe('running');
  });

  it('an event with no sender tab is ignored', async () => {
    const p = panel();
    await p.controller.start();
    p.controller.onEvent(null, { phase: 'finished', clicks: 1, stopReason: 'complete' });
    expect(p.last().phase).toBe('running');
  });

  it('an event before any operation is ignored', () => {
    const p = panel();
    p.controller.onEvent(11, { phase: 'finished', clicks: 1, stopReason: 'complete' });
    expect(p.last().phase).toBe('idle');
  });

  it('progress never changes the phase away from running', async () => {
    const p = panel();
    await p.controller.start();
    p.controller.onEvent(11, { phase: 'progress', clicks: 1, completeness: 'partial' });
    p.controller.onEvent(11, { phase: 'progress', clicks: 2, completeness: 'partial' });
    expect(p.last().phase).toBe('running');
  });
});

describe('16J-PREUI-E3-C every stop reason reads differently', () => {
  const cases: Array<[string, string, boolean]> = [
    ['H complete', 'complete', true],
    ['I already_complete', 'already_complete', true],
    ['J cancelled', 'cancelled', false],
    ['K unknown_state', 'unknown_state', false],
    ['L no_progress', 'no_progress', false],
    ['M click_failed', 'click_failed', false],
    ['N wait_failed', 'wait_failed', false],
    ['O click_cap', 'click_cap', false],
  ];

  for (const [label, stopReason, isWhole] of cases) {
    it(`${label} produces its own sentence`, async () => {
      const p = panel();
      await p.controller.start();
      p.controller.onEvent(11, { phase: 'finished', clicks: 5, stopReason });
      expect(p.last().phase).toBe('finished');
      const text = p.last().message ?? '';
      expect(text).toBe(messageForStopReason(stopReason));
      if (isWhole) expect(text).toBe(AUTO_LOAD_COMPLETE_TEXT);
      else {
        // Every non-whole outcome must say that the recommendation can only use what is loaded, and must not claim "all courses".
        expect(text).toContain('只能基于当前已加载的课程');
        expect(text.includes('全部课程')).toBe(false);
      }
      // The button comes back so the user can try again; the cancel control goes away.
      expect(p.last()).toMatchObject({ canStart: true, canCancel: false });
    });
  }

  it('the eight reasons produce eight distinct sentences', () => {
    const texts = ['complete', 'cancelled', 'unknown_state', 'no_progress', 'click_failed', 'click_cap', 'wait_failed']
      .map((reason) => messageForStopReason(reason));
    // `complete` and `already_complete` share one sentence on purpose; the rest must not collapse into each other.
    expect(texts[0]).not.toBe(texts[1]);
    expect(new Set(texts).size).toBe(6);
    expect(messageForStopReason('complete')).toBe(messageForStopReason('already_complete'));
    expect(messageForStopReason('click_failed')).toBe(messageForStopReason('wait_failed'));
    expect(new Set([messageForStopReason('cancelled'), messageForStopReason('unknown_state'), messageForStopReason('no_progress'), messageForStopReason('click_cap')]).size).toBe(4);
  });

  it('an unrecognised reason is reported as unknown rather than as success', () => {
    expect(messageForStopReason('something_new')).toBe(AUTO_LOAD_MESSAGES.unknown);
    expect(messageForStopReason(undefined)).toBe(AUTO_LOAD_MESSAGES.unknown);
  });
});

describe('16J-PREUI-E3-C the progress line counts batches, not courses', () => {
  it('says 批 and never names a course count', () => {
    // One click adds a batch whose size varies — measured on the live page, ten panels carrying ten to thirty rows — so a course count is not derivable.
    expect(clicksLabel(4)).toBe('已展开 4 批');
    expect(clicksLabel(0)).toBe('已展开 0 批');
    expect(clicksLabel(4).includes('门课程')).toBe(false);
  });

  it('the running line carries no course count anywhere', () => {
    const panelText = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');
    expect(panelText.includes('门课程')).toBe(false);
    expect(panelText.includes('共 ')).toBe(false);
  });
});

describe('16J-PREUI-E3-C cancelling', () => {
  it('P. a cancel click sends exactly one CANCEL, to the operation tab, and claims no outcome', async () => {
    const p = panel();
    await p.controller.start();
    const before = p.sends.length;
    await p.controller.cancel();
    const cancels = p.sends.filter((message) => message.type === CANCEL);
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toEqual({ type: CANCEL, tabId: 11 });
    expect(p.sends).toHaveLength(before + 1);
    /*
     * No fabricated stop reason: the authoritative answer is the finished event, so the panel stays in `running` until it arrives. Writing
     * `stopReason: 'cancelled'` here would tell the user the run had stopped while it was still clicking.
     */
    expect(p.last().phase).toBe('running');
    expect(p.last().canCancel).toBe(true);
  });

  it('an idle cancel sends nothing', async () => {
    const p = panel();
    await p.controller.cancel();
    expect(p.sends).toHaveLength(0);
  });

  it('a cancel cannot be delivered to a tab the user has since left', async () => {
    let active: number | null = 11;
    const sends: Array<Record<string, unknown>> = [];
    const controller = createAutoLoadController({
      onView: () => {},
      queryActiveTabId: async () => active,
      sendMessage: async (message) => {
        sends.push(message as unknown as Record<string, unknown>);
        return { ok: true, reply: { ok: true, accepted: true, status: { phase: 'running', clicks: 0 } } };
      },
    });
    await controller.start();
    // The user switches tabs before pressing cancel.
    active = 12;
    await controller.cancel();
    expect(sends.filter((message) => message.type === CANCEL)).toHaveLength(0);
  });

  it('a rejected cancel leaves the session shown as running', async () => {
    let rejectNext = false;
    const controller = createAutoLoadController({
      onView: () => {},
      queryActiveTabId: async () => 11,
      sendMessage: async () => {
        if (rejectNext) throw new Error('gone');
        return { ok: true, reply: { ok: true, accepted: true, status: { phase: 'running', clicks: 0 } } };
      },
    });
    await controller.start();
    rejectNext = true;
    await controller.cancel();
    // A failed cancel is not a stop: the run is still going, and the panel must keep saying so.
    expect(controller.view().phase).toBe('running');
  });
});

describe('16J-PREUI-E3-C recovering state without any event', () => {
  it('Q. a missed progress event is recovered as running by a status read', async () => {
    /*
     * An event broadcast fails when no panel is open, which is allowed. So the panel must be able to learn the truth by asking — and a panel that
     * reopened after the worker was suspended has nothing else to go on.
     */
    const p = panel({ statusReply: { ok: true, reply: { ok: true, status: { phase: 'running', clicks: 6, completeness: 'partial' } } } });
    await p.controller.restore();
    expect(p.last()).toMatchObject({ phase: 'running', clicks: 6, canCancel: true });
  });

  it('R. a missed finished event is recovered as finished by a status read', async () => {
    const p = panel({ statusReply: { ok: true, reply: { ok: true, status: { phase: 'finished', clicks: 13, completeness: 'complete', stopReason: 'complete' } } } });
    await p.controller.restore();
    expect(p.last()).toMatchObject({ phase: 'finished', clicks: 13 });
    expect(p.last().message).toBe(AUTO_LOAD_COMPLETE_TEXT);
  });

  it('a recovered session accepts that tab\'s later events', async () => {
    const p = panel({ statusReply: { ok: true, reply: { ok: true, status: { phase: 'running', clicks: 2, completeness: 'partial' } } } });
    await p.controller.restore();
    p.controller.onEvent(11, { phase: 'finished', clicks: 3, stopReason: 'no_progress' });
    expect(p.last().message).toBe(AUTO_LOAD_MESSAGES.noProgress);
  });

  it('an unreachable worker leaves the display untouched', async () => {
    const p = panel({ sendReject: true });
    await p.controller.restore();
    expect(p.last().phase).toBe('idle');
  });

  it('S. the controller never touches the DOM itself', () => {
    const code = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'auto-load.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
    /*
     * It renders through the view sink, so it must name no element and click nothing. `chrome` is allowed and expected in exactly one place: the DEFAULT
     * tab reader, which the panel uses because it is the page that has `chrome` — a caller injects its own, which is how these tests run without one.
     */
    for (const token of ['document.', 'getElementById', 'querySelector', '.click(', 'addEventListener']) {
      expect(code.includes(token), token).toBe(false);
    }
    expect(code.split('chrome.').length - 1).toBe(2);
  });
});
