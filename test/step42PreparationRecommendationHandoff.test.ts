/**
 * PART 16J-PREUI-E4-C2-B3-A — the preparation → recommendation handoff, and the result area's honest shell.
 *
 * ## What this proves
 *
 * The whole point of the area is that it never says something it was not told. So the assertions concentrate on three families:
 *
 * 1. **WHEN** a recommendation is requested. Only three preparation outcomes permit one, an unknown reason never does, the request happens exactly once per
 *    preparation, and the tab is the one the preparation read.
 * 2. **WHAT** the page status means. Five page states that all produce an empty ranking get five different sentences, and none of them is derived from the
 *    result.
 * 3. **WHAT** the review source and the evidence counts mean. A source that answered "nothing" is not an outage, and a course with no usable evidence is a data
 *    statement rather than a quality judgement.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RecommendationRequestState } from '../apps/extension/src/sidepanel/recommendation-request.js';
import {
  createRecommendationHandoff,
  preparationAllowsRecommendation,
  preparationNeedsTeacherDisclosure,
  recommendationIdleView,
  recommendationResultView,
  RECOMMENDATION_LABELS,
  RECOMMENDATION_MESSAGES,
} from '../apps/extension/src/sidepanel/recommendation-result.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sidepanelSource = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');
const sidepanelHtml = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'sidepanel.html'), 'utf8');

/** A page read status, with the given overrides. */
function page(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { read: 'ok', supported: true, rowCount: 2, courseCount: 2, completeness: 'complete', ...overrides };
}

/** A canonical-looking result with the given counts. */
function result(options: { recommended?: number; rated?: number; insufficient?: number; reviewSource?: unknown } = {}): Record<string, unknown> {
  return {
    recommendations: Array.from({ length: options.recommended ?? 0 }, () => ({})),
    ratedButNotRecommended: Array.from({ length: options.rated ?? 0 }, () => ({})),
    insufficientData: Array.from({ length: options.insufficient ?? 0 }, () => ({})),
    reviewSource: options.reviewSource ?? { status: 'healthy', queries: 1, rows: 4, empty: 0, unavailable: 0 },
  };
}

/** A successful controller state. */
function success(pageValue: Record<string, unknown>, resultValue: Record<string, unknown>): RecommendationRequestState {
  return { status: 'success', page: pageValue, result: resultValue } as unknown as RecommendationRequestState;
}

/** Drive the handoff with recorded requests. */
function handoff(): { consider: ReturnType<typeof createRecommendationHandoff>['consider']; reset: () => void; requested: Array<number | undefined> } {
  const requested: Array<number | undefined> = [];
  const controller = createRecommendationHandoff({ request: async (expectedTabId) => { requested.push(expectedTabId); } });
  return { consider: controller.consider, reset: controller.reset, requested };
}

describe('16J-PREUI-E4-C2-B3-A A and B. one approval, and the copy still approves both page interactions', () => {
  it('the button names the whole action', () => {
    /*
     * UPDATED IN PRE-RELEASE-UX-A10: the action now starts by narrowing the pool to courses that have places, so the label says 可选课程 rather than 完整课程.
     */
    expect(sidepanelHtml).toContain('加载可选课程信息并生成推荐');
    expect(sidepanelHtml).not.toContain('加载完整课程信息并生成推荐');
    // One entry point only: a second "generate recommendation" button would be a second approval for one outcome.
    expect(sidepanelHtml).not.toContain('id="recommendation-start"');
    /*
     * UPDATED IN PRE-RELEASE-UX-A13. The panel now carries three controls, the third being the rated section's collapse toggle. Named rather than counted, so a
     * second recommendation entry point could not hide behind the same total.
     */
    const buttons = [...sidepanelHtml.matchAll(/<button[^>]*id="([^"]+)"/gu)].map((match) => match[1]);
    expect(buttons.sort()).toEqual(['full-preparation-cancel', 'full-preparation-start', 'preferences-apply', 'preferences-reset', 'rated-toggle']);
  });

  it('the approval copy still names the real page interactions, and no longer promises not to touch the filter', () => {
    /*
     * UPDATED IN PRE-RELEASE-UX-A10. The copy described TWO interactions and four refusals; there are now THREE interactions, because the run enables WHU's own
     * 「有余量」 filter. The old refusal 修改筛选条件 was removed rather than reworded, because it became false the moment this slice made the run apply a filter —
     * and a stale promise is worse than a missing one.
     */
    expect(sidepanelHtml).toContain('自动点击');
    expect(sidepanelHtml).toContain('页面底部');
    expect(sidepanelHtml).toContain('点此查看更多');
    expect(sidepanelHtml).toContain('展开详情');
    expect(sidepanelHtml).toContain('教师信息未完整');
    expect(sidepanelHtml).toContain('补全任课老师');
    // The third interaction, disclosed the same way the other two are.
    expect(sidepanelHtml).toContain('自动启用');
    expect(sidepanelHtml).toContain('有余量');
    expect(sidepanelHtml).toContain('只分析当前可选课程');
    for (const refusal of ['不会选课', '退课', '提交']) {
      expect(sidepanelHtml, refusal).toContain(refusal);
    }
    expect(sidepanelHtml).not.toContain('修改筛选条件');
  });

  it('the copy adds the recommendation purpose without weakening the interaction description', () => {
    expect(sidepanelHtml).toContain('会基于当前课程信息和公开课程评价生成推荐');
    // The interaction description must still be the explicit one, not abstracted back to "自动加载".
    expect(sidepanelHtml).not.toContain('会自动加载当前课程列表');
  });
});

describe('16J-PREUI-E4-C2-B3-A C to E. the three eligible outcomes ask once', () => {
  for (const [label, stopReason] of [
    ['full', 'teacher_hydration_completed'],
    ['partial', 'teacher_hydration_partial'],
    ['item cap', 'teacher_hydration_item_cap'],
  ] as const) {
    it(`C. a ${label} preparation requests a recommendation`, () => {
      const h = handoff();
      h.consider('finished', stopReason, 11);
      expect(h.requested).toEqual([11]);
    });
  }

  it('the request carries the PREPARATION operation tab, not a fresh query', () => {
    const h = handoff();
    h.consider('finished', 'teacher_hydration_completed', 42);
    expect(h.requested).toEqual([42]);
    // And the panel's own wiring passes the preparation's recorded id through unchanged.
    /*
     * UPDATED IN 16J-REAL-E2E-1. The sink now reaches both collaborators through lazy accessors, because it runs DURING the controller's construction and a direct
     * `const` reference threw a temporal-dead-zone error that killed the shipped panel script. The guarantee is unchanged: the tab still comes from the preparation.
     */
    expect(sidepanelSource).toContain('deferredPreparation()?.operationTabId()');
    expect(sidepanelSource).toContain('deferredHandoff()?.consider(');
  });

  it('a preparation with no recorded tab requests nothing rather than falling back to the active tab', () => {
    // Falling back would be exactly the target migration the expected-tab binding exists to prevent.
    const h = handoff();
    h.consider('finished', 'teacher_hydration_completed', null);
    expect(h.requested).toEqual([]);
  });
});

describe('16J-PREUI-E4-C2-B3-A F to I. nothing else asks', () => {
  for (const [label, stopReason] of [
    ['F. cancelled', 'cancelled'],
    ['G. an incomplete course list', 'course_list_incomplete'],
    ['H. a failed re-read', 'read_failed'],
    ['I. an unrecognised reason', 'something_a_future_step_added'],
  ] as const) {
    it(`${label} sends zero recommendation requests`, () => {
      const h = handoff();
      h.consider('finished', stopReason, 11);
      expect(h.requested).toEqual([]);
      expect(preparationAllowsRecommendation(stopReason)).toBe(false);
    });
  }

  it('a non-finished phase sends nothing, however eligible the reason looks', () => {
    for (const phase of ['idle', 'starting', 'loading_courses', 'hydrating_teachers', 'rescanning', 'error']) {
      const h = handoff();
      h.consider(phase, 'teacher_hydration_completed', 11);
      expect(h.requested, phase).toEqual([]);
    }
  });

  it('the whitelist is exactly the three eligible outcomes', () => {
    // Named as data, so adding a reason to the whitelist is a visible edit rather than an accident of ordering.
    for (const reason of ['teacher_hydration_completed', 'teacher_hydration_partial', 'teacher_hydration_item_cap']) {
      expect(preparationAllowsRecommendation(reason), reason).toBe(true);
    }
    for (const reason of ['cancelled', 'course_list_incomplete', 'read_failed', 'completed', undefined, null, 42, {}]) {
      expect(preparationAllowsRecommendation(reason), String(reason)).toBe(false);
    }
  });
});

describe('16J-PREUI-E4-C2-B3-A L and M. one handoff per preparation', () => {
  it('L. a duplicate finished report does not produce a second request', () => {
    /*
     * A preparation reports itself more than once: a live event, a status read after a reopen, and possibly a repeat. Each must not become another request.
     */
    const h = handoff();
    h.consider('finished', 'teacher_hydration_completed', 11);
    h.consider('finished', 'teacher_hydration_completed', 11);
    h.consider('finished', 'teacher_hydration_completed', 11);
    expect(h.requested).toHaveLength(1);
  });

  it('M. a restored finished preparation is eligible, and is deduped the same way', () => {
    // The panel reopens; the status read reports the same finished run. That is the SAME completion, so it asks once.
    const h = handoff();
    h.consider('finished', 'teacher_hydration_completed', 7);
    h.consider('finished', 'teacher_hydration_completed', 7);
    expect(h.requested).toEqual([7]);
  });

  it('a NEW approval re-arms the handoff', () => {
    // `reset()` is what the click does, so a second run in one panel session is entitled to its own request.
    const h = handoff();
    h.consider('finished', 'teacher_hydration_completed', 11);
    h.reset();
    h.consider('finished', 'teacher_hydration_completed', 11);
    expect(h.requested).toEqual([11, 11]);
  });

  it('a running preparation between two completions does not re-arm by itself', () => {
    const h = handoff();
    h.consider('finished', 'teacher_hydration_completed', 11);
    h.consider('loading_courses', undefined, 11);
    h.consider('finished', 'teacher_hydration_completed', 11);
    expect(h.requested).toHaveLength(1);
  });

  it('the panel resets the handoff on the click, before starting', () => {
    const clickStart = sidepanelSource.indexOf('handoff.reset()');
    const startCall = sidepanelSource.indexOf('preparation.start()');
    expect(clickStart).toBeGreaterThan(-1);
    expect(startCall).toBeGreaterThan(clickStart);
  });
});

describe('16J-PREUI-E4-C2-B3-A D and E. partial teacher data stays disclosed', () => {
  for (const stopReason of ['teacher_hydration_partial', 'teacher_hydration_item_cap'] as const) {
    it(`${stopReason} keeps its warning beside a SUCCESSFUL recommendation`, () => {
      /*
       * The disclosure is not a one-shot notice that a success replaces: the teacher data behind these numbers really is incomplete, so the qualification has to
       * survive the good news.
       */
      const view = recommendationResultView(success(page(), result({ recommended: 3 })), stopReason);
      expect(view.status).toBe('success');
      expect(view.teacherNotice).toBe(RECOMMENDATION_MESSAGES.teacherPartial);
      expect(view.counts).not.toBeNull();
      expect(preparationNeedsTeacherDisclosure(stopReason)).toBe(true);
    });
  }

  it('a complete preparation shows no teacher warning', () => {
    const view = recommendationResultView(success(page(), result({ recommended: 3 })), 'teacher_hydration_completed');
    expect(view.teacherNotice).toBeNull();
    expect(preparationNeedsTeacherDisclosure('teacher_hydration_completed')).toBe(false);
  });

  it('the warning survives a loading state too', () => {
    // It is a fact about the preparation, not about the answer being replaced.
    const view = recommendationResultView({ status: 'loading' }, 'teacher_hydration_partial');
    expect(view.teacherNotice).toBe(RECOMMENDATION_MESSAGES.teacherPartial);
    expect(view.message).toBe(RECOMMENDATION_MESSAGES.loading);
  });
});

describe('16J-PREUI-E4-C2-B3-A N to R. the page speaks first', () => {
  it('N. an unsupported page says so', () => {
    const view = recommendationResultView(success(page({ supported: false }), result()), 'teacher_hydration_completed');
    expect(view.pageNotice).toBe(RECOMMENDATION_MESSAGES.pageUnsupported);
    expect(view.counts).toBeNull();
  });

  it('O. an unavailable read says the page could not be read', () => {
    const view = recommendationResultView(success(page({ read: 'unavailable', supported: undefined }), result()), 'teacher_hydration_completed');
    expect(view.pageNotice).toBe(RECOMMENDATION_MESSAGES.pageUnavailable);
  });

  it('P. a malformed read says the page structure could not be read', () => {
    const view = recommendationResultView(success(page({ read: 'malformed' }), result()), 'teacher_hydration_completed');
    expect(view.pageNotice).toBe(RECOMMENDATION_MESSAGES.pageMalformed);
  });

  it('Q. a genuine zero-row page says there is nothing to recommend from', () => {
    const view = recommendationResultView(success(page({ rowCount: 0, courseCount: 0 }), result()), 'teacher_hydration_completed');
    expect(view.pageNotice).toBe(RECOMMENDATION_MESSAGES.pageNoRows);
  });

  it('R. rows that could not be mapped are distinguished from an empty page', () => {
    // The two counts disagree only here, and "the page is empty" would be false: it had rows.
    const view = recommendationResultView(success(page({ rowCount: 9, courseCount: 0 }), result()), 'teacher_hydration_completed');
    expect(view.pageNotice).toBe(RECOMMENDATION_MESSAGES.pageUnmappable);
    expect(view.pageNotice).not.toBe(RECOMMENDATION_MESSAGES.pageNoRows);
  });

  it('the five page states are five different sentences', () => {
    const states = [
      page({ supported: false }),
      page({ read: 'unavailable', supported: undefined }),
      page({ read: 'malformed' }),
      page({ rowCount: 0, courseCount: 0 }),
      page({ rowCount: 9, courseCount: 0 }),
    ];
    const notices = states.map((value) => recommendationResultView(success(value, result()), 'teacher_hydration_completed').pageNotice);
    expect(new Set(notices).size).toBe(notices.length);
    expect(notices.every((notice) => notice !== null)).toBe(true);
  });

  it('only a readable page with mapped courses reaches the summary', () => {
    const view = recommendationResultView(success(page({ rowCount: 5, courseCount: 5 }), result({ recommended: 2 })), 'teacher_hydration_completed');
    expect(view.pageNotice).toBeNull();
    expect(view.counts).toEqual({ recommended: 2, rated: 0, insufficient: 0 });
  });

  it('no page state is ever derived from the result', () => {
    /*
     * A structurally identical empty result is passed with five different pages, and the view differs every time. If the page notice came from the result, all
     * five would read the same.
     */
    const empty = result({ recommended: 0, rated: 0, insufficient: 0 });
    const views = [
      page({ supported: false }),
      page({ read: 'unavailable', supported: undefined }),
      page({ read: 'malformed' }),
      page({ rowCount: 0, courseCount: 0 }),
      page({ rowCount: 9, courseCount: 0 }),
    ].map((value) => recommendationResultView(success(value, empty), 'teacher_hydration_completed').pageNotice);
    expect(new Set(views).size).toBe(5);
  });
});

describe('16J-PREUI-E4-C2-B3-A S to U. review-source health is never collapsed', () => {
  it('S. a healthy source that found nothing is NOT an outage', () => {
    const source = { status: 'healthy', queries: 1, rows: 0, empty: 1, unavailable: 0 };
    const view = recommendationResultView(success(page(), result({ reviewSource: source })), 'teacher_hydration_completed');
    expect(view.reviewNotice).toBe(RECOMMENDATION_MESSAGES.reviewFoundNothing);
    expect(view.reviewNotice).not.toBe(RECOMMENDATION_MESSAGES.reviewUnavailable);
    expect(view.reviewNotice).not.toContain('不可用');
  });

  it('T. a partial source discloses that the data is incomplete', () => {
    const source = { status: 'partial', queries: 2, rows: 3, empty: 0, unavailable: 1, failureKinds: ['http'] };
    const view = recommendationResultView(success(page(), result({ reviewSource: source })), 'teacher_hydration_completed');
    expect(view.reviewNotice).toBe(RECOMMENDATION_MESSAGES.reviewPartial);
  });

  it('U. an unavailable source says the source is unavailable', () => {
    const source = { status: 'unavailable', queries: 1, rows: 0, empty: 0, unavailable: 1, failureKinds: ['network'] };
    const view = recommendationResultView(success(page(), result({ reviewSource: source })), 'teacher_hydration_completed');
    expect(view.reviewNotice).toBe(RECOMMENDATION_MESSAGES.reviewUnavailable);
  });

  it('a healthy source WITH rows discloses nothing', () => {
    const view = recommendationResultView(success(page(), result({ reviewSource: { status: 'healthy', queries: 1, rows: 4, empty: 0, unavailable: 0 } })), 'teacher_hydration_completed');
    expect(view.reviewNotice).toBeNull();
  });

  it('a healthy empty source and an unavailable one are structurally different views', () => {
    const empty = recommendationResultView(success(page(), result({ reviewSource: { status: 'healthy', queries: 1, rows: 0, empty: 1, unavailable: 0 } })), 'teacher_hydration_completed');
    const down = recommendationResultView(success(page(), result({ reviewSource: { status: 'unavailable', queries: 1, rows: 0, empty: 0, unavailable: 1 } })), 'teacher_hydration_completed');
    expect(empty.reviewNotice).not.toBe(down.reviewNotice);
  });

  it('the review disclosure survives beside a page notice, because it is the same run', () => {
    const view = recommendationResultView(
      success(page({ rowCount: 0, courseCount: 0 }), result({ reviewSource: { status: 'unavailable', queries: 1, rows: 0, empty: 0, unavailable: 1 } })),
      'teacher_hydration_completed',
    );
    expect(view.pageNotice).toBe(RECOMMENDATION_MESSAGES.pageNoRows);
    expect(view.reviewNotice).toBe(RECOMMENDATION_MESSAGES.reviewUnavailable);
  });
});

describe('16J-PREUI-E4-C2-B3-A V to Z. the three counts stay three answers', () => {
  it('V, W and X. each count is reported separately, with its own label', () => {
    const view = recommendationResultView(success(page(), result({ recommended: 5, rated: 47, insufficient: 3 })), 'teacher_hydration_completed');
    expect(view.counts).toEqual({ recommended: 5, rated: 47, insufficient: 3 });
    // Three distinct labels, so a reader cannot merge them.
    const labels = [RECOMMENDATION_LABELS.recommended, RECOMMENDATION_LABELS.rated, RECOMMENDATION_LABELS.insufficient];
    expect(new Set(labels).size).toBe(3);
    expect(sidepanelHtml).toContain(RECOMMENDATION_LABELS.recommended);
    expect(sidepanelHtml).toContain(RECOMMENDATION_LABELS.rated);
    expect(sidepanelHtml).toContain(RECOMMENDATION_LABELS.insufficient);
  });

  it('X. the insufficiency wording means an EVIDENCE problem, never a quality judgement', () => {
    /*
     * The canonical contract defines `insufficientData` as "no trusted match, or no aspect carried evidence" — a statement about the data. Wording it as a
     * verdict on the course would turn a gap in the evidence into a claim about teaching.
     */
    expect(RECOMMENDATION_MESSAGES.emptyInsufficient).toContain('证据不足');
    for (const forbidden of ['不推荐', '课程质量差', '差评', '不好']) {
      expect(RECOMMENDATION_MESSAGES.emptyInsufficient.includes(forbidden), forbidden).toBe(false);
      expect(RECOMMENDATION_LABELS.insufficient.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('Y. zero recommendations with rated courses is its own empty state', () => {
    const view = recommendationResultView(success(page(), result({ recommended: 0, rated: 6, insufficient: 0 })), 'teacher_hydration_completed');
    expect(view.emptyNotice).toBe(RECOMMENDATION_MESSAGES.emptyButRated);
    // Never worded as "no course data": the data was there, the cut simply fell above it.
    expect(view.emptyNotice).not.toContain('没有课程数据');
    expect(view.emptyNotice).not.toBe(RECOMMENDATION_MESSAGES.emptyInsufficient);
  });

  it('Z. zero recommendations with only insufficient courses is its own empty state', () => {
    const view = recommendationResultView(success(page(), result({ recommended: 0, rated: 0, insufficient: 4 })), 'teacher_hydration_completed');
    expect(view.emptyNotice).toBe(RECOMMENDATION_MESSAGES.emptyInsufficient);
    expect(view.emptyNotice).not.toBe(RECOMMENDATION_MESSAGES.emptyButRated);
  });

  it('all three empty states are different sentences, and none is a bare "no recommendations"', () => {
    const rated = recommendationResultView(success(page(), result({ recommended: 0, rated: 2 })), 'teacher_hydration_completed').emptyNotice;
    const insufficient = recommendationResultView(success(page(), result({ recommended: 0, insufficient: 2 })), 'teacher_hydration_completed').emptyNotice;
    const nothing = recommendationResultView(success(page(), result({ recommended: 0 })), 'teacher_hydration_completed').emptyNotice;
    expect(new Set([rated, insufficient, nothing]).size).toBe(3);
    for (const notice of [rated, insufficient, nothing]) {
      expect(notice).not.toBe('暂无推荐');
    }
  });

  it('a non-empty ranking has no empty notice at all', () => {
    const view = recommendationResultView(success(page(), result({ recommended: 3 })), 'teacher_hydration_completed');
    expect(view.emptyNotice).toBeNull();
  });
});

describe('16J-PREUI-E4-C2-B3-A AA to AC. failure, staleness and the shell’s boundaries', () => {
  it('AA. a controller error says the recommendation failed, and blames nothing else', () => {
    const view = recommendationResultView({ status: 'error', error: '无法获取推荐：响应格式异常。' }, 'teacher_hydration_completed');
    expect(view.status).toBe('error');
    expect(view.message).toBe(RECOMMENDATION_MESSAGES.error);
    // NOT converted into a review-source judgement: nothing was learned about the source.
    expect(view.message).not.toBe(RECOMMENDATION_MESSAGES.reviewUnavailable);
    expect(view.reviewNotice).toBeNull();
    // And no internal text leaks: the controller's own bounded sentence is not rendered as a stack or a code.
    expect(view.message.length).toBeLessThan(40);
  });

  it('stale means a changed tab and nothing else', () => {
    const view = recommendationResultView({ status: 'stale', reason: 'tab_changed' }, 'teacher_hydration_partial');
    expect(view.status).toBe('stale');
    expect(view.message).toBe(RECOMMENDATION_MESSAGES.stale);
    expect(view.message).toContain('标签页');
    // It is none of the three things it must never be mistaken for.
    expect(view.message).not.toBe(RECOMMENDATION_MESSAGES.reviewUnavailable);
    expect(view.message).not.toBe(RECOMMENDATION_MESSAGES.emptyInsufficient);
    expect(view.message).not.toBe(RECOMMENDATION_MESSAGES.teacherPartial);
    // A stale answer carries no result to summarise.
    expect(view.counts).toBeNull();
  });

  it('an incomplete preparation reads as "no recommendation was generated"', () => {
    for (const stopReason of ['cancelled', 'course_list_incomplete', 'read_failed'] as const) {
      const view = recommendationIdleView(stopReason, true);
      expect(view.status, stopReason).toBe('idle');
      expect(view.message, stopReason).toBe(RECOMMENDATION_MESSAGES.preparationIncomplete);
      expect(view.counts, stopReason).toBeNull();
    }
  });

  it('an untouched result area says nothing at all', () => {
    const view = recommendationIdleView(undefined, false);
    expect(view.message).toBe('');
    expect(view.status).toBe('idle');
  });

  it('AB. the result area adds no runtime listener', () => {
    expect([...sidepanelSource.matchAll(/chrome\.runtime\.onMessage\.addListener/gu)]).toHaveLength(1);
    // The result module owns no transport of its own: it never sends a message.
    const resultSource = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'recommendation-result.ts'), 'utf8');
    expect(resultSource.includes('sendMessage')).toBe(false);
    expect(resultSource.includes('chrome.')).toBe(false);
  });

  it('AC and AD. the SHELL still renders no course field of its own', () => {
    /*
     * UPDATED IN 16J-PREUI-E4-C2-B3-B2. This used to forbid the panel and the shell from naming any course field at all, which held while no card existed. Cards
     * exist now, and they are rendered by their own module from the frozen presentation model.
     *
     * What still protects the design is that the SHELL — the summary layer this step built — has not started reading courses: it counts the three arrays and reads
     * the run-level review source, and touches nothing else. The card module is where course fields are allowed, and it must go through the model.
     */
    const resultSource = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'recommendation-result.ts'), 'utf8');
    const resultCode = resultSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
    for (const forbidden of ['course.teacher', 'teacherSet', 'remainingSeats', 'credits', 'gradeAggregates', 'score', 'confidence']) {
      expect(resultCode.includes(forbidden), forbidden).toBe(false);
    }
    // The course objects themselves are only ever COUNTED — `length` — and never read into.
    const courseReads = [...resultCode.matchAll(/result\.(\w+)/gu)].map((match) => match[1]);
    expect([...new Set(courseReads)].sort()).toEqual(['insufficientData', 'ratedButNotRecommended', 'recommendations', 'reviewSource']);
    // The shell neither imports the card modules nor builds any card markup.
    expect(resultSource.includes('course-cards')).toBe(false);
    expect(resultSource.includes('course-presentation')).toBe(false);
    // And the panel's HTML has no teacher field or list element to render a name into outside a card.
    expect(sidepanelHtml).not.toContain('teacher-name');
    expect(sidepanelHtml).not.toContain('teacher-list');
  });

  it('the result area has exactly one shell section, and the card lists are the only lists', () => {
    expect([...sidepanelHtml.matchAll(/id="recommendation"/gu)]).toHaveLength(1);
    /*
     * UPDATED IN 16J-PREUI-E4-C2-B3-B2. The card area added three ordered lists of its own — one per result kind — so the panel no longer has exactly one `<ol>`.
     *
     * UPDATED AGAIN IN PRE-RELEASE-UX-A14: the identity-sample list was removed, so there are now exactly THREE `<ol>` elements, all of them card lists. The old
     * assertion `toContain('id="course-samples-list"')` was the last pin holding that development block in the document, and it is replaced by the opposite
     * requirement rather than deleted.
     */
    expect([...sidepanelHtml.matchAll(/<ol/gu)]).toHaveLength(3);
    expect(sidepanelHtml).not.toContain('course-samples');
    // The three card lists are the shell's only lists, and they live in their own sections rather than inside the summary.
    for (const id of ['card-list-recommended', 'card-list-rated', 'card-list-insufficient']) {
      expect(sidepanelHtml, id).toContain(`id="${id}"`);
    }
  });
});
