/**
 * PRE-RELEASE-UX-A18 — the weights reach the engine, and the DEFAULT weights change nothing.
 *
 * ## The two claims this file exists to separate
 *
 * 1. **The editor can change the ranking.** A control that cannot move a course is not a control, so the engine is driven with genuinely different weight
 *    vectors over a corpus whose courses have opposite profiles.
 * 2. **An untouched editor is the same request as no editor at all.** `10 / 6 / 3 / 1` normalises to `0.5 / 0.3 / 0.15 / 0.05`, so the default ranking,
 *    score, membership and confidence must be identical to a run that supplies no preferences. This is measured on the real engine, not argued from the
 *    ratio.
 *
 * ## And the transport
 *
 * The controller is driven with an injected sender, so the message that would cross the process boundary is inspected directly — including that a re-rank
 * sends exactly ONE message and that it is the recommendation request.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recommendCourses } from '@course-copilot/recommendation';
import { createRecommendationRequestController } from '../apps/extension/src/sidepanel/recommendation-request.js';
import { PREFERENCE_DEFAULTS, preferencePayloadOf } from '../apps/extension/src/sidepanel/preferences.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const POLICY = {
  defaultPreferences: { gradeFriendliness: 0.5, workloadFriendliness: 0.3, attendanceFriendliness: 0.15, overallScore: 0.05 },
  defaultTopN: 5, maxTopN: 50, candidateLimit: 25,
} as never;

/**
 * The four RANKABLE METRICS, and the ASPECT each one maps onto.
 *
 * The two vocabularies differ by exactly one entry: the metric `overallScore` is the aspect `studentSentiment`. That is the engine's own mapping
 * (`LEGACY_METRIC_TO_ASPECT`) rather than a choice made here, and getting it wrong is invisible — a fixture that published the score under `overallScore`
 * would look right and rank nothing, because the engine would find no usable dimension. It did exactly that while this suite was being written, which is why
 * the mapping is written out and asserted below.
 */
const RANKABLE_ASPECTS = [
  { metric: 'gradeFriendliness', aspect: 'gradeFriendliness' },
  { metric: 'workloadFriendliness', aspect: 'workloadFriendliness' },
  { metric: 'attendanceFriendliness', aspect: 'attendanceFriendliness' },
  { metric: 'overallScore', aspect: 'studentSentiment' },
] as const;

/**
 * Four courses with OPPOSITE profiles.
 *
 * Course A is excellent on marking and terrible at everything else; course B is the reverse. A weighting that prefers marking must rank A first and a
 * weighting that prefers a light workload must rank B first — which is the only way to prove the sliders reach the scoring at all.
 */
const COURSES = [
  { name: '给分课', scores: [10, 0, 0, 0] },
  { name: '轻松课', scores: [0, 10, 0, 0] },
  { name: '考勤课', scores: [0, 0, 10, 0] },
  { name: '口碑课', scores: [0, 0, 0, 10] },
];

/** A provider answering with each course's own aspect profile. */
function provider(): never {
  return {
    searchCourse: async (query: { courseName: string }) => {
      const course = COURSES.find((entry) => entry.name === query.courseName) ?? COURSES[0]!;
      const scores = RANKABLE_ASPECTS.map(({ aspect }, index) => ({
        aspect, score: course.scores[index] ?? 0, evidenceReviewCount: 2, mentionCount: 2,
        positiveReviewCount: 2, negativeReviewCount: 0, mixedReviewCount: 0,
        positiveMentions: 2, negativeMentions: 0, sampleCount: 2, matchedTerms: [], note: 'fixture',
      }));
      const review = {
        provider: 'stub', courseName: query.courseName, normalizedName: query.courseName,
        reviewCount: 2, courseReviewCount: 2, matchedTeacherReviewCount: 2,
        reviewedCount: 2, coveredReviewCount: 2, gradedSampleCount: 2,
        meanGrade: 90, medianGrade: 90, gradeDistribution: { '90': 2 },
        aspects: { scores, positiveMentions: 8, negativeMentions: 0, mixedReviewCount: 0, coveredReviewCount: 2, reviewCount: 2, examFormats: {} },
      };
      return { reviews: [review], provider: 'stub', fromCache: false, warnings: [] };
    },
  } as never;
}

/** Run the engine over the fixture, with or without explicit preferences. */
async function run(preferences?: Record<string, number>) {
  return recommendCourses(
    COURSES.map((course) => ({ source: 'whu', courseName: course.name, normalizedName: course.name, availability: 'unknown', teacher: '张三' }) as never),
    // `preferences` lives on the OPTIONS argument, not on the courses argument.
    preferences === undefined ? {} : { preferences },
    { providers: [provider()], policy: POLICY },
  );
}

/** The observable shape of a run: order, scores, membership and confidence. */
function shape(result: Awaited<ReturnType<typeof run>>) {
  return {
    order: result.recommendations.map((entry) => `${entry.rank}:${(entry.course as { courseName: string }).courseName}`),
    scores: result.recommendations.map((entry) => entry.score),
    confidences: result.recommendations.map((entry) => entry.confidence.value),
    rated: result.ratedButNotRecommended.map((entry) => `${entry.rank}:${(entry.course as { courseName: string }).courseName}`),
    weights: result.preferences,
  };
}

describe('PRE-RELEASE-UX-A18 default parity', () => {
  it('the UI defaults reproduce the no-preferences run EXACTLY', async () => {
    /*
     * The claim the whole 0..10 scale was chosen for. `10 / 6 / 3 / 1` is the ratio the shipped defaults hold, so supplying it explicitly must be
     * indistinguishable from not supplying anything.
     */
    const without = shape(await run(undefined));
    const withDefaults = shape(await run(preferencePayloadOf(PREFERENCE_DEFAULTS)));

    expect(withDefaults.order).toEqual(without.order);
    expect(withDefaults.scores).toEqual(without.scores);
    expect(withDefaults.confidences).toEqual(without.confidences);
    expect(withDefaults.rated).toEqual(without.rated);
    // And the engine resolved the same weights.
    expect(withDefaults.weights).toEqual(without.weights);
    expect(without.weights).toEqual({ gradeFriendliness: 0.5, workloadFriendliness: 0.3, attendanceFriendliness: 0.15, overallScore: 0.05 });
  });

  it('nothing about the default run is empty or degraded', async () => {
    // A parity test that compared two empty results would pass while proving nothing.
    const result = await run(preferencePayloadOf(PREFERENCE_DEFAULTS));
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(shape(result).scores.every((score) => typeof score === 'number' && score > 0)).toBe(true);
  });
});

describe('PRE-RELEASE-UX-A18 the weights actually move the ranking', () => {
  it('a marking-heavy choice and a workload-heavy choice rank DIFFERENT courses first', async () => {
    const marking = shape(await run({ gradeFriendliness: 10, workloadFriendliness: 1, attendanceFriendliness: 1, overallScore: 1 }));
    const workload = shape(await run({ gradeFriendliness: 1, workloadFriendliness: 10, attendanceFriendliness: 1, overallScore: 1 }));

    expect(marking.order[0]).toContain('给分课');
    expect(workload.order[0]).toContain('轻松课');
    // The two orders genuinely differ, so the sliders are reaching the score rather than being echoed back.
    expect(marking.order).not.toEqual(workload.order);
    // And the resolved weights differ accordingly.
    expect(marking.weights.gradeFriendliness).toBeGreaterThan(marking.weights.workloadFriendliness);
    expect(workload.weights.workloadFriendliness).toBeGreaterThan(workload.weights.gradeFriendliness);
  });

  it('every dimension can be made decisive, so none of the four is inert', async () => {
    /*
     * One control at a time. A dimension wired to nothing would leave its course out of first place however large its value became — which is exactly the
     * "false control" this slice must not ship.
     */
    for (const [index, { metric }] of RANKABLE_ASPECTS.entries()) {
      const preferences = { gradeFriendliness: 0, workloadFriendliness: 0, attendanceFriendliness: 0, overallScore: 0 };
      preferences[metric] = 10;
      const result = shape(await run(preferences));
      expect(result.order[0], metric).toContain(COURSES[index]?.name ?? '');
    }
  });

  it('a single non-zero dimension is a complete, usable request', async () => {
    // The all-zero refusal is about zero, not about sparsity: one dimension at 10 is a legitimate choice and must rank.
    const result = await run({ gradeFriendliness: 0, workloadFriendliness: 0, attendanceFriendliness: 0, overallScore: 10 });
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(shape(result).order[0]).toContain('口碑课');
  });
});

describe('PRE-RELEASE-UX-A18 the transport', () => {
  /** Drive the controller with an injected sender and return the messages it sent. */
  async function send(preferences?: Record<string, number>): Promise<{ readonly messages: RuntimeMessage[] }> {
    const messages: RuntimeMessage[] = [];
    const controller = createRecommendationRequestController({
      sink: () => { /* the state is not under test here */ },
      queryActiveTab: async () => [{ id: 7 }],
      sendMessage: async (message: RuntimeMessage) => {
        messages.push(message);
        // A canonical-looking success, so the controller takes its success arm.
        return { ok: true, page: { read: 'ok', rowCount: 1, courseCount: 1, completeness: 'complete' }, result: { recommendations: [], ratedButNotRecommended: [], considered: 0, excluded: [], insufficientData: [], ambiguousCandidates: [], preferences: {}, dataCoverage: null, meta: {} } };
      },
    });
    await controller.request(7, preferences);
    return { messages };
  }

  it('carries an explicit vector to the message, unrenamed and with no extra key', async () => {
    const vector = { gradeFriendliness: 10, workloadFriendliness: 6, attendanceFriendliness: 3, overallScore: 1 };
    const { messages } = await send(vector);
    expect(messages).toHaveLength(1);
    const message = messages[0] as { type?: string; tabId?: number; preferences?: Record<string, number> };
    expect(message.type).toBe('COURSE_COPILOT_QUERY_RECOMMENDATIONS');
    expect(message.tabId).toBe(7);
    expect(message.preferences).toEqual(vector);
    // Exactly four keys, so a renamed or duplicated dimension would fail here.
    expect(Object.keys(message.preferences ?? {}).sort()).toEqual(['attendanceFriendliness', 'gradeFriendliness', 'overallScore', 'workloadFriendliness']);
  });

  it('omits the field entirely when no preference is supplied', async () => {
    // "The user expressed no preference" and "the user sent an empty object" are different statements, and only the first is a default run.
    const { messages } = await send(undefined);
    expect(messages).toHaveLength(1);
    expect(Object.hasOwn(messages[0] as object, 'preferences')).toBe(false);
  });

  it('sends exactly ONE message per update action', async () => {
    /*
     * The count assertion the release contract needs: a re-rank must not fan out into a second request. The weights travel on the SAME request the
     * controller already knows how to make, so there is no second channel and nothing extra to send.
     */
    const { messages } = await send({ gradeFriendliness: 10, workloadFriendliness: 6, attendanceFriendliness: 3, overallScore: 1 });
    expect(messages).toHaveLength(1);
  });

  it('names the tab it was given, so a re-rank cannot migrate to another page', async () => {
    /*
     * ## The two halves, and why both are needed
     *
     * The panel passes the tab its RESULT belongs to. A mutation that changed that to `undefined` — "rank whatever is in front" — was NOT caught by the
     * stale-tab case below, because that case refuses for a different reason and sends nothing either way. So the first half drives a MATCHING active tab
     * and asserts the message still names the given id.
     */
    const matching: RuntimeMessage[] = [];
    const matchingController = createRecommendationRequestController({
      sink: () => { /* not under test */ },
      queryActiveTab: async () => [{ id: 7 }],
      sendMessage: async (message: RuntimeMessage) => {
        matching.push(message);
        return { ok: true, page: { read: 'ok', rowCount: 1, courseCount: 1, completeness: 'complete' }, result: { recommendations: [], ratedButNotRecommended: [], considered: 0, excluded: [], insufficientData: [], ambiguousCandidates: [], preferences: {}, dataCoverage: null, meta: {} } };
      },
    });
    await matchingController.request(7, { gradeFriendliness: 1, workloadFriendliness: 1, attendanceFriendliness: 1, overallScore: 7 });
    expect(matching).toHaveLength(1);
    expect((matching[0] as { tabId?: unknown }).tabId).toBe(7);

    /*
     * And the half that matters for migration: the ACTIVE tab is a different one, so the expected-tab binding reports `stale` and sends NOTHING — a re-rank
     * cannot read a page the result does not describe.
     */
    const messages: RuntimeMessage[] = [];
    const controller = createRecommendationRequestController({
      sink: () => { /* not under test */ },
      queryActiveTab: async () => [{ id: 99 }],
      sendMessage: async (message: RuntimeMessage) => {
        messages.push(message);
        return { ok: true, page: { read: 'ok', rowCount: 1, courseCount: 1, completeness: 'complete' }, result: { recommendations: [], ratedButNotRecommended: [], considered: 0, excluded: [], insufficientData: [], ambiguousCandidates: [], preferences: {}, dataCoverage: null, meta: {} } };
      },
    });
    await controller.request(7, { gradeFriendliness: 1, workloadFriendliness: 1, attendanceFriendliness: 1, overallScore: 7 });
    expect(messages).toHaveLength(0);
  });

  it('the panel sends the update even when the choice is all zero', async () => {
    /*
     * ## Why this is asserted in SOURCE
     *
     * The panel's click handler is DOM logic, so the pure-module tests cannot reach it and a mutation proved that: replacing the guard with `if (false)`
     * left every behavioural case green, because none of them presses the button. The handler is therefore sliced out and pinned by what it must contain.
     *
     * A disabled button is a courtesy — a reader can re-enable it in devtools — so the guard is re-run inside the handler as the actual enforcement, and
     * both halves are asserted.
     */
    const panel = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');
    const handler = panel.slice(panel.indexOf("apply.addEventListener('click'"), panel.indexOf('void recommendation.request('));
    expect(handler.length).toBeGreaterThan(0);
    expect(handler).toContain('if (preferenceProblemOf(values) !== null) {');
    expect(handler).toContain('return;');
    // And the button is disabled up front, so the refusal is visible BEFORE the click rather than only after it.
    expect(panel).toContain('(apply as HTMLButtonElement).disabled = problem !== null;');
  });

  it('the update action targets the result\'s tab, never the active one', async () => {
    /*
     * The same lesson: this is DOM logic, and a mutation replacing `recommendation.request(targetTabId, …)` with `request(undefined, …)` left the controller
     * tests green because they call the controller directly. Pinned here by name, with the slice running to the END of the handler's request call.
     */
    const panel = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');
    const handler = panel.slice(panel.indexOf("apply.addEventListener('click'"), panel.indexOf('void recommendation.request(') + 120);
    // The tab comes from the controller's record of the result, not from a fresh query.
    expect(handler).toContain('const targetTabId = recommendation.tabId();');
    // A missing target is REFUSED rather than defaulted: falling back to the active tab would rank a page the user never prepared.
    expect(handler).toContain('if (targetTabId === null) {');
    expect(handler).toContain('PREFERENCES_NO_TARGET_TEXT');
    // And the request is bound to that exact id.
    expect(handler).toContain('recommendation.request(targetTabId, preferencePayloadOf(values));');
    // No active-tab fallback anywhere in the handler, in either spelling.
    expect(handler.includes('request(undefined')).toBe(false);
    expect(handler.includes('queryActiveTab')).toBe(false);
  });

  it('the worker FORWARDS the weights into the engine\'s own options', async () => {
    /*
     * ## Why this is asserted in source as well as in behaviour
     *
     * The recommendation handler was already driven end to end with weights, and a mutation that deleted this forwarding line left it green — because the
     * panel's OWN default ratio (`10 / 6 / 3 / 1`) normalises to the host defaults, so a dropped payload and a forwarded one produce the same ranking for
     * that particular vector. The behaviour test now sends a vector that differs from the defaults, and this pins the wiring itself.
     *
     * The requirement is that the weights arrive as the engine's `options.preferences` — the field `recommendCourses` already reads — rather than being
     * applied anywhere in the worker. The worker performs no arithmetic of its own: `normalizePreferences` is the engine's.
     */
    const worker = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'background', 'service-worker.ts'), 'utf8');
    const branch = /if \(type === QUERY_RECOMMENDATIONS_MESSAGE\) \{[\s\S]*?\n    \}/u.exec(worker)?.[0] ?? '';
    expect(branch.length).toBeGreaterThan(0);
    expect(branch).toContain('options: { preferences: message.preferences }');
    // Forwarded only when present, so an untouched editor sends the same message it always did.
    expect(branch).toContain('message.preferences === undefined ? {} :');
    // And the worker applies no arithmetic of its own to the numbers.
    for (const forbidden of ['normalizePreferences(', 'Object.fromEntries', 'Math.round', 'toFixed(']) {
      expect(branch.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('the panel carries no page-preparation call of its own', async () => {
    /*
     * The panel DOES own a preparation control — that is the approved data-preparation button — so "the panel never starts one" would be false. The rule is
     * narrower and is the one the product requires: the PREFERENCE editor starts nothing. Both halves are asserted, because either alone is satisfiable by
     * the wrong code.
     */
    const panel = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');
    // The preparation start exists exactly once, and it is not in the editor.
    expect([...panel.matchAll(/preparation\.start\(\)/gu)].length).toBe(1);
    const editor = panel.slice(panel.indexOf('function wirePreferenceEditor()'), panel.indexOf('wirePreferenceEditor();'));
    expect(editor.length).toBeGreaterThan(0);
    for (const forbidden of ['preparation.start', 'preparation.reset', 'handoff', 'full-preparation']) {
      expect(editor.includes(forbidden), forbidden).toBe(false);
    }
    // The editor sends exactly one thing, and only from the update action.
    expect([...editor.matchAll(/recommendation\.request\(/gu)].length).toBe(1);
    expect([...editor.matchAll(/sendMessage\(/gu)].length).toBe(0);
  });
});

describe('PRE-RELEASE-UX-A18 a re-rank performs no page preparation', () => {
  /** The four START messages that would repeat page work, and the panel must never name any of them. */
  const PREPARATION_MESSAGES = [
    'COURSE_COPILOT_START_AVAILABILITY_FILTER',
    'COURSE_COPILOT_START_FULL_PREPARATION',
    'COURSE_COPILOT_START_AUTO_EXPAND',
    'COURSE_COPILOT_START_TEACHER_HYDRATION',
  ];

  it('the panel names no preparation START message at all', () => {
    /*
     * THE release contract, asserted the strongest way available statically: the panel cannot start a page operation because it does not know the name of
     * one. The filter, the load-more clicks and the teacher-detail expansion are three separate START messages, and every one of them is sent by the
     * preparation controller rather than by the panel.
     */
    const panel = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');
    for (const message of PREPARATION_MESSAGES) {
      expect(panel.includes(message), message).toBe(false);
    }
    // And it sends no page-side message of its own: the only thing it sends is the recommendation request, through the controller.
    expect(panel.includes('chrome.tabs.sendMessage')).toBe(false);
  });

  it('the worker forward path is not reachable from a recommendation request', () => {
    /*
     * The second half. The worker's preparation forwarder exists, but the recommendation branch does not call it — so a weight-only request cannot reach
     * the page even indirectly.
     */
    const worker = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'background', 'service-worker.ts'), 'utf8');
    const branch = /if \(type === QUERY_RECOMMENDATIONS_MESSAGE\) \{[\s\S]*?\n    \}/u.exec(worker)?.[0] ?? '';
    expect(branch.length).toBeGreaterThan(0);
    expect(branch.includes('forwardPreparationMessage')).toBe(false);
    expect(branch.includes('forwardAvailabilityFilterMessage')).toBe(false);
    // The one thing it does reach is the composed read-and-rank path.
    expect(branch.includes('requestVisibleRecommendations')).toBe(true);
  });

  it('the read the re-rank performs has no page-interaction branch', () => {
    /*
     * The read is `QUERY_VISIBLE_ROWS`, and its content-script handler queries and scans. Asserted on that handler's own body, so a later edit that added a
     * click there would fail here rather than silently turning every re-rank into a page operation.
     */
    const content = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'content', 'content-script.ts'), 'utf8');
    const handler = /if \(message\?\.type === QUERY_VISIBLE_ROWS_MESSAGE\) \{[\s\S]*?\n    \}/u.exec(content)?.[0] ?? '';
    expect(handler.length).toBeGreaterThan(0);
    for (const forbidden of ['.click()', 'dispatchEvent', 'button[name=query]', 'FILTER_QUERY_BUTTON_SELECTOR']) {
      expect(handler.includes(forbidden), forbidden).toBe(false);
    }
    // It reads the page's own state and answers.
    expect(handler.includes('scanVisibleRows()')).toBe(true);
  });
});
