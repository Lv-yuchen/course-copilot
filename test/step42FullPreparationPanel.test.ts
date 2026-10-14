/**
 * PART 16J-PREUI-E4-C2-A — the side panel's one-approval data-preparation control.
 *
 * ## What these tests are about
 *
 * The panel's job is narrow and its mistakes are all of one kind: claiming something the content script did not report. So the assertions concentrate on the
 * boundaries — that ONE user action starts ONE preparation, that only the operation's own tab can update the display, that every stop reason reads differently,
 * that the counts are labelled for what they are, and that no recommendation is requested.
 *
 * The controller is driven through its injectable seams, and the production wiring is checked against the built files, so both halves are covered without a
 * browser.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFullPreparationController,
  finalPageText,
  preparationFinishText,
  preparationProgressText,
  PREPARATION_CANCEL_MESSAGE,
  PREPARATION_EVENT_MESSAGE,
  PREPARATION_MESSAGES,
  PREPARATION_START_MESSAGE,
  PREPARATION_STATUS_MESSAGE,
  type PreparationView,
} from '../apps/extension/src/sidepanel/full-preparation.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sidepanelSource = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');
const sidepanelHtml = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'sidepanel.html'), 'utf8');
const panelArtifact = readFileSync(join(repoRoot, 'apps', 'extension', 'dist', 'sidepanel', 'sidepanel.js'), 'utf8');
/**
 * The built MARKUP, which is where the button label and the approval paragraph actually live.
 *
 * Measured: neither string is in the JS bundle at all — the HTML is copied verbatim and read by the panel at runtime. Asserting them against `panelArtifact` was
 * a wrong-target check that happened to look right, and it failed the moment it was pointed at the new label.
 */
const builtHtml = readFileSync(join(repoRoot, 'apps', 'extension', 'dist', 'sidepanel', 'sidepanel.html'), 'utf8');

/**
 * The approval copy, read from the ONE place it exists.
 *
 * ## Why this is no longer an exported constant
 *
 * Until PRE-RELEASE-UX-A10 the copy lived twice: as `PREPARATION_APPROVAL_COPY` in `full-preparation.ts`, and as the rendered paragraph in `sidepanel.html`. The
 * constant had NO production caller, and the two were held together by `expect(sidepanelHtml).toContain(PREPARATION_APPROVAL_COPY)` — a SUBSTRING check. The
 * rendered paragraph was already LONGER than the constant by a trailing sentence, so the constant was a prefix of the copy being compared to it and the assertion
 * could not fail. Two independently editable copies existed and the test could not tell.
 *
 * The paragraph in the HTML is now the only copy, and this extracts it so the assertions below read the text a user actually sees.
 */
const APPROVAL_NOTE_ID = 'full-preparation-note';
const approvalCopy = ((): string => {
  const start = sidepanelHtml.indexOf(`id="${APPROVAL_NOTE_ID}"`);
  if (start < 0) throw new Error(`the approval paragraph #${APPROVAL_NOTE_ID} was not found in sidepanel.html`);
  const open = sidepanelHtml.indexOf('>', start);
  const close = sidepanelHtml.indexOf('</p>', open);
  if (open < 0 || close < 0) throw new Error('the approval paragraph is not a closed <p> element');
  return sidepanelHtml.slice(open + 1, close).replace(/\s+/gu, ' ').trim();
})();

/** The rendered primary button's own label. */
const primaryButtonLabel = ((): string => {
  const start = sidepanelHtml.indexOf('id="full-preparation-start"');
  if (start < 0) throw new Error('the primary preparation button was not found in sidepanel.html');
  const open = sidepanelHtml.indexOf('>', start);
  const close = sidepanelHtml.indexOf('</button>', open);
  if (open < 0 || close < 0) throw new Error('the primary preparation button is not a closed <button>');
  return sidepanelHtml.slice(open + 1, close).trim();
})();

/**
 * The built panel with esbuild's `\uXXXX` escaping undone.
 *
 * Measured: esbuild writes non-ASCII literals as UPPERCASE `\uXXXX`, so `includes('有余量')` against the raw bundle answers `false` for text that IS present.
 * Every Chinese assertion against a bundled artifact must decode first or it passes vacuously.
 */
const decodedPanelArtifact = panelArtifact.replace(/\\u([0-9a-fA-F]{4})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

const AUTO_EXPAND_EVENT = 'COURSE_COPILOT_AUTO_EXPAND_EVENT';
const HYDRATION_EVENT = 'COURSE_COPILOT_TEACHER_HYDRATION_EVENT';

/** A status object shaped as the content script reports one. */
function status(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ok: true, phase: 'idle', ...overrides };
}

/** Drive a controller with recorded views, sends and tab queries. */
function build(options: {
  tabId?: number | null;
  startReply?: unknown;
  statusReply?: unknown;
  sendReject?: boolean;
} = {}): {
  controller: ReturnType<typeof createFullPreparationController>;
  views: PreparationView[];
  sends: Array<Record<string, unknown>>;
  tabQueries: () => number;
  last: () => PreparationView;
} {
  const views: PreparationView[] = [];
  const sends: Array<Record<string, unknown>> = [];
  let tabQueries = 0;

  const controller = createFullPreparationController({
    onView: (view) => { views.push(view); },
    queryActiveTabId: async () => { tabQueries += 1; return options.tabId === undefined ? 11 : options.tabId; },
    sendMessage: async (message) => {
      sends.push(message as unknown as Record<string, unknown>);
      if (options.sendReject === true) throw new Error('worker unreachable');
      const type = (message as { type?: string }).type;
      if (type === PREPARATION_START_MESSAGE) {
        return options.startReply ?? { ok: true, reply: { ok: true, accepted: true, status: status({ phase: 'loading_courses' }) } };
      }
      if (type === PREPARATION_STATUS_MESSAGE) {
        return options.statusReply ?? { ok: true, reply: { ok: true, status: status({}) } };
      }
      if (type === PREPARATION_CANCEL_MESSAGE) return { ok: true, reply: { ok: true, cancelled: true } };
      return { ok: true, reply: {} };
    },
  });

  return { controller, views, sends, tabQueries: () => tabQueries, last: () => views[views.length - 1] as PreparationView };
}

/** Just the message types a run sent, in order. */
function types(sends: Array<Record<string, unknown>>): string[] {
  return sends.map((message) => String(message.type));
}

describe('16J-PREUI-E4-C2-A one approval starts one preparation'.replace('E4-C2-A', 'E4-C2-A'), () => {
  it('A. startup queries the status and sends no start', async () => {
    const h = build({ statusReply: { ok: true, reply: { ok: true, status: status({}) } } });
    await h.controller.restore();
    expect(types(h.sends)).toEqual([PREPARATION_STATUS_MESSAGE]);
    // An idle status leaves the feature idle. Recovery is a read, and a read starts nothing.
    expect(h.last().phase).toBe('idle');
    expect(h.last().canStart).toBe(true);
  });

  it('B. the idle view offers the unified action', () => {
    const h = build();
    expect(h.last()).toMatchObject({ phase: 'idle', canStart: true, canCancel: false, clicks: 0, hydration: null, finalRowCount: null });
  });

  it('D. one click reads the active tab just in time and sends exactly one START', async () => {
    const h = build();
    await h.controller.start();
    // The tab is read for this action, not remembered from panel open.
    expect(h.tabQueries()).toBe(1);
    expect(types(h.sends)).toEqual([PREPARATION_START_MESSAGE]);
    expect(h.sends[0]?.tabId).toBe(11);
    expect(h.last().phase).toBe('loading_courses');
    expect(h.last().canCancel).toBe(true);
  });

  it('a second click during the run is a no-op, not a second preparation', async () => {
    const h = build();
    await h.controller.start();
    await h.controller.start();
    await h.controller.start();
    expect(types(h.sends)).toEqual([PREPARATION_START_MESSAGE]);
  });

  it('the tab is re-read for every new run rather than reused', async () => {
    const h = build();
    await h.controller.start();
    expect(h.tabQueries()).toBe(1);
    // A finished run can be started again, and that start reads the tab afresh.
    await h.controller.restore();
    await h.controller.start();
    expect(h.tabQueries()).toBe(3);
  });

  it('a refusal with a live phase resumes that run instead of starting a second', async () => {
    const h = build({
      startReply: { ok: true, reply: { ok: true, accepted: false, status: status({ phase: 'hydrating_teachers' }) } },
    });
    await h.controller.start();
    // Accepted false is not a failure when the run is genuinely in progress.
    expect(h.last().phase).toBe('hydrating_teachers');
    expect(h.last().canCancel).toBe(true);
  });

  it('a forwarding failure enters error and claims nothing', async () => {
    const h = build({ startReply: { ok: false, error: '无法与该标签页的课程页面通信。' } });
    await h.controller.start();
    expect(h.last().phase).toBe('error');
    expect(h.last().canStart).toBe(true);
    expect(h.last().canCancel).toBe(false);
  });

  it('an unreachable worker enters error', async () => {
    const h = build({ sendReject: true });
    await h.controller.start();
    expect(h.last().phase).toBe('error');
  });

  it('no active tab enters error without sending anything', async () => {
    const h = build({ tabId: null });
    await h.controller.start();
    expect(h.sends).toEqual([]);
    expect(h.last().phase).toBe('error');
  });
});

describe('16J-PREUI-E4-C2-A every phase reads as what is actually happening', () => {
  it('F. loading_courses names the batch count and never a course count', async () => {
    const h = build();
    await h.controller.start();
    h.controller.onEvent(11, { phase_changed: 'loading_courses', autoExpandStatus: { clicks: 3, stopReason: 'partial' } });
    expect(h.last().phase).toBe('loading_courses');
    expect(h.last().clicks).toBe(3);
    const text = preparationProgressText(h.last().phase, h.last().clicks, h.last().hydration);
    // The wording says 可选课程, because the run narrowed the pool before this phase ever ran.
    expect(text).toContain('正在加载可选课程');
    expect(text).toContain('已展开 3 批');
    // A batch is not a course: one click adds a batch whose size varies.
    expect(text).not.toContain('门课程');
    expect(text).not.toContain('课程数');
  });

  it('F2. the FILTER phase reads as filtering the selectable courses', async () => {
    /*
     * The new first phase needs its own sentence: a run that has begun filtering is not yet loading anything, and showing the load-more line before any load-more
     * click would describe work that has not started.
     */
    const h = build();
    await h.controller.start();
    h.controller.onEvent(11, { phase_changed: 'filtering_available' });
    expect(h.last().phase).toBe('filtering_available');
    expect(h.last().canCancel).toBe(true);
    const text = preparationProgressText(h.last().phase, h.last().clicks, h.last().hydration);
    expect(text).toBe('正在筛选可选课程…');
    // The later phases' wording must not be borrowed.
    expect(text).not.toContain('正在加载');
    expect(text).not.toContain('正在补全');
  });

  it('G. hydrating_teachers reports panel counts with their real meanings', async () => {
    const h = build();
    await h.controller.start();
    h.controller.onEvent(11, {
      phase_changed: 'hydrating_teachers',
      teacherHydrationStatus: { queued: 130, considered: 24, attempted: 21, hydrated: 20, failed: 1, skipped: 3, hydrationClicks: 21 },
    });
    const view = h.last();
    expect(view.phase).toBe('hydrating_teachers');
    expect(view.hydration).toMatchObject({ queued: 130, considered: 24, hydrated: 20, failed: 1, skipped: 3, hydrationClicks: 21 });
    const text = preparationProgressText(view.phase, view.clicks, view.hydration);
    expect(text).toContain('正在补全教师信息');
    expect(text).toContain('已处理 24 / 130 个课程面板');
    expect(text).toContain('成功补全 20');
    expect(text).toContain('无需补全 3');
    expect(text).toContain('失败 1');
  });

  it('H. hydrationClicks is the only count ever worded as clicks', async () => {
    /*
     * `attempted` is NOT a click count: a panel that could not be examined is attempted without being clicked. This test pins the two apart by giving them
     * different values and asserting which one the panel is entitled to call a click.
     */
    const h = build();
    await h.controller.start();
    h.controller.onEvent(11, {
      phase_changed: 'hydrating_teachers',
      teacherHydrationStatus: { queued: 10, considered: 10, attempted: 7, hydrated: 6, failed: 1, skipped: 3, hydrationClicks: 4 },
    });
    const view = h.last();
    expect(view.hydration?.attempted).toBe(7);
    expect(view.hydration?.hydrationClicks).toBe(4);
    // The two are different numbers, so anything wording `attempted` as clicks would be visibly wrong.
    expect(view.hydration?.attempted).not.toBe(view.hydration?.hydrationClicks);
    const text = preparationProgressText(view.phase, view.clicks, view.hydration) ?? '';
    // Neither number is called a click count in the phase line: expansion batches are the only clicks the panel ever names.
    expect(text).not.toContain('点击');
    expect(text).not.toContain('7');
    expect(text).not.toContain('4');
  });

  it('I. rescanning says only that the page is being re-read', async () => {
    const h = build();
    await h.controller.start();
    h.controller.onEvent(11, { phase_changed: 'rescanning' });
    expect(h.last().phase).toBe('rescanning');
    const text = preparationProgressText(h.last().phase, h.last().clicks, h.last().hydration);
    expect(text).toBe('正在重新读取课程信息…');
    // Neither earlier phase may still be described as running.
    expect(text).not.toContain('正在加载可选课程');
    expect(text).not.toContain('正在补全教师信息');
  });

  it('every phase change keeps the cancel control available', async () => {
    const h = build();
    await h.controller.start();
    // The FILTER phase is included: it clicks page controls, so a user who changes their mind must be able to stop it there too.
    for (const phase of ['filtering_available', 'loading_courses', 'hydrating_teachers', 'rescanning']) {
      h.controller.onEvent(11, { phase_changed: phase });
      expect(h.last().canCancel, phase).toBe(true);
      expect(h.last().canStart, phase).toBe(false);
    }
  });
});

describe('16J-PREUI-E4-C2-A only the operation tab may update the display', () => {
  it('J. an event from the operation tab updates the view', async () => {
    const h = build();
    await h.controller.start();
    const before = h.views.length;
    h.controller.onEvent(11, { phase_changed: 'hydrating_teachers' });
    expect(h.last().phase).toBe('hydrating_teachers');
    expect(h.views.length).toBeGreaterThan(before);
  });

  it('K. an event from another tab is ignored', async () => {
    const h = build();
    await h.controller.start();
    h.controller.onEvent(11, { phase_changed: 'hydrating_teachers' });
    const settled = h.last();
    const count = h.views.length;

    // A different tab's news is not this run's news.
    h.controller.onEvent(99, { phase_changed: 'rescanning' });
    h.controller.onEvent(99, { phase: 'finished', stopReason: 'cancelled' });
    h.controller.onEvent(null, { phase: 'finished', stopReason: 'cancelled' });
    expect(h.last()).toEqual(settled);
    expect(h.views.length).toBe(count);
  });

  it('a payload tab id is not trusted', () => {
    /*
     * The controller takes the tab id as its FIRST argument, which the panel fills from the message sender. A payload field claiming a tab is simply part of
     * the event data and cannot promote a foreign event.
     */
    expect(sidepanelSource).toContain('sender?.tab?.id');
    expect(sidepanelSource.includes('message.tabId')).toBe(false);
    expect(sidepanelSource.includes('message?.tabId')).toBe(false);
  });
});

describe('16J-PREUI-E4-C2-A every stop reason reads differently', () => {
  const finish = (stopReason: unknown): string => preparationFinishText(stopReason);

  it('L. complete hydration is the full-success sentence', () => {
    expect(finish('completed')).toBe(PREPARATION_MESSAGES.completed);
    expect(finish('teacher_hydration_completed')).toBe(PREPARATION_MESSAGES.completed);
    expect(finish('teacher_hydration_completed')).toContain('已准备完成');
  });

  it('M. a partial teacher result is never worded as complete', () => {
    expect(finish('teacher_hydration_partial')).toBe(PREPARATION_MESSAGES.teacherPartial);
    expect(finish('teacher_hydration_partial')).toContain('部分');
    expect(finish('teacher_hydration_partial')).not.toBe(PREPARATION_MESSAGES.completed);
  });

  it('N. the cap is its own sentence and says the data was kept', () => {
    expect(finish('teacher_hydration_item_cap')).toBe(PREPARATION_MESSAGES.teacherCap);
    expect(finish('teacher_hydration_item_cap')).toContain('上限');
    expect(finish('teacher_hydration_item_cap')).toContain('保留');
  });

  it('O. a cancellation says the run stopped and the data was kept', () => {
    expect(finish('cancelled')).toBe(PREPARATION_MESSAGES.cancelled);
    expect(finish('cancelled')).toContain('已停止');
    expect(finish('cancelled')).toContain('保留');
  });

  it('P. an incomplete course list is distinct and explains why teachers were skipped', () => {
    expect(finish('course_list_incomplete')).toBe(PREPARATION_MESSAGES.listIncomplete);
    expect(finish('course_list_incomplete')).toContain('课程列表');
    expect(finish('course_list_incomplete')).toContain('未继续');
  });

  it('Q. a failed re-read is its own sentence', () => {
    expect(finish('read_failed')).toBe(PREPARATION_MESSAGES.readFailed);
    expect(finish('read_failed')).toContain('重新读取失败');
  });

  it('the six outcomes are six different sentences, and none of them claims completeness', () => {
    const reasons = ['completed', 'teacher_hydration_partial', 'teacher_hydration_item_cap', 'cancelled', 'course_list_incomplete', 'read_failed'];
    const sentences = reasons.map((reason) => finish(reason));
    expect(new Set(sentences).size).toBe(sentences.length);
    /*
     * The one direction that must never happen: a partial, cancelled or failed run described as whole. Only the success reason may say 已准备完成.
     */
    for (const reason of reasons.filter((entry) => entry !== 'completed')) {
      expect(finish(reason), reason).not.toContain('已准备完成');
    }
  });

  it('an unrecognised reason is reported as a failure rather than as success', () => {
    // Claiming completion on an unknown verdict is the one direction that could mislead a user about data they are about to rely on.
    for (const reason of [undefined, null, 42, {}, 'something_new']) {
      expect(finish(reason), String(reason)).toBe(PREPARATION_MESSAGES.failed);
    }
  });

  it('a finished event drives the sentence through the same path a status reply uses', async () => {
    const h = build();
    await h.controller.start();
    h.controller.onEvent(11, { phase: 'finished', stopReason: 'teacher_hydration_partial', finalPage: { rowCount: 42, supported: true, listPresent: true, completeness: 'complete' } });
    expect(h.last().phase).toBe('finished');
    expect(h.last().message).toBe(PREPARATION_MESSAGES.teacherPartial);
    expect(h.last().finalRowCount).toBe(42);
    expect(h.last().canStart).toBe(true);
    expect(h.last().canCancel).toBe(false);
  });
});

describe('16J-PREUI-E4-C2-A cancelling controls the workflow and fakes nothing', () => {
  it('R. cancel sends exactly one top-level cancel and no phase-level message', async () => {
    const h = build();
    await h.controller.start();
    h.controller.onEvent(11, { phase_changed: 'hydrating_teachers' });
    await h.controller.cancel();
    expect(types(h.sends)).toEqual([PREPARATION_START_MESSAGE, PREPARATION_CANCEL_MESSAGE]);
    // The panel controls the workflow, not its phases.
    expect(types(h.sends)).not.toContain('COURSE_COPILOT_CANCEL_AUTO_EXPAND');
    expect(types(h.sends)).not.toContain('COURSE_COPILOT_CANCEL_TEACHER_HYDRATION');
  });

  it('S. cancel does not claim the run stopped', async () => {
    const h = build();
    await h.controller.start();
    h.controller.onEvent(11, { phase_changed: 'hydrating_teachers' });
    const before = h.last();
    await h.controller.cancel();
    /*
     * The content script decides whether the run actually stopped; it may still be finishing a panel. Writing "cancelled" now would announce a result nobody
     * reported, so the running line stays.
     */
    expect(h.last()).toEqual(before);
    expect(h.last().phase).toBe('hydrating_teachers');
    expect(h.last().message).not.toBe(PREPARATION_MESSAGES.cancelled);
  });

  it('cancel on an idle panel sends nothing', async () => {
    const h = build();
    await h.controller.cancel();
    expect(h.sends).toEqual([]);
  });

  it('cancel is dropped when the active tab is no longer the operation', async () => {
    // A cancel must not stop someone else's run in whichever tab is now in front.
    const views: PreparationView[] = [];
    const sends: Array<Record<string, unknown>> = [];
    let tab = 11;
    const controller = createFullPreparationController({
      onView: (view) => { views.push(view); },
      queryActiveTabId: async () => tab,
      sendMessage: async (message) => {
        sends.push(message as unknown as Record<string, unknown>);
        return { ok: true, reply: { ok: true, accepted: true, status: status({ phase: 'loading_courses' }) } };
      },
    });
    await controller.start();
    tab = 99;
    await controller.cancel();
    expect(types(sends)).toEqual([PREPARATION_START_MESSAGE]);
  });
});

describe('16J-PREUI-E4-C2-A a reopened panel recovers the truth without any event', () => {
  it('T. a running preparation is recovered from the status reply', async () => {
    // Every phase in flight must survive a panel that missed the events.
    for (const phase of ['loading_courses', 'hydrating_teachers', 'rescanning']) {
      const h = build({
        statusReply: {
          ok: true,
          reply: {
            ok: true,
            status: status({
              phase,
              autoExpandStatus: { clicks: 5 },
              teacherHydrationStatus: { queued: 9, considered: 4, hydrated: 3, failed: 1, skipped: 0, hydrationClicks: 3 },
            }),
          },
        },
      });
      await h.controller.restore();
      expect(h.last().phase, phase).toBe(phase);
      expect(h.last().canCancel, phase).toBe(true);
      expect(h.last().clicks, phase).toBe(5);
    }
  });

  it('U. a finished preparation is recovered with its reason and final page', async () => {
    const h = build({
      statusReply: {
        ok: true,
        reply: {
          ok: true,
          status: status({
            phase: 'finished',
            stopReason: 'teacher_hydration_item_cap',
            finalPage: { supported: true, rowCount: 137, completeness: 'complete', listPresent: true },
          }),
        },
      },
    });
    await h.controller.restore();
    expect(h.last().phase).toBe('finished');
    expect(h.last().message).toBe(PREPARATION_MESSAGES.teacherCap);
    expect(h.last().finalRowCount).toBe(137);
    expect(h.last().canStart).toBe(true);
  });

  it('restoring an idle tab leaves the feature idle and starts nothing', async () => {
    const h = build();
    await h.controller.restore();
    expect(h.last().phase).toBe('idle');
    expect(types(h.sends)).toEqual([PREPARATION_STATUS_MESSAGE]);
  });

  it('an unreachable status read leaves the display alone rather than inventing a state', async () => {
    const h = build({ sendReject: true });
    const before = h.last();
    await h.controller.restore();
    expect(h.last()).toEqual(before);
  });

  it('a recovered run accepts that tab’s later events', async () => {
    // Recovery makes the recovered tab this panel's operation, so its events are no longer foreign.
    const h = build({ statusReply: { ok: true, reply: { ok: true, status: status({ phase: 'loading_courses' }) } } });
    await h.controller.restore();
    h.controller.onEvent(11, { phase_changed: 'rescanning' });
    expect(h.last().phase).toBe('rescanning');
  });
});

describe('16J-PREUI-E4-C2-A the final read is labelled as teaching-class records', () => {
  it('V. rowCount is described as teaching-class records, never as courses', () => {
    const text = finalPageText({ rowCount: 137 });
    expect(text).toBe('最终读取到 137 条教学班记录');
    expect(text).toContain('教学班记录');
    expect(text).not.toContain('门课程');
    expect(text).not.toContain('课程数');
  });

  it('a missing final page shows nothing rather than zero', () => {
    /*
     * "No read happened" and "the page has nothing" are different statements, and 0 would claim the second.
     */
    expect(finalPageText(undefined)).toBeNull();
    expect(finalPageText({})).toBeNull();
    expect(finalPageText({ rowCount: 'many' })).toBeNull();
  });

  it('zero records is shown as zero, because that read really did find nothing', () => {
    expect(finalPageText({ rowCount: 0 })).toBe('最终读取到 0 条教学班记录');
  });

  it('a cancelled run still reports the page it read', async () => {
    const h = build();
    await h.controller.start();
    h.controller.onEvent(11, { phase: 'finished', stopReason: 'cancelled', finalPage: { supported: true, rowCount: 30, completeness: 'complete', listPresent: true } });
    expect(h.last().message).toBe(PREPARATION_MESSAGES.cancelled);
    expect(finalPageText({ rowCount: h.last().finalRowCount ?? undefined })).toBe('最终读取到 30 条教学班记录');
  });
});

describe('16J-PREUI-E4-C2-A the approved action is one action, and it is disclosed', () => {
  it('W. the approval copy names BOTH page interactions and all four refusals', () => {
    /*
     * ## Why the copy must name the CONTROL and not just the outcome
     *
     * A user who approved "load the list" has not approved "expand course details", and has certainly not approved having a control clicked on their behalf. The
     * first interaction is a click on a page element the user did not press, so the copy states which control, where it is, and that the clicking is automatic.
     * A sentence that said only 自动加载课程 would describe the PURPOSE correctly and the ACTION misleadingly, which is the distinction this test locks down.
     */
    // A. the load-more control itself, named by its own visible label.
    expect(approvalCopy).toContain('点此查看更多');
    // B. where it is: the page's bottom, which is the wording the copy uses.
    expect(approvalCopy).toContain('页面底部');
    // C. the automatic clicking is stated, not implied by the outcome.
    expect(approvalCopy).toContain('自动点击');
    // D. the second interaction: details expanded, and only where the teacher data is incomplete.
    expect(approvalCopy).toContain('展开详情');
    expect(approvalCopy).toContain('教师信息未完整');
    expect(approvalCopy).toContain('补全任课老师');
    // E. the refusals. 修改筛选条件 is NOT among them any more — see W4.
    for (const refusal of ['不会选课', '退课', '提交']) {
      expect(approvalCopy, refusal).toContain(refusal);
    }
  });

  it('W4. the approval copy discloses the THIRD interaction — enabling the availability filter', () => {
    /*
     * PRE-RELEASE-UX-A10 made the run begin by enabling WHU's own 「有余量」 filter, which is a page change on the user's behalf. The copy must therefore disclose
     * it the same way it discloses the other two interactions, and it must also say what the filter is FOR, because "applies a filter" alone does not tell a user
     * that the analysis is narrowed to currently selectable courses.
     */
    expect(approvalCopy).toContain('自动启用');
    expect(approvalCopy).toContain('有余量');
    expect(approvalCopy).toContain('只分析当前可选课程');
  });

  it('W5. 不会修改筛选条件 is GONE, because it is now false', () => {
    /*
     * The old copy promised the extension would not modify the page's filter conditions. This slice does exactly that — deliberately, with the user's approval —
     * so keeping the sentence would make the disclosure a lie. Stated as a rejection in BOTH places a reader could look: the rendered paragraph and the built
     * bundle, since comments survive into the artifact and a stale promise in prose is still a stale promise in the shipped file.
     */
    expect(approvalCopy).not.toContain('修改筛选条件');
    expect(decodedPanelArtifact).not.toContain('修改筛选条件');
  });

  it('W6. the approval copy names the recommendation step LAST, so the sequence reads in execution order', () => {
    const filterIndex = approvalCopy.indexOf('有余量');
    const loadIndex = approvalCopy.indexOf('点此查看更多');
    const teacherIndex = approvalCopy.indexOf('补全任课老师');
    const recommendIndex = approvalCopy.indexOf('生成推荐');
    expect(filterIndex).toBeGreaterThanOrEqual(0);
    expect(loadIndex).toBeGreaterThan(filterIndex);
    expect(teacherIndex).toBeGreaterThan(loadIndex);
    expect(recommendIndex).toBeGreaterThan(teacherIndex);
  });

  it('W7. there is exactly ONE copy of the approval paragraph, and it is in the HTML', () => {
    /*
     * The drift this closes: the copy used to exist as a TypeScript constant AND as the rendered paragraph, with the constant having no production caller. A test
     * asserted `html).toContain(constant)`, which could not fail because the rendered paragraph was longer than the constant — so the two could diverge freely
     * while both looked authoritative.
     *
     * The paragraph is now the only copy, and the test reads THAT element. The decisive checks are that no second copy exists in the controller, and that each
     * commitment sentence appears exactly ONCE in the paragraph itself. Counting occurrences across the whole file was tried first and was wrong: the HTML's own
     * explanatory comment quotes a commitment, which is commentary rather than a second copy of the user-facing text.
     */
    expect(sidepanelHtml).toContain(approvalCopy);
    const controllerSource = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'full-preparation.ts'), 'utf8');
    expect(controllerSource.includes('PREPARATION_APPROVAL_COPY')).toBe(false);
    for (const sentence of ['只分析当前可选课程', '不会选课、退课或提交', '自动启用', '点此查看更多']) {
      expect(approvalCopy.split(sentence).length - 1, sentence).toBe(1);
      expect(controllerSource.includes(sentence), sentence).toBe(false);
    }
  });

  it('W2. the load-more interaction is not abstracted back into a purpose', () => {
    /*
     * The failure mode this guards against is a later edit that shortens the sentence to 「自动加载课程列表」. That reads well and is true about the outcome, but
     * it hides that a control on the user's page gets clicked — so the copy would no longer be the thing the user agreed to.
     */
    const saysItClicks = approvalCopy.includes('自动点击');
    const namesTheControl = approvalCopy.includes('点此查看更多');
    expect(saysItClicks).toBe(true);
    expect(namesTheControl).toBe(true);
    // The two must belong to the same clause about that interaction, not be scattered independently.
    const controlIndex = approvalCopy.indexOf('点此查看更多');
    const clickIndex = approvalCopy.indexOf('自动点击');
    const purposeIndex = approvalCopy.indexOf('加载全部结果');
    expect(clickIndex).toBeLessThan(controlIndex);
    expect(controlIndex).toBeLessThan(purposeIndex);
    // And a bare "auto-load" promise is NOT what the copy says.
    expect(approvalCopy).not.toContain('会自动加载当前课程列表');
    expect(sidepanelHtml).not.toContain('会自动加载当前课程列表');
  });

  it('W3. the approval copy does not describe a click the extension does NOT make', () => {
    /*
     * The other direction: the copy must not over-claim either. The second interaction is an expansion of course details, never a click on an enrollment control,
     * so no wording may suggest one.
     */
    for (const token of ['选课按钮', '退课按钮', '提交按钮', '报名', '抢课']) {
      expect(approvalCopy.includes(token), token).toBe(false);
    }
  });

  it('the approval copy states the recommendation purpose, now that it is wired', () => {
    /*
     * UPDATED IN 16J-PREUI-E4-C2-B3-A. This used to forbid the word `推荐` anywhere in the panel, which held while the recommendation was unwired — a button must
     * not promise what the product does not do. It does it now, so the requirement inverses: the label and the note must say so.
     */
    expect(sidepanelHtml).toContain('并生成推荐');
    expect(approvalCopy).toContain('会基于当前课程信息和公开课程评价生成推荐');
    // And the purpose sentence must not have replaced the interaction descriptions it sits beside.
    expect(approvalCopy).toContain('自动点击');
    expect(approvalCopy).toContain('点此查看更多');
  });

  it('B and C. the panel offers the unified action and no separate auto-load action', () => {
    expect(sidepanelHtml).toContain('id="full-preparation-start"');
    /*
     * The label says 可选课程, because the run starts by narrowing the pool to courses that have places. The old 加载完整课程信息 promised the complete WHU catalogue,
     * which this flow deliberately does not assemble.
     */
    expect(primaryButtonLabel).toBe('加载可选课程信息并生成推荐');
    expect(sidepanelHtml).not.toContain('加载完整课程信息');
    // The old entry point is gone from the DOM: the user must not be offered two ways to start overlapping work.
    expect(sidepanelHtml).not.toContain('自动加载全部课程');
    expect(sidepanelHtml).not.toContain('id="autoload-start"');
    expect(sidepanelHtml).not.toContain('自动加载课程');
  });

  it('B2. the built panel carries the new label and neither the old label nor the old promise', () => {
    /*
     * Asserted against the built MARKUP, which is where the label lives — measured, it is not in the JS bundle at all.
     *
     * The bundle is also checked, with its `\uXXXX` escaping decoded, because the old promise must not survive anywhere in the shipped panel even as prose:
     * comments are preserved into `sidepanel.js`, so a stale sentence in a comment is still a stale sentence in the artifact. An undecoded search would answer
     * `false` for text that IS present and make that half pass vacuously.
     */
    expect(builtHtml).toContain('加载可选课程信息并生成推荐');
    expect(builtHtml).not.toContain('加载完整课程信息并生成推荐');
    expect(decodedPanelArtifact).not.toContain('修改筛选条件');
    expect(decodedPanelArtifact).not.toContain('加载完整课程信息');
  });

  it('E and AA. the panel sends no standalone auto-expand start', () => {
    expect(sidepanelSource.includes('START_AUTO_EXPAND')).toBe(false);
    expect(panelArtifact.includes('START_AUTO_EXPAND')).toBe(false);
    expect(panelArtifact.includes('COURSE_COPILOT_START_AUTO_EXPAND')).toBe(false);
  });

  it('Z. the panel sends no standalone teacher-hydration start', () => {
    for (const token of ['START_TEACHER_HYDRATION', 'TEACHER_HYDRATION_EVENT', 'CANCEL_TEACHER_HYDRATION', 'QUERY_TEACHER_HYDRATION_STATUS']) {
      expect(sidepanelSource.includes(token), token).toBe(false);
      expect(panelArtifact.includes(token), token).toBe(false);
    }
  });

  it('START_FULL_PREPARATION is sent from ONE place, and the panel itself cannot send it', () => {
    /*
     * The controller owns the start message, so the panel does not even name it: a module that cannot spell the type cannot send it by accident. The panel's
     * only contribution is calling `start`, and that call exists once, inside the click handler.
     */
    const controllerSource = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'full-preparation.ts'), 'utf8');
    // One send site in the controller: the start method's own `sendMessage`.
    expect(controllerSource.split('type: PREPARATION_START_MESSAGE').length - 1).toBe(1);
    // The panel does not name the start type at all.
    expect(sidepanelSource.includes('PREPARATION_START_MESSAGE')).toBe(false);
    expect(sidepanelSource).toContain('void preparation.start()');
    expect(sidepanelSource.split('.start()').length - 1).toBe(1);
    /*
     * The BUILT artifact has no identifiers, so the check there is on the literal message type: exactly one occurrence — the controller's send — and no
     * standalone start of either lower-level feature.
     */
    expect(panelArtifact.split(PREPARATION_START_MESSAGE).length - 1).toBe(1);
    expect(panelArtifact).toContain(PREPARATION_STATUS_MESSAGE);
    expect(panelArtifact).toContain(PREPARATION_CANCEL_MESSAGE);
  });
});

describe('16J-PREUI-E4-C2-A the panel stays inside its own boundaries', () => {
  it('X. the panel has exactly one runtime message listener', () => {
    expect(sidepanelSource.split('chrome.runtime.onMessage.addListener').length - 1).toBe(1);
    // And it handles the preparation event inside that one listener.
    expect(sidepanelSource).toContain('PREPARATION_EVENT_MESSAGE');
    expect(sidepanelSource).toContain('preparation.onEvent');
  });

  it('the panel listens for the preparation event and not the two lower-level events', () => {
    /*
     * The lower-level events still exist for the standalone runtimes, but this panel drives the unified workflow and must not render a phase twice from two
     * sources.
     */
    expect(sidepanelSource.includes(AUTO_EXPAND_EVENT)).toBe(false);
    expect(sidepanelSource.includes(HYDRATION_EVENT)).toBe(false);
    expect(panelArtifact.includes(AUTO_EXPAND_EVENT)).toBe(false);
    expect(panelArtifact.includes(HYDRATION_EVENT)).toBe(false);
    expect(panelArtifact).toContain(PREPARATION_EVENT_MESSAGE);
  });

  it('Y. the recommendation is reached only through the hardened controller, and never through the engine directly', () => {
    /*
     * UPDATED IN 16J-PREUI-E4-C2-B3-A. This used to require that no recommendation happened at all, which held while the controller was inert. What still protects
     * the design is WHICH path is used: the panel may send the request through the hardened controller and must not reach for the engine, the provider or the
     * policy itself. A direct call would bypass the expected-tab binding, the freshness rules and the stale outcome in one move.
     */
    for (const token of ['recommendExtensionCourses', 'recommendation-policy', 'requestVisibleRecommendations', 'ReviewProvider']) {
      expect(sidepanelSource.includes(token), token).toBe(false);
      expect(panelArtifact.includes(token), token).toBe(false);
    }
    // The ONE permitted path, and the only message type it can reach.
    expect([...sidepanelSource.matchAll(/createRecommendationRequestController\(/gu)]).toHaveLength(1);
    expect(panelArtifact).toContain('COURSE_COPILOT_QUERY_RECOMMENDATIONS');
    // The result area exists, with a snapshot title and three card sections beneath its summary.
    expect(sidepanelHtml).toContain('推荐快照');
    /*
     * UPDATED IN 16J-PREUI-E4-C2-B3-B2. This used to forbid `course-card` markup, which held while the area was a summary only. The cards are now the feature, so
     * what is asserted is that they are reached through the CARD RENDERER — the panel must not build card markup of its own, and the renderer must not reach past the
     * frozen model to a course object.
     */
    expect(sidepanelHtml).toContain('id="cards-recommended"');
    expect(sidepanelSource).toContain('renderCourseCards');
    const cardRenderer = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'course-cards.ts'), 'utf8');
    expect(cardRenderer).toContain('course-presentation');
  });

  it('the panel touches no page structure', () => {
    for (const token of ['querySelector', 'tjxk_list', 'panel-info', 'expand1', 'jsxm', '#more']) {
      expect(panelArtifact.includes(token), token).toBe(false);
    }
  });

  it('the panel reports nothing about the page it has not been told', () => {
    // The panel never reads the tab's URL or title; it asks the worker and repeats what came back.
    expect(sidepanelSource.includes('.url')).toBe(false);
    expect(sidepanelSource.includes('.title')).toBe(false);
  });
});
