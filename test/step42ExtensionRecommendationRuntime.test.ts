/**
 * PART 16I-G — the extension's REAL runtime components run the whole recommendation pipeline.
 *
 * ## What "real" means here, and why it matters
 *
 * This is the first time the three pieces are composed: the canonical engine, the extension's own policy, and a browser-safe
 * provider with its own memory cache. The provider is the genuine `WhuCoursesProvider` and the cache the genuine `MemoryCache` —
 * NOT a fake provider — because a fake would prove only that the engine accepts an interface, while the claim under test is that
 * this host's actual components work together. Only the innermost `fetch` is a spy, so no socket is opened while the whole chain
 * above it is exercised for real.
 *
 * ## The upstream shape is the site's real schema
 *
 * Rows use the Chinese field names the provider reads, taken from the same table the parsing path uses, so the response is parsed
 * for real. The course and teachers are the repository's established fixture pair.
 *
 * Chinese literals are written as escapes so this file survives any tooling that is careless with UTF-8.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { recommendExtensionCourses } from '../apps/extension/src/background/recommendation-runtime.js';
import { EXTENSION_RECOMMENDATION_POLICY } from '../apps/extension/src/background/recommendation-policy.js';
import { MemoryCache } from '../apps/extension/src/background/memory-cache.js';
import { createGuardedPublicReviewFetch } from '../apps/extension/src/background/public-review-fetch.js';
import { WhuCoursesProvider } from '@course-copilot/provider';
import type { NormalizedCourse, RawReviewRow } from '@course-copilot/core/course';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = join(repoRoot, 'apps', 'extension');

const COURSE = '\u5de5\u4e1a\u9769\u547d\u4e0e\u4eba\u7c7b\u53d1\u5c55';
const TEACHER_A = '\u5468\u5955\u534e';
const TEACHER_B = '\u5218\u5174\u6d77';
/** The delimiter the page actually uses between co-teaching teachers. */
const DELIMITER = '\u3001';

/** The site's real field names, taken from the provider's own table rather than invented. */
const FIELDS = {
  courseName: '\u8bfe\u7a0b\u540d\u79f0',
  teacher: '\u6388\u8bfe\u8001\u5e08',
  attendance: '\u8003\u52e4\u4e0e\u5e73\u65f6\u4f5c\u4e1a',
  assessment: '\u671f\u672b\u8003\u6838\u65b9\u5f0f',
  content: '\u8bfe\u7a0b\u5185\u5bb9\u4e0e\u8bc4\u4ef7',
  grade: '\u8bfe\u7a0b\u6210\u7ee9',
} as const;

/** Two rows for the co-taught course: one per teacher, with distinguishable grades. */
const UPSTREAM_ROWS = [
  {
    [FIELDS.courseName]: COURSE,
    [FIELDS.teacher]: TEACHER_A,
    [FIELDS.grade]: '92',
    [FIELDS.attendance]: '\u5076\u5c14\u70b9\u540d',
    [FIELDS.assessment]: '\u8bba\u6587',
    [FIELDS.content]: '\u5185\u5bb9\u5145\u5b9e\uff0c\u8bb2\u5f97\u6e05\u695a\uff0c\u7ed9\u5206\u53cb\u597d\u3002',
  },
  {
    [FIELDS.courseName]: COURSE,
    [FIELDS.teacher]: TEACHER_B,
    [FIELDS.grade]: '81',
    [FIELDS.attendance]: '\u6bcf\u8282\u70b9\u540d',
    [FIELDS.assessment]: '\u95ed\u5377\u8003\u8bd5',
    [FIELDS.content]: '\u8282\u594f\u504f\u5feb\uff0c\u4f5c\u4e1a\u8f83\u591a\u3002',
  },
];

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly credentials: string | undefined;
}

/**
 * Build the real provider over the guarded fetch with a spy at the innermost layer.
 *
 * ## Why the FACTORY rather than the exported `guardedPublicReviewFetch` constant
 *
 * The constant is built at module load with `underlying = globalThis.fetch`, so it captures whatever `fetch` existed when that
 * module was first evaluated — before this test installed its spy. Measured here: the spy recorded ZERO calls while a
 * recommendation was still produced, because the guard was delegating to the ambient `fetch` it had captured earlier.
 *
 * The factory takes the underlying implementation explicitly, which is exactly the seam this test needs. The constant stays as it
 * is, because the production worker wants the opposite behaviour: capture the real `fetch` once and delegate to it thereafter.
 */
function buildRuntime(): { provider: WhuCoursesProvider; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const spy = ((url: unknown, init?: { method?: string; credentials?: string }) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', credentials: init?.credentials });
    return Promise.resolve(new Response(JSON.stringify(UPSTREAM_ROWS), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
  }) as unknown as typeof fetch;

  const cache = new MemoryCache<RawReviewRow[]>({ ttlMs: 6 * 60 * 60 * 1000 });
  const provider = new WhuCoursesProvider({
    cache,
    fetchImpl: createGuardedPublicReviewFetch(spy) as unknown as typeof fetch,
  });

  return { provider, calls };
}

/** A normalized course as an adapter would produce it. */
function course(teacher: string): NormalizedCourse {
  return {
    source: 'whu',
    courseName: COURSE,
    normalizedName: COURSE,
    teacher,
    normalizedTeacher: teacher,
    availability: 'available',
    remainingSeats: 10,
  } as unknown as NormalizedCourse;
}

/** The co-taught form the page publishes: one `teacher` cell naming the whole class. */
const CO_TAUGHT = `${TEACHER_A}${DELIMITER}${TEACHER_B}`;

const CLOCK = (): Date => new Date('2026-01-01T00:00:00.000Z');

describe('16I-G the extension runtime executes the canonical pipeline', () => {
  it('FIRST EXECUTION: a recommendation result with real evidence', async () => {
    const runtime = buildRuntime();
    const result = await recommendExtensionCourses({
      courses: [course(TEACHER_A)],
      provider: runtime.provider,
      now: CLOCK,
    });

    console.log(`  first run: fetchCalls=${runtime.calls.length} recommendations=${result.recommendations.length}`);
    if (runtime.calls.length > 0) console.log(`  first url = ${runtime.calls[0]?.url}`);

    // The pipeline ran and produced a recommendation.
    expect(result.recommendations.length).toBeGreaterThan(0);
    const top = result.recommendations[0];
    expect(top).toBeDefined();

    // Course identity travelled through, unmodified.
    expect(top?.course.courseName).toBe(COURSE);

    // Review evidence was assembled, and the score/confidence paths executed.
    expect(top?.reviewContext).toBeDefined();
    expect(top?.confidence).toBeDefined();
    expect(top?.score).not.toBeNull();
    expect(typeof top?.rank).toBe('number');

    // The policy's default preferences were applied — the extension's own values, not a package default.
    expect(result.preferences).toEqual(EXTENSION_RECOMMENDATION_POLICY.defaultPreferences);

    // The engine queried the real provider over the guarded boundary.
    expect(runtime.calls.length).toBeGreaterThan(0);
    expect(runtime.calls[0]?.url.startsWith('https://whucourses.cn/api/search')).toBe(true);
    expect(runtime.calls[0]?.credentials).toBe('omit');
  }, 60_000);

  it('CACHE REUSE: the same provider/cache makes no second request', async () => {
    const runtime = buildRuntime();
    const input = { courses: [course(TEACHER_A)], provider: runtime.provider, now: CLOCK };
    const first = await recommendExtensionCourses(input);
    const afterFirst = runtime.calls.length;
    const second = await recommendExtensionCourses(input);
    const afterSecond = runtime.calls.length;

    console.log(`  network: first=${afterFirst} second-delta=${afterSecond - afterFirst}`);

    expect(first.recommendations.length).toBeGreaterThan(0);
    // The first run reached the network...
    expect(afterFirst).toBeGreaterThan(0);
    // ...and the second run was answered entirely from the browser memory cache.
    expect(afterSecond - afterFirst).toBe(0);
    // Same answer, so the cache returned the same evidence rather than merely avoiding a call.
    expect(JSON.stringify(second.recommendations)).toBe(JSON.stringify(first.recommendations));
  }, 60_000);

  it('MULTI-TEACHER EVIDENCE: a co-taught class keeps BOTH teachers, not first-teacher-only', async () => {
    /*
     * ## What this measures, and what it deliberately does not claim
     *
     * The regression this guards is the one the multi-teacher design exists for: a first-teacher-only pipeline would still produce
     * a recommendation and still pass every shape check above, so the assertion has to be about the EVIDENCE.
     *
     * Measured: the co-taught form is a `teacher` cell naming the whole class, delimited with `、`. The provider then returns BOTH
     * teachers' rows — 2 reviews — and the recommendation carries both, so this is NOT first-teacher-only.
     *
     * What it does NOT claim: that `teachingClassLevel` is present in the recommendation. It is not, and the reason is a
     * pre-existing property of the engine rather than anything this step changed — see the dedicated test below.
     */
    const runtime = buildRuntime();
    const result = await recommendExtensionCourses({
      courses: [course(CO_TAUGHT)],
      provider: runtime.provider,
      now: CLOCK,
    });

    const top = result.recommendations[0];
    expect(top).toBeDefined();

    // Both teachers' evidence reached the result.
    const serialized = JSON.stringify(result);
    expect(serialized.includes(TEACHER_A)).toBe(true);
    expect(serialized.includes(TEACHER_B)).toBe(true);

    /*
     * And the COUNT is asserted, not just the presence of two names somewhere.
     *
     * This is the half a first-teacher-only pipeline fails: if the co-taught cell were truncated to its first teacher, row B would
     * never be parsed and the course-wide sample count would read 1. A name-substring check alone cannot distinguish "both teachers
     * were read" from "one was read and the other appeared in a warning".
     */
    expect(top?.confidence?.inputs?.courseReviewCount).toBe(2);
    const serializedTop = JSON.stringify(top);
    expect(serializedTop.includes(TEACHER_A)).toBe(true);
    expect(serializedTop.includes(TEACHER_B)).toBe(true);

    // The provider really returned both rows, so this is not a name that arrived some other way.
    expect(runtime.calls.length).toBeGreaterThan(0);
    const contextText = JSON.stringify(top?.reviewContext);
    expect(contextText.length).toBeGreaterThan(2);
  }, 60_000);

  it('the co-taught fixture itself carries both teachers, so the assertion above can fail', () => {
    /*
     * A control on the FIXTURE. The multi-teacher test would be vacuous if the upstream rows had silently become single-teacher,
     * because `courseReviewCount === 2` would then be unreachable for a reason unrelated to the pipeline. This pins the fixture:
     * two rows, two distinct teachers, one per row.
     */
    expect(UPSTREAM_ROWS).toHaveLength(2);
    const teachers = UPSTREAM_ROWS.map((row) => row[FIELDS.teacher]);
    expect(teachers).toEqual([TEACHER_A, TEACHER_B]);
    expect(new Set(teachers).size).toBe(2);
  }, 60_000);

  it('CLASS-SCOPED EVIDENCE (16I-G-R3): the co-taught class roll-up reaches the recommendation', async () => {
    /*
     * ## What changed, and how it is observed
     *
     * This test used to record a GAP: `defaultLookup` rebuilt its result without `teachingClassLevel`, so `recommendCourses` had
     * no class-scoped evidence and `calculateReviewConfidence` fell back to the winning bucket. 16I-G-R3 passes the provider's
     * aggregates through for a single provider, and the two observations below are what changed as a result:
     *
     *   evidenceReviewCount   1 -> 2       (was the one teacher's bucket; now the class's own unique rows)
     *   confidence value      0.1964 -> 0.2848
     *
     * The `MatchResult` itself cannot be read from the public result: `Recommendation.match` is a reduced view whose properties do
     * not enumerate, so `JSON.stringify` shows only `{ method, confidence, trusted }`. The proof is therefore taken where the
     * values ARE observable — the direct lookup, and the confidence inputs the engine publishes.
     */
    const runtime = buildRuntime();
    const plan = await import('@course-copilot/recommendation');

    // The planner carries the full published set for a co-taught class, and sends no wire filter.
    const queries = [...plan.planQueries([course(CO_TAUGHT)]).queries.values()];
    expect(queries).toHaveLength(1);
    expect(queries[0]?.localTeacherNames).toEqual([TEACHER_A, TEACHER_B]);
    expect(queries[0]?.teacher).toBeUndefined();

    // The real provider partitions the corpus for this class, both teachers included.
    const direct = await runtime.provider.searchCourse({ courseName: COURSE, localTeacherNames: [TEACHER_A, TEACHER_B], limit: 25 });
    expect(direct.reviews).toHaveLength(2);
    expect(direct.teachingClassLevel?.scope).toBe('teachingClass');
    expect(direct.teachingClassLevel?.courseReviewCount).toBe(2);
    const scopedTeachers = direct.teachingClassLevel?.teacherCandidates.map((candidate) => candidate.teacher) ?? [];
    expect(scopedTeachers.sort()).toEqual([TEACHER_A, TEACHER_B].sort());

    /*
     * The decisive observation: `defaultLookup` — the lookup `recommendCourses` actually uses — now carries the aggregate.
     * A fresh runtime is used because a shared cache would change the cache accounting and make the assertion order-dependent.
     */
    const lookupRuntime = buildRuntime();
    const looked = await plan.defaultLookup([lookupRuntime.provider], 25)({ courseName: COURSE, localTeacherNames: [TEACHER_A, TEACHER_B] });
    /*
     * `outcomes` and `reviewSource` were added in 16J-PREUI-D2: every query now states how it ended, so a caller can tell a legitimate empty
     * answer from a failed request. No `courseSupplementary` here — this fixture has no teacher-less rows.
     *
     * The order is JavaScript's default string sort, in which `reviewSource` precedes `reviews`: a capital `S` sorts before a lowercase `s`.
     */
    /*
     * UPDATED IN PRE-RELEASE-UX-A16: `reviewExcerpts` is now published by the provider on every search result, so the exact key set gained it.
     * Kept exact rather than loosened — this case exists to state precisely what a lookup result carries.
     */
    expect(Object.keys(looked).sort()).toEqual(['courseLevel', 'fromCache', 'outcomes', 'provider', 'reviewExcerpts', 'reviewSource', 'reviews', 'teachingClassLevel', 'warnings']);
    expect(looked.teachingClassLevel?.scope).toBe('teachingClass');
    expect(looked.courseLevel?.scope).toBe('course');

    // And the confidence the recommendation publishes reflects the class-scoped count rather than the bucket fallback.
    const result = await recommendExtensionCourses({
      courses: [course(CO_TAUGHT)],
      provider: runtime.provider,
      now: CLOCK,
    });
    const confidence = result.recommendations[0]?.confidence;
    expect(confidence).toBeDefined();
    expect(confidence?.inputs?.evidenceReviewCount).toBe(2);
    expect(confidence?.inputs?.courseReviewCount).toBe(2);
    // The course total is a real roll-up over both rows, published onto the buckets by the provider.
    expect(confidence?.inputs?.matchedTeacherReviewCount).toBe(1);
  }, 60_000);

  it('PERMANENT REQUEST TRACE: a co-taught cell fans out to exactly ONE allowlisted request', async () => {
    /*
     * R2 captured this trace through a throwaway probe; it is a permanent assertion now, because the fan-out is a property worth
     * defending: a co-taught cell must NOT be narrowed to one teacher on the wire, and must not pay for a second corpus request
     * either — the provider notices that a filter-less response already IS the whole course.
     */
    const runtime = buildRuntime();
    const result = await recommendExtensionCourses({
      courses: [course(CO_TAUGHT)],
      provider: runtime.provider,
      now: CLOCK,
    });

    console.log(`  co-taught: fetchCalls=${runtime.calls.length} recommendations=${result.recommendations.length}`);
    expect(result.recommendations.length).toBeGreaterThan(0);

    expect(runtime.calls).toHaveLength(1);
    const call = runtime.calls[0];
    const url = new URL(String(call?.url));
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('whucourses.cn');
    expect(url.pathname).toBe('/api/search');
    expect([...url.searchParams.keys()].sort()).toEqual(['course_name']);
    expect(url.searchParams.get('course_name')).toBe(COURSE);
    expect(url.searchParams.has('instructor')).toBe(false);
    expect(call?.method).toBe('GET');
    expect(call?.credentials).toBe('omit');

    // A second identical run costs nothing: the browser cache answers it.
    const before = runtime.calls.length;
    await recommendExtensionCourses({ courses: [course(CO_TAUGHT)], provider: runtime.provider, now: CLOCK });
    expect(runtime.calls.length - before).toBe(0);
  }, 60_000);

  it('SINGLE-TEACHER CONTROL: a teacher-scoped cell still pays for the corpus request', async () => {
    /*
     * The control that stops the co-taught expectation from being satisfied the wrong way. A future change could make "co-taught = 1
     * request" pass by deleting the teacher-scoped corpus fetch entirely — and that would break the course total for every
     * teacher-scoped lookup. A teacher-scoped response is genuinely different data, so it legitimately costs two requests.
     */
    const runtime = buildRuntime();
    await recommendExtensionCourses({ courses: [course(TEACHER_A)], provider: runtime.provider, now: CLOCK });

    console.log(`  single-teacher: fetchCalls=${runtime.calls.length}`);
    expect(runtime.calls).toHaveLength(2);
    const keys = runtime.calls.map((call) => [...new URL(String(call.url)).searchParams.keys()].sort());
    const instructors = runtime.calls.map((call) => new URL(String(call.url)).searchParams.get('instructor'));
    // #1 is the teacher-scoped query, #2 the whole-course corpus.
    expect(keys).toEqual([['course_name', 'instructor'], ['course_name']]);
    expect(instructors).toEqual([TEACHER_A, null]);
  }, 60_000);

  it('the run stayed inside the guard: the request is the allowlisted one', async () => {
    const runtime = buildRuntime();
    await recommendExtensionCourses({ courses: [course(TEACHER_A)], provider: runtime.provider, now: CLOCK });
    expect(runtime.calls.length).toBeGreaterThan(0);
    for (const call of runtime.calls) {
      const url = new URL(call.url);
      expect(url.protocol).toBe('https:');
      expect(url.hostname).toBe('whucourses.cn');
      expect(url.pathname).toBe('/api/search');
      expect(url.searchParams.get('course_name')).toBe(COURSE);
      expect(call.method).toBe('GET');
    }
  }, 60_000);
});

describe('16I-G the runner is orchestration only', () => {
  const runtimeSource = readFileSync(join(extensionRoot, 'src', 'background', 'recommendation-runtime.ts'), 'utf8');
  const runtimeCode = runtimeSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

  it('uses the canonical engine, and delegates rather than reimplements', () => {
    expect(runtimeCode.includes("from '@course-copilot/recommendation'")).toBe(true);
    expect(/recommendCourses\(/u.test(runtimeCode)).toBe(true);
    // None of the algorithm's parts may appear here.
    for (const forbidden of [
      'calculateCourseScore', 'calculateReviewConfidence', 'matchCourse', 'filterEligible',
      'planQueries', 'partitionCleanRows', 'summarizeCleanRows', 'teacherSetRelation',
      'normalizePreferences', 'compareDecisions',
    ]) {
      expect(runtimeCode.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('binds the extension policy, and takes the provider by injection', () => {
    expect(runtimeCode.includes('EXTENSION_RECOMMENDATION_POLICY')).toBe(true);
    // The provider is never constructed and never queried directly: `defaultLookup` inside the engine owns that.
    for (const forbidden of ['new WhuCoursesProvider', 'new MemoryCache', 'new RequestLimiter', '.searchCourse(']) {
      expect(runtimeCode.includes(forbidden), forbidden).toBe(false);
    }
    const specifiers = [...runtimeCode.matchAll(/from\s*['"]([^'"]+)['"]/gu)].map((m) => m[1] ?? '').sort();
    expect(specifiers).toEqual([
      './recommendation-policy.js',
      '@course-copilot/core/course',
      '@course-copilot/provider',
      '@course-copilot/recommendation',
    ]);
  });

  it('does not restate any policy value of its own', () => {
    // The values belong to the policy module; this file may only name the binding.
    for (const literal of ['gradeFriendliness:', 'workloadFriendliness:', 'defaultTopN:', 'maxTopN:', 'candidateLimit:']) {
      expect(runtimeCode.includes(literal), literal).toBe(false);
    }
  });
});

describe('16I-G production stays inert and the contracts are unchanged', () => {
  const workerSource = readFileSync(join(extensionRoot, 'src', 'background', 'service-worker.ts'), 'utf8');
  const workerCode = workerSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

  it('the worker carries the composition and calls the chain only from the handler', () => {
    /*
     * UPDATED IN 16J-F-B-R1 and again IN 16J-G-B. The first asserted the worker imports the RUNNER directly (measurement made that
     * redundant); then it asserted the composition is called NOWHERE, which 16J-G-B supersedes by giving it one real caller.
     *
     * What holds now: the composition is imported and guarded, and its ONLY call sits inside the recommendation handler branch, so
     * loading the worker still runs nothing.
     */
    expect(workerCode.includes("import { requestVisibleRecommendations } from './visible-recommendations.js'")).toBe(true);
    expect(/typeof requestVisibleRecommendations !== 'function'/u.test(workerCode)).toBe(true);

    const handlerBranch = /if \(type === QUERY_RECOMMENDATIONS_MESSAGE\) \{[\s\S]*?\n    \}/u.exec(workerCode)?.[0] ?? '';
    expect(handlerBranch.includes('requestVisibleRecommendations('), 'the call lives in the handler').toBe(true);
    // Exactly one call, and it disappears when the handler branch is removed — so nothing calls it at module scope.
    expect([...workerCode.matchAll(/requestVisibleRecommendations\(/gu)]).toHaveLength(1);
    expect(workerCode.split(handlerBranch).join('').includes('requestVisibleRecommendations(')).toBe(false);
    // And the runner is not named by the worker at all.
    expect(workerCode.includes('recommendExtensionCourses')).toBe(false);
  });

  it('the worker no longer imports the engine directly — the runner, reached through the composition, is its route to it', () => {
    // The engine must still be REACHABLE, which the runner provides, but the worker holds no engine binding of its own.
    expect(workerCode.includes("from '@course-copilot/recommendation'")).toBe(false);
    expect(workerCode.includes('recommendCourses')).toBe(false);
    // Nor does it hold the runner binding: both arrive by dependency two levels down.
    expect(workerCode.includes("from './recommendation-runtime.js'")).toBe(false);
  });

  it('WORKER MESSAGE TYPES = 7, EXTENSION MESSAGE TYPE UNION = 20', () => {
    /*
     * UPDATED IN 16J-G-B, which added the worker's `QUERY_RECOMMENDATIONS` handler — a genuinely new global type. Six are declared
     * by the worker; the seventh was the transport contract the helper module owns.
     *
     * The title's UNION figure was corrected to nineteen in PRE-RELEASE-UX-A4C. The worker still declares its own six unchanged —
     * that is the assertion below, and it passes — while the EXTENSION union grew as the preparation workflow added a session per
     * capability. The previous title conflated the two numbers, which is why it read as a single contract.
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

    const union = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!full.endsWith('.ts')) continue;
        for (const match of readFileSync(full, 'utf8').matchAll(/'(COURSE_COPILOT_[A-Z_]+)'/gu)) union.add(match[1] ?? '');
      }
    };
    walk(join(extensionRoot, 'src'));
    /*
     * UPDATED IN PRE-RELEASE-UX-A4C, from a bare count to the exact set.
     *
     * The count had been frozen at seven before the unified preparation workflow landed. The workflow added a full session per
     * capability — start, cancel, status query and event for the course list, teacher hydration and the composed preparation — so
     * the union is now twenty-three. Naming every member keeps the check STRICTER than the count it replaces: a bare `toBe(19)` would
     * pass if one type were swapped for another, while an exact list fails on any addition, removal or rename.
     */
    expect([...union].sort()).toEqual([
      'COURSE_COPILOT_AUTO_EXPAND_EVENT',
      'COURSE_COPILOT_AVAILABILITY_FILTER_EVENT',
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
      'COURSE_COPILOT_TEACHER_HYDRATION_EVENT',
    ]);
    // The full-visible contract is still answered by the content script and still never named by the worker.
    expect(workerCode.includes('QUERY_VISIBLE_ROWS')).toBe(false);
  });

  it('the only message type added is the recommendation query', () => {
    /*
     * INVERTED IN 16J-G-B. This used to forbid every recommendation-shaped message name, because none was allowed to exist. One
     * now legitimately does, so the check states what replaced it: that ONE type was added, and that no OTHER recommendation
     * message appeared — no result-push message, no per-result variant.
     *
     * The patterns name message constants specifically. A bare `RECOMMENDATION` substring would match
     * `EXTENSION_RECOMMENDATION_POLICY`, which is legitimate — the check has to be about the message surface.
     */
    const messageNames = [...workerCode.matchAll(/const (\w+_MESSAGE) = /gu)].map((m) => m[1] ?? '');
    expect(messageNames.filter((name) => name.includes('RECOMMENDATION'))).toEqual(['QUERY_RECOMMENDATIONS_MESSAGE']);
    for (const forbidden of ['RECOMMENDATIONS_RESULT_MESSAGE', 'RECOMMEND_RESULT', 'RECOMMENDATION_RESULT_MESSAGE', 'RECOMMENDATIONS_PUSH_MESSAGE']) {
      expect(workerCode.includes(forbidden), forbidden).toBe(false);
    }
  });
});
