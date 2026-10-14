/**
 * The side panel's recommendation RESULT area: what one preparation run leads to, and what the panel is entitled to say about it.
 *
 * ## What this owns
 *
 * It decides WHEN a preparation result calls for a recommendation, WHAT the recommendation lifecycle's states read as, and — the part that needs the most care —
 * WHAT may be said about the answer. It owns no transport: the request itself goes through the already-hardened controller, and this module never sends a
 * message.
 *
 * ## Why the page is rendered BEFORE the result
 *
 * A `RecommendationResult` is always well formed, and an empty one is the NORMAL shape for several unrelated situations. Ranked nothing because the page could
 * not be read, because the page lists no courses, because the rows could not be mapped, and because nothing was worth recommending all arrive looking alike. The
 * page status is the only thing that separates them, so it is consulted first and each case gets its own sentence. Deriving any of it from the result would be
 * guessing.
 *
 * ## Why `reviewSource` is rendered separately again
 *
 * The canonical contract already distinguishes a query that succeeded and found nothing (`empty`) from one that obtained no answer (`unavailable`), and the
 * difference is a statement about the world rather than about the data. Telling a reader "the review source is unavailable" when the source answered "I have
 * nothing for this course" is false, so `healthy` with no rows gets its own wording.
 *
 * ## One handoff per preparation
 *
 * A preparation reports itself more than once — a live finished event, a status read on panel open, and possibly a duplicate event — and each of those must not
 * become another request. The dedupe flag is per preparation, cleared by a new approval, and it is the only state this module keeps.
 *
 * @module
 */

import type { RecommendationRequestState } from './recommendation-request.js';

/** The preparation outcomes that may lead to a recommendation, and nothing else. */
const ELIGIBLE_STOP_REASONS = [
  'teacher_hydration_completed',
  'teacher_hydration_partial',
  'teacher_hydration_item_cap',
] as const;

/**
 * Whether a preparation outcome permits a recommendation.
 *
 * A WHITELIST, deliberately. Every reason not named here — a cancellation, an incomplete course list, a failed re-read, and anything a future version adds — is
 * refused without being understood, because the cost of the two mistakes is not symmetric: skipping a recommendation a run could have supported loses one
 * convenience, while requesting one from a page whose preparation did not finish produces numbers a reader may act on while believing the page was ready.
 *
 * @param stopReason - the preparation's reason, as reported.
 * @returns whether a recommendation may be requested.
 */
export function preparationAllowsRecommendation(stopReason: unknown): boolean {
  return typeof stopReason === 'string' && (ELIGIBLE_STOP_REASONS as readonly string[]).includes(stopReason);
}

/** Whether a preparation outcome must keep disclosing that the teacher data is incomplete. */
export function preparationNeedsTeacherDisclosure(stopReason: unknown): boolean {
  return stopReason === 'teacher_hydration_partial' || stopReason === 'teacher_hydration_item_cap';
}

/** What the result area is showing. */
export type RecommendationUiStatus = 'idle' | 'loading' | 'success' | 'stale' | 'error';

/** The result area's complete state, as the renderer needs it. */
export interface RecommendationResultView {
  readonly status: RecommendationUiStatus;
  /** The line for the current status. Empty when the status needs none. */
  readonly message: string;
  /**
   * The page-level explanation, or `null` when the result itself is being summarised.
   *
   * Present INSTEAD of a summary when the page could not supply usable courses: there is no ranking to describe, and describing an empty one would hide why.
   */
  readonly pageNotice: string | null;
  /**
   * A review-source disclosure, or `null` when there is nothing to disclose.
   *
   * Persistent for as long as its condition holds, including alongside a successful summary: a partial or unavailable source qualifies every figure in the
   * result, so it cannot be shown once and then dropped.
   */
  readonly reviewNotice: string | null;
  /**
   * Whether the teacher data behind this result is known to be incomplete.
   *
   * Persistent for the same reason, and independent of the recommendation's own success: a partial preparation does not become complete because a
   * recommendation was produced from it.
   */
  readonly teacherNotice: string | null;
  /** The counts, or `null` when the result area is not summarising a ranking. */
  readonly counts: { readonly recommended: number; readonly rated: number; readonly insufficient: number } | null;
  /** The sentence describing an empty ranking, or `null` when the ranking is not empty. */
  readonly emptyNotice: string | null;
}

/**
 * The wording. One sentence per situation, and none of them shared.
 *
 * The distinction the whole area exists to preserve is between a DATA problem and a QUALITY judgement. `insufficientData` is defined by the canonical contract as
 * "no trusted match, or no aspect carried evidence" — a statement about the evidence, never about the course — so the copy says 证据不足 and never 不推荐 or
 * 课程质量差.
 */
export const RECOMMENDATION_MESSAGES = {
  idle: '',
  loading: '正在生成课程推荐…',
  error: '生成推荐失败。',
  /** A tab change, and nothing else. See {@link STALE_TEXT}. */
  stale: '上一次数据准备任务对应的标签页已变化，未显示这次推荐结果。',
  /** The page the request was about is not one this extension operates on. */
  pageUnsupported: '当前标签页不是支持的 WHU 选课页面。',
  /** Nothing answered: no content script, or the message was rejected. */
  pageUnavailable: '暂时无法读取当前选课页面。',
  /** Something answered, but not in the agreed shape. */
  pageMalformed: '当前选课页面结构无法正常读取。',
  /** A successful read that found no teaching-class rows at all. */
  pageNoRows: '当前没有可用于推荐的教学班记录。',
  /** Rows were read but none became a course: a mapping problem, not an empty page. */
  pageUnmappable: '已读取教学班记录，但暂时无法转换为可推荐课程。',
  /** The review source answered and had nothing. This is NOT an outage. */
  reviewFoundNothing: '公开课程评价查询成功，但未找到匹配评价。',
  /** Some queries failed while others succeeded; the data is used but incomplete. */
  reviewPartial: '部分公开课程评价暂时不可用，结果基于已获取的数据。',
  /** No query obtained an answer. */
  reviewUnavailable: '公开课程评价源暂时不可用。',
  /** A partial preparation, kept visible for as long as it is true. */
  teacherPartial: '教师信息未完全补全，推荐基于当前已获取的数据。',
  /** The ranking is empty but courses were rated — a cut, not a data failure. */
  emptyButRated: '当前有评价数据，但没有课程进入推荐结果。',
  /** Nothing was rated and nothing was recommended, because the evidence is thin. */
  emptyInsufficient: '当前课程评价证据不足，暂时无法形成推荐。',
  /** The ranking is empty for a reason none of the specific sentences covers. */
  emptyOtherwise: '当前没有得到可展示的推荐结果。',
  /** The preparation did not finish, so no recommendation was attempted. */
  preparationIncomplete: '数据准备未完成，因此未生成推荐。',
} as const;

/** The summary labels. `recommended` / `rated` / `insufficient` stay three separate statements. */
export const RECOMMENDATION_LABELS = {
  recommended: '推荐课程',
  rated: '有评价但未进入推荐',
  insufficient: '证据不足',
} as const;

/** Read a numeric field, or `undefined`. */
function countOf(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The page-level notice for a successful recommendation whose page could not supply usable courses.
 *
 * @param page - the worker's own page read status.
 * @returns the notice, or `null` when the page was readable and mapped at least one course.
 */
function pageNoticeFor(page: Record<string, unknown>): string | null {
  /*
   * The supported check runs FIRST, because it changes what every other field means: on a page this extension does not operate on, the read status and the counts
   * describe a page nobody asked about.
   */
  if (page.supported === false) return RECOMMENDATION_MESSAGES.pageUnsupported;
  const read = page.read;
  if (read === 'unavailable') return RECOMMENDATION_MESSAGES.pageUnavailable;
  if (read === 'malformed') return RECOMMENDATION_MESSAGES.pageMalformed;
  if (read !== 'ok') return RECOMMENDATION_MESSAGES.pageUnavailable;

  const rowCount = countOf(page, 'rowCount');
  const courseCount = countOf(page, 'courseCount');
  if (rowCount === 0) return RECOMMENDATION_MESSAGES.pageNoRows;
  /*
   * Rows that could not be mapped. Reported on its own because the two counts disagree only here, and "the page is empty" would be false: the page had rows, the
   * extension could not make courses of them.
   */
  if (rowCount !== undefined && courseCount === 0) return RECOMMENDATION_MESSAGES.pageUnmappable;
  return null;
}

/**
 * The review-source notice, or `null`.
 *
 * @param reviewSource - the run-level health the engine reported.
 * @returns the disclosure the reader needs, if any.
 */
function reviewNoticeFor(reviewSource: unknown): string | null {
  if (typeof reviewSource !== 'object' || reviewSource === null) return null;
  const health = reviewSource as Record<string, unknown>;
  const status = health.status;
  if (status === 'partial') return RECOMMENDATION_MESSAGES.reviewPartial;
  if (status === 'unavailable') return RECOMMENDATION_MESSAGES.reviewUnavailable;
  if (status !== 'healthy') return null;
  /*
   * A HEALTHY source that returned nothing: the queries completed and the site legitimately had no matching reviews. This is the case that must never be worded
   * as an outage, so it is checked explicitly rather than left to the default.
   */
  const queries = countOf(health, 'queries');
  const rows = countOf(health, 'rows');
  const empty = countOf(health, 'empty');
  const unavailable = countOf(health, 'unavailable');
  if ((queries ?? 0) > 0 && rows === 0 && (empty ?? 0) > 0 && (unavailable ?? 0) === 0) {
    return RECOMMENDATION_MESSAGES.reviewFoundNothing;
  }
  return null;
}

/**
 * The sentence for an empty ranking, chosen from what the result actually holds.
 *
 * The three cases are different answers to different questions, so they do not share a sentence: courses that were rated but fell below the cut, courses that had
 * no usable evidence, and a run that produced nothing at all.
 *
 * @param recommended - how many recommendations came back.
 * @param rated - how many were rated below the cut.
 * @param insufficient - how many had no usable evidence.
 * @returns the sentence, or `null` when there is a ranking to summarise instead.
 */
function emptyNoticeFor(recommended: number, rated: number, insufficient: number): string | null {
  if (recommended > 0) return null;
  if (rated > 0) return RECOMMENDATION_MESSAGES.emptyButRated;
  if (insufficient > 0) return RECOMMENDATION_MESSAGES.emptyInsufficient;
  return RECOMMENDATION_MESSAGES.emptyOtherwise;
}

/**
 * The view for "no recommendation has been requested".
 *
 * Exported because the panel needs it BEFORE the controller sinks anything: the controller publishes only when something changes, so a panel that opens onto an
 * untouched result area would otherwise have no view to render at all. The sentence distinguishes the two reasons for an idle area — nothing has been asked for
 * yet, versus a preparation that ended in a way that permits no request.
 *
 * @param preparationStopReason - the preparation's outcome, if it has one.
 * @param hasPreparation - whether a preparation has produced a verdict yet.
 * @returns the idle view.
 */
export function recommendationIdleView(preparationStopReason: unknown, hasPreparation: boolean): RecommendationResultView {
  const stopped = hasPreparation && !preparationAllowsRecommendation(preparationStopReason);
  return {
    status: 'idle',
    message: stopped ? RECOMMENDATION_MESSAGES.preparationIncomplete : RECOMMENDATION_MESSAGES.idle,
    pageNotice: null,
    reviewNotice: null,
    teacherNotice: null,
    counts: null,
    emptyNotice: null,
  };
}

/**
 * Turn one recommendation lifecycle state into what the result area shows.
 *
 * @param state - the controller's published state.
 * @param preparationStopReason - the preparation the request was made for, used for the disclosure and the idle sentence.
 * @returns the view.
 */
export function recommendationResultView(
  state: RecommendationRequestState,
  preparationStopReason: unknown,
): RecommendationResultView {
  if (state.status === 'stale') {
    /*
     * `stale` means ONE thing: the page this request belonged to is no longer the one on screen. It is not a review-source problem, not thin evidence and not
     * incomplete teacher data, so it never borrows any of those sentences.
     */
    return {
      status: 'stale',
      message: RECOMMENDATION_MESSAGES.stale,
      pageNotice: null,
      reviewNotice: null,
      teacherNotice: null,
      counts: null,
      emptyNotice: null,
    };
  }

  if (state.status === 'error') {
    /*
     * A controller-level failure. The page and the review source are NOT blamed: nothing was learned about either, and converting this into "the review source
     * is unavailable" would invent a fact about the world from a transport failure.
     */
    return {
      status: 'error',
      message: RECOMMENDATION_MESSAGES.error,
      pageNotice: null,
      reviewNotice: null,
      teacherNotice: null,
      counts: null,
      emptyNotice: null,
    };
  }

  const teacherNotice = preparationNeedsTeacherDisclosure(preparationStopReason)
    ? RECOMMENDATION_MESSAGES.teacherPartial
    : null;

  if (state.status === 'loading') {
    /*
     * No leftover result is carried here on purpose: showing the previous answer while a new one is being computed would present stale numbers as the current
     * run's. The teacher disclosure survives, because it is a fact about the preparation rather than about the answer being replaced.
     */
    return {
      status: 'loading',
      message: RECOMMENDATION_MESSAGES.loading,
      pageNotice: null,
      reviewNotice: null,
      teacherNotice,
      counts: null,
      emptyNotice: null,
    };
  }

  // `success`: the page speaks first, and only then is there anything to summarise.
  const page = state.page as unknown as Record<string, unknown>;
  const pageNotice = pageNoticeFor(page);
  if (pageNotice !== null) {
    return {
      status: 'success',
      message: '',
      pageNotice,
      /*
       * The review disclosure is still shown beside a page notice: the page explains why there is no ranking, and the source explains what the run learned while
       * trying. It is the same run.
       */
      reviewNotice: reviewNoticeFor((state.result as unknown as Record<string, unknown>).reviewSource),
      teacherNotice,
      counts: null,
      emptyNotice: null,
    };
  }

  const result = state.result as unknown as Record<string, unknown>;
  const recommended = Array.isArray(result.recommendations) ? result.recommendations.length : 0;
  const rated = Array.isArray(result.ratedButNotRecommended) ? result.ratedButNotRecommended.length : 0;
  const insufficient = Array.isArray(result.insufficientData) ? result.insufficientData.length : 0;

  return {
    status: 'success',
    message: '',
    pageNotice: null,
    reviewNotice: reviewNoticeFor(result.reviewSource),
    teacherNotice,
    // Three separate numbers, never merged: a course rated below the cut and a course with no usable evidence are different answers.
    counts: { recommended, rated, insufficient },
    emptyNotice: emptyNoticeFor(recommended, rated, insufficient),
  };
}

/** Whether a state means a request is in flight, so the cancel/again controls can reflect it. */
export function recommendationIsBusy(state: RecommendationRequestState): boolean {
  return state.status === 'loading';
}

/**
 * The panel-side handoff: decides when a finished preparation becomes a recommendation request, exactly once.
 *
 * ## Why this is not inside the preparation state machine
 *
 * The preparation is a three-phase page workflow and the recommendation is a request lifecycle with its own freshness rules. Merging them would make one state
 * machine responsible for both, and the states do not correspond: a preparation can fail after two phases, and a recommendation can go stale while the page it
 * describes is still perfectly prepared.
 *
 * ## The dedupe rule
 *
 * A preparation reports itself more than once — a live event, a status read after a panel reopen, and possibly a duplicate — so this keeps ONE flag per
 * preparation. `reset()` is called on a new approval; the flag is not persisted anywhere, because nothing about a recommendation survives a panel reload, so a
 * reopened panel is entitled to ask again.
 */
export interface RecommendationHandoff {
  /** A new approval: clear the flag so the next completion may ask once. */
  readonly reset: () => void;
  /**
   * Consider a preparation view, and request a recommendation if this completion permits one and has not asked yet.
   *
   * @param phase - the preparation's phase.
   * @param stopReason - the preparation's stop reason.
   * @param operationTabId - the tab the preparation belongs to, which becomes the request's expected tab.
   */
  readonly consider: (phase: string, stopReason: unknown, operationTabId: number | null) => void;
}

/**
 * Create the handoff.
 *
 * @param options.request - the hardened controller's request, taking the approved tab.
 * @returns the handoff.
 */
export function createRecommendationHandoff(options: {
  readonly request: (expectedTabId?: number, preferences?: QueryRecommendationsRequest['preferences']) => Promise<void>;
}): RecommendationHandoff {
  let startedForThisPreparation = false;

  return {
    reset(): void {
      startedForThisPreparation = false;
    },
    consider(phase, stopReason, operationTabId): void {
      // Only a finished preparation can lead to a recommendation.
      if (phase !== 'finished') return;
      if (!preparationAllowsRecommendation(stopReason)) return;
      /*
       * The tab is required, and the request is NOT attempted without it. Falling back to "whatever is active now" would be exactly the migration the expected-tab
       * binding exists to prevent, so a missing id means no request rather than an unbound one.
       */
      if (operationTabId === null) return;
      // One request per preparation, however many times the completion is reported.
      if (startedForThisPreparation) return;
      startedForThisPreparation = true;
      /*
       * The FIRST recommendation of a preparation is always asked for with no preference payload, so the ranking a user sees when the run finishes is the host's
       * own default whatever the editor happens to hold. A weight change afterwards goes through the panel's own update action, which is a separate, explicit
       * trigger — so the editor can never change the meaning of the run that produced the page it is describing.
       */
      void options.request(operationTabId);
    },
  };
}
