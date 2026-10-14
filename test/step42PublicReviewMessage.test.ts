/**
 * PART 16G-C — the public-review worker message.
 *
 * ## What this covers
 *
 * One internal path: caller → service worker → the module-scope `WhuCoursesProvider` → a structured `ReviewSearchResult`, and back
 * through the provider's own `MemoryCache` on a repeat. The worker is the BUILT artifact, loaded with a stubbed `chrome` and a spy
 * `fetch`, so the message handler that runs is the shipped one.
 *
 * ## Why there is no real network here
 *
 * Every response is a fake. The upstream shape is the site's ACTUAL schema — Chinese keys, read from the provider's own
 * `WHUCOURSES_FIELDS` — so the parsing path is exercised for real while no socket is opened. The live round trip was proved once in
 * 16G-B and must not be repeated on every test run.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'apps', 'extension', 'dist');
const workerBundle = join(distDir, 'background', 'service-worker.js');
const workerSource = readFileSync(join(repoRoot, 'apps', 'extension', 'src', 'background', 'service-worker.ts'), 'utf8');
const workerCode = workerSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

const COURSE = '工业革命与人类发展';
const TEACHER = '张三';

/** The site's real field names, from the provider's own constant table. */
const FIELDS = {
  courseName: '课程名称',
  teacher: '授课老师',
  attendance: '考勤与平时作业',
  assessment: '期末考核方式',
  content: '课程内容与评价',
  grade: '课程成绩',
} as const;

/** Two rows in the upstream schema: one graded 90, one graded 80. */
const UPSTREAM_ROWS = [
  {
    [FIELDS.courseName]: COURSE,
    [FIELDS.teacher]: TEACHER,
    [FIELDS.grade]: '90',
    [FIELDS.attendance]: '偶尔点名',
    [FIELDS.assessment]: '论文',
    [FIELDS.content]: '内容充实，讲得清楚。',
  },
  {
    [FIELDS.courseName]: COURSE,
    [FIELDS.teacher]: '李四',
    [FIELDS.grade]: '80',
    [FIELDS.attendance]: '每节点名',
    [FIELDS.assessment]: '闭卷考试',
    [FIELDS.content]: '节奏偏快。',
  },
];

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly credentials: string | undefined;
}

interface LoadedWorker {
  readonly fetchCalls: FetchCall[];
  readonly listeners: Array<(message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => unknown>;
}

/** A distinct-URL counter so every load re-evaluates the module instead of reusing a cached namespace. */
let serial = 0;

/**
 * Load the built worker with a fake `fetch` installed BEFORE the import.
 *
 * The module captures `globalThis.fetch` while evaluating the guard, so installing the fake afterwards would leave the real one in
 * place — the counter would read zero for the wrong reason.
 */
async function loadWorker(options: { readonly body?: string; readonly reject?: Error; readonly status?: number } = {}): Promise<LoadedWorker> {
  const scratch = join(distDir, '..', '..', '..', 'dist', '16gc-harness');
  mkdirSync(scratch, { recursive: true });
  const modulePath = join(scratch, `worker-${serial += 1}.mjs`);
  copyFileSync(workerBundle, modulePath);

  const fetchCalls: FetchCall[] = [];
  const listeners: LoadedWorker['listeners'] = [];
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = { chrome: globals.chrome, fetch: globals.fetch, log: console.log };
  console.log = () => {};

  globals.chrome = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: (listener: LoadedWorker['listeners'][number]) => { listeners.push(listener); } },
      sendMessage: () => Promise.resolve(),
    },
    sidePanel: { setPanelBehavior: () => Promise.resolve() },
    tabs: { sendMessage: () => Promise.resolve(undefined) },
  };
  globals.fetch = ((url: string, init?: { method?: string; credentials?: string }) => {
    fetchCalls.push({ url: String(url), method: init?.method ?? 'GET', credentials: init?.credentials });
    if (options.reject !== undefined) return Promise.reject(options.reject);
    return Promise.resolve(new Response(options.body ?? JSON.stringify(UPSTREAM_ROWS), {
      status: options.status ?? 200,
      headers: { 'content-type': 'application/json' },
    }));
  }) as unknown as typeof fetch;

  try {
    await import(`${pathToFileURL(modulePath).href}?load=${serial}`);
  } finally {
    console.log = previous.log;
    globals.chrome = previous.chrome;
    globals.fetch = previous.fetch;
    rmSync(modulePath, { force: true });
    if (readdirSync(scratch).length === 0) rmSync(scratch, { recursive: true, force: true });
  }

  return { fetchCalls, listeners };
}

/** Send one message and await the response, whether it arrives synchronously or through the async channel. */
async function send(worker: LoadedWorker, message: unknown): Promise<{ response: unknown; returnedTrue: boolean }> {
  const listener = worker.listeners[0];
  if (listener === undefined) throw new Error('the worker registered no message listener');
  let responded = false;
  let response: unknown;
  const returned = listener(message, { tab: undefined }, (value: unknown) => { responded = true; response = value; });
  // The handler returns `true` when it will answer asynchronously; wait for that answer.
  for (let tick = 0; tick < 50 && !responded; tick += 1) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 1));
  }
  return { response, returnedTrue: returned === true };
}

const QUERY = 'COURSE_COPILOT_QUERY_PUBLIC_REVIEWS';

describe('16G-C message contract', () => {
  it('declares exactly seven message types', () => {
    /*
     * UPDATED IN 16J-G-B, which added the worker's `QUERY_RECOMMENDATIONS` handler — a genuinely new global type. The set is still
     * fixed exactly, so a type added for anything else still fails here.
     */
    const declared = [...workerCode.matchAll(/const (\w+_MESSAGE) = '([^']+)'/gu)].map((match) => match[2]);
    expect(declared).toHaveLength(7);
    expect(declared.sort()).toEqual([
      'COURSE_COPILOT_FULL_PREPARATION_EVENT',
      'COURSE_COPILOT_PAGE_STATUS',
      'COURSE_COPILOT_PANEL_COUNT',
      'COURSE_COPILOT_PING',
      'COURSE_COPILOT_QUERY_PUBLIC_REVIEWS',
      'COURSE_COPILOT_QUERY_RECOMMENDATIONS',
      'COURSE_COPILOT_QUERY_STATUS',
    ].sort());
  });

  it('accepts only courseName and teacher from the message', () => {
    /*
     * Checked against the CODE: the handler reads `message.courseName` and `message.teacher` and no other key. A caller that sends
     * a URL, a token, a cookie or fetch options has them ignored by construction rather than filtered.
     */
    /*
     * `message?.type` uses optional chaining, so the pattern allows the `?.` form — the first version missed it and reported five
     * fields where six exist.
     */
    const reads = [...new Set([...workerCode.matchAll(/message\??\.(\w+)/gu)].map((match) => match[1]))].sort();
    // Compared one element at a time so a mismatch names the field instead of printing a truncated array.
    expect(reads.length).toBe(7);
    for (const [index, expected] of ['count', 'courseName', 'preferences', 'supported', 'tabId', 'teacher', 'type'].sort().entries()) {
      expect(reads[index], `field ${index}`).toBe(expected);
    }
    for (const forbidden of ['message.url', 'message.token', 'message.cookie', 'message.headers', 'message.origin', 'message.fetchOptions']) {
      expect(workerCode.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('worker does not build the URL itself', () => {
    // The teacher travels as a parameter to the provider, never concatenated into a query string here.
    expect(workerCode.includes('URLSearchParams')).toBe(false);
    expect(workerCode.includes('api/search')).toBe(false);
    expect(workerCode.includes('instructor')).toBe(false);
    expect(workerCode.includes('course_name')).toBe(false);
  });
});

describe('16G-C success path', () => {
  it('returns ok:true with the provider result, calling fetch once', async () => {
    const worker = await loadWorker();
    const { response, returnedTrue } = await send(worker, { type: QUERY, courseName: COURSE });

    expect(returnedTrue).toBe(true);
    expect(worker.fetchCalls).toHaveLength(1);
    expect(worker.fetchCalls[0]?.credentials).toBe('omit');
    expect(worker.fetchCalls[0]?.method).toBe('GET');

    const answer = response as { ok: boolean; result?: Record<string, unknown> };
    expect(answer.ok).toBe(true);
    expect(answer.result).toBeDefined();
    // The provider's own contract, not a re-invented schema.
    expect(answer.result?.fromCache).toBe(false);
    expect(Array.isArray(answer.result?.reviews)).toBe(true);
    expect((answer.result?.reviews as unknown[]).length).toBeGreaterThan(0);
    expect(answer.result?.provider).toBe('whucourses');
    expect(answer.result?.warnings).toEqual([]);
    // The course-level roll-up appears for a name-only query, exactly as the provider defines it.
    expect(answer.result?.courseLevel).toBeDefined();
  });

  it('the cached URL is the guarded one: right host, right path, course_name present', async () => {
    const worker = await loadWorker();
    await send(worker, { type: QUERY, courseName: COURSE });
    const url = new URL(worker.fetchCalls[0]?.url ?? '');
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('whucourses.cn');
    expect(url.pathname).toBe('/api/search');
    expect(url.searchParams.get('course_name')).toBe(COURSE);
    expect([...url.searchParams.keys()]).toEqual(['course_name']);
  });
});

describe('16G-C cache path', () => {
  it('a second identical message serves from the module-scope cache and adds no request', async () => {
    const worker = await loadWorker();

    const first = await send(worker, { type: QUERY, courseName: COURSE });
    const afterFirst = worker.fetchCalls.length;
    const second = await send(worker, { type: QUERY, courseName: COURSE });
    const afterSecond = worker.fetchCalls.length;

    expect(afterFirst).toBe(1);
    expect((first.response as { result?: { fromCache?: boolean } }).result?.fromCache).toBe(false);
    // The whole point: one cache for the worker's lifetime, so the repeat is answered locally.
    expect(afterSecond).toBe(1);
    expect((second.response as { result?: { fromCache?: boolean } }).result?.fromCache).toBe(true);
  });

  it('constructs exactly one provider and one cache in the source', () => {
    // A per-message provider would discard the 6-hour cache on every call and still pass a TTL-only test.
    expect(workerCode.split(/new WhuCoursesProvider\(/u).length - 1).toBe(1);
    expect(workerCode.split(/new MemoryCache</u).length - 1).toBe(1);
  });
});

describe('16G-C optional teacher', () => {
  it('forwards a supplied teacher as the instructor parameter', async () => {
    const worker = await loadWorker();
    await send(worker, { type: QUERY, courseName: COURSE, teacher: TEACHER });
    const url = new URL(worker.fetchCalls[0]?.url ?? '');
    expect(url.searchParams.get('course_name')).toBe(COURSE);
    expect(url.searchParams.get('instructor')).toBe(TEACHER);
    // ONLY those two keys, which is what proves the worker forwarded a value instead of stitching a URL.
    expect([...url.searchParams.keys()].sort()).toEqual(['course_name', 'instructor']);
  });

  it('omits the instructor parameter entirely when no teacher is supplied', async () => {
    const worker = await loadWorker();
    await send(worker, { type: QUERY, courseName: COURSE });
    const url = new URL(worker.fetchCalls[0]?.url ?? '');
    expect(url.searchParams.has('instructor')).toBe(false);
    expect([...url.searchParams.keys()]).toEqual(['course_name']);
  });

  it('trims the values before sending them', async () => {
    const worker = await loadWorker();
    await send(worker, { type: QUERY, courseName: `  ${COURSE}  `, teacher: `  ${TEACHER}  ` });
    const url = new URL(worker.fetchCalls[0]?.url ?? '');
    expect(url.searchParams.get('course_name')).toBe(COURSE);
    expect(url.searchParams.get('instructor')).toBe(TEACHER);
  });
});

describe('16G-C invalid input is rejected before anything is sent', () => {
  const INVALID: Array<[string, unknown]> = [
    ['an empty courseName', { type: QUERY, courseName: '' }],
    ['a whitespace courseName', { type: QUERY, courseName: '   ' }],
    ['a non-string courseName (number)', { type: QUERY, courseName: 42 }],
    ['a non-string courseName (null)', { type: QUERY, courseName: null }],
    ['a missing courseName', { type: QUERY }],
    ['an over-limit courseName', { type: QUERY, courseName: 'x'.repeat(201) }],
    ['an empty teacher', { type: QUERY, courseName: COURSE, teacher: '' }],
    ['a whitespace teacher', { type: QUERY, courseName: COURSE, teacher: '  ' }],
    ['a non-string teacher (object)', { type: QUERY, courseName: COURSE, teacher: { name: 'x' } }],
    ['a non-string teacher (number)', { type: QUERY, courseName: COURSE, teacher: 7 }],
    ['an over-limit teacher', { type: QUERY, courseName: COURSE, teacher: 'y'.repeat(201) }],
  ];

  for (const [label, message] of INVALID) {
    it(`refuses ${label} with no outbound request`, async () => {
      const worker = await loadWorker();
      const { response } = await send(worker, message);
      expect((response as { ok: boolean }).ok).toBe(false);
      expect(typeof (response as { error?: unknown }).error).toBe('string');
      // Nothing reached the network, which is the property that matters.
      expect(worker.fetchCalls).toHaveLength(0);
    });
  }

  it('accepts the boundary values exactly (200 characters)', async () => {
    const worker = await loadWorker({ body: '[]' });
    const { response } = await send(worker, { type: QUERY, courseName: 'x'.repeat(200) });
    // Accepted, so the provider WAS called: the limit is inclusive, not off by one.
    expect(worker.fetchCalls).toHaveLength(1);
    expect((response as { ok: boolean }).ok).toBe(true);
  });
});

describe('16G-C failure boundary', () => {
  it('a rejected fetch becomes a bounded failure, not a crash', async () => {
    const worker = await loadWorker({ reject: new Error('network down') });
    const { response } = await send(worker, { type: QUERY, courseName: COURSE });
    const answer = response as { ok: boolean; error?: string; stack?: unknown; result?: unknown };
    expect(answer.ok).toBe(false);
    expect(typeof answer.error).toBe('string');
    expect(answer.result).toBeUndefined();
    // No stack, no raw message from underneath.
    expect(answer.stack).toBeUndefined();
    expect(JSON.stringify(answer)).not.toContain('network down');
  });

  it('an HTTP error becomes a bounded failure', async () => {
    const worker = await loadWorker({ body: 'boom', status: 500 });
    const { response } = await send(worker, { type: QUERY, courseName: COURSE });
    const answer = response as { ok: boolean; error?: string };
    expect(answer.ok).toBe(false);
    expect(answer.error).toBeTypeOf('string');
    expect(JSON.stringify(answer)).not.toContain('500');
  });

  it('a malformed upstream body becomes a bounded failure', async () => {
    // The provider rejects a non-array, non-null payload; the message layer must not surface that as a crash or a stack.
    const worker = await loadWorker({ body: '{"unexpected":true}' });
    const { response } = await send(worker, { type: QUERY, courseName: COURSE });
    const answer = response as { ok: boolean; error?: string; stack?: unknown };
    expect(answer.ok).toBe(false);
    expect(answer.stack).toBeUndefined();
  });

  it('failure responses never carry a URL, credential or provider internals', async () => {
    const worker = await loadWorker({ reject: new Error('nope') });
    const { response } = await send(worker, { type: QUERY, courseName: COURSE });
    const serialized = JSON.stringify(response);
    for (const forbidden of ['whucourses.cn', 'api/search', 'cookie', 'token', 'Authorization', 'Response', 'node_modules']) {
      expect(serialized.includes(forbidden), forbidden).toBe(false);
    }
    expect(Object.keys(response as object).sort()).toEqual(['error', 'ok']);
  });
});
