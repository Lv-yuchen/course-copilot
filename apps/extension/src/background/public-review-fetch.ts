/**
 * The extension's outbound boundary for public review data.
 *
 * ## What this file is
 *
 * A `fetch` implementation with a strict allowlist, injected into the review provider. Everything the worker would ever send to
 * `whucourses.cn` passes through here first, so the privacy rules live in ONE place that can be read, tested and mutated, rather
 * than being spread across every call site that will exist later.
 *
 * It is an allowlist, not a filter. A request that does not match every rule is REJECTED — it is never "sanitised" into something
 * allowed, because a silently rewritten request would hide the mistake that produced it.
 *
 * ## Why the rules are this narrow
 *
 * The extension reads PUBLIC review data. It has no business sending anything else anywhere, so the boundary admits exactly one
 * shape of request:
 *
 * - `https://whucourses.cn/api/search`, and no other origin, protocol, port, or path;
 * - `GET` only, with no body, so nothing can be uploaded;
 * - query keys limited to `course_name` (required) and `instructor` (optional);
 * - `credentials: 'omit'`, so no cookie, token or storage-derived value can ever travel with the request.
 *
 * The last point is the one that matters most. A logged-in WHU session cookie is exactly the kind of credential this extension must
 * never attach to a public review query, and `omit` makes that structural rather than a matter of review.
 *
 * ## What it deliberately does not do
 *
 * It does not time out, retry, cache, parse, or inspect the response body. The provider already owns timeout and cancellation, and
 * this boundary's single job is deciding whether a request may leave. It also does not touch the provider's URL encoding or
 * matching semantics — it receives a finished URL and either permits it or refuses.
 *
 * @module course-selection-copilot/background/public-review-fetch
 */

/** The only host this extension may reach. */
const ALLOWED_HOSTNAME = 'whucourses.cn';

/** The only path this extension may request. */
const ALLOWED_PATHNAME = '/api/search';

/** The only protocol permitted. */
const ALLOWED_PROTOCOL = 'https:';

/** Query keys the boundary admits. `course_name` is required; the rest are optional. */
const REQUIRED_QUERY_KEYS = ['course_name'] as const;
const OPTIONAL_QUERY_KEYS = ['instructor'] as const;

/** Every query key that may appear, required and optional together. */
const ALLOWED_QUERY_KEYS: readonly string[] = [...REQUIRED_QUERY_KEYS, ...OPTIONAL_QUERY_KEYS];

/**
 * Raised when a request is refused by the boundary.
 *
 * It is thrown rather than returned as a synthetic `Response` on purpose: a fabricated 403 would look like an answer from the
 * server and could be cast to a payload, while a thrown error cannot be mistaken for data. The provider surfaces a rejection as a
 * failure, which is what a blocked request is.
 */
export class PublicReviewBoundaryError extends Error {
  override readonly name = 'PublicReviewBoundaryError';

  constructor(message: string) {
    super(message);
  }
}

/** The subset of `RequestInit` this boundary forwards, matching how the provider calls `fetch`. */
export interface PublicReviewRequestInit {
  readonly method?: string;
  /*
   * Declared structurally rather than as `HeadersInit`, which the extension's `lib` set does not include. The provider passes a
   * plain object (`{ accept: 'application/json' }`), and the value is forwarded untouched.
   */
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal | null;
  readonly body?: unknown;
}

/**
 * A `fetch`-shaped function restricted to the public review endpoint.
 *
 * Structurally assignable to `typeof fetch` for the call the provider makes, without claiming the full `fetch` surface this
 * boundary does not implement.
 */
export type PublicReviewFetch = (url: string | URL, init?: PublicReviewRequestInit) => Promise<Response>;

/**
 * Refuse anything that is not the single permitted request shape.
 *
 * @param input - the URL the provider built.
 * @param init - the request options the provider passed.
 * @throws PublicReviewBoundaryError when any rule is violated.
 */
function assertAllowedRequest(input: string | URL, init?: PublicReviewRequestInit): URL {
  let url: URL;
  try {
    url = new URL(typeof input === 'string' ? input : input.href);
  } catch {
    throw new PublicReviewBoundaryError(`拒绝请求：URL 无法解析：${String(input)}`);
  }

  // Destination: protocol, hostname and port together, so `http:`, a different host, and `:8443` are all refused.
  if (url.protocol !== ALLOWED_PROTOCOL) {
    throw new PublicReviewBoundaryError(`拒绝请求：协议必须是 ${ALLOWED_PROTOCOL}，实际为 ${url.protocol}`);
  }
  if (url.hostname !== ALLOWED_HOSTNAME) {
    throw new PublicReviewBoundaryError(`拒绝请求：主机必须是 ${ALLOWED_HOSTNAME}，实际为 ${url.hostname}`);
  }
  if (url.port !== '') {
    throw new PublicReviewBoundaryError(`拒绝请求：不允许指定端口，实际为 ${url.port}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new PublicReviewBoundaryError('拒绝请求：URL 中不允许包含凭据');
  }
  if (url.pathname !== ALLOWED_PATHNAME) {
    throw new PublicReviewBoundaryError(`拒绝请求：路径必须是 ${ALLOWED_PATHNAME}，实际为 ${url.pathname}`);
  }
  // A fragment is never sent, but its presence means the caller built something other than the query this boundary permits.
  if (url.hash !== '') {
    throw new PublicReviewBoundaryError('拒绝请求：URL 中不允许包含 fragment');
  }

  // Query: an exact key set. An extra key is refused rather than dropped, so a caller cannot quietly widen what leaves.
  //
  // The keys come from the ENTRIES rather than from `searchParams.keys()`, because that method needs the `DOM.Iterable` lib and
  // this file must not force a library change onto the shared extension config.
  //
  // Two wrong forms were tried first, both measured rather than reasoned about, and both recorded so they are not reintroduced:
  //
  // 1. `new Set(searchParams)` does not produce key names: spreading a `URLSearchParams` yields entries.
  // 2. Those entries are ARRAYS — `["course_name", "高等数学"]` — not `"key,value"` strings, so slicing at a comma produced empty
  //    strings and every legitimate request was refused as having an "extra parameter".
  //
  // `Array.prototype.at` is used because `noUncheckedIndexedAccess` is on: it returns `string | undefined` honestly.
  const keys = [...new Set([...url.searchParams as unknown as Iterable<readonly string[]>]
    .map((entry) => entry.at(0) ?? ''))];
  const extra = keys.filter((key) => !ALLOWED_QUERY_KEYS.includes(key));
  if (extra.length > 0) {
    throw new PublicReviewBoundaryError(`拒绝请求：不允许的查询参数 ${extra.join(', ')}`);
  }
  for (const required of REQUIRED_QUERY_KEYS) {
    const value = url.searchParams.get(required);
    if (value === null || value.trim() === '') {
      throw new PublicReviewBoundaryError(`拒绝请求：缺少必需的查询参数 ${required}`);
    }
  }

  // Method: absent is treated as GET, which is what `fetch` itself does.
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    throw new PublicReviewBoundaryError(`拒绝请求：只允许 GET，实际为 ${method}`);
  }

  // Body: refused for ANY value, including an empty string, since this boundary has no concept of an allowed payload.
  if (init?.body !== undefined && init?.body !== null) {
    throw new PublicReviewBoundaryError('拒绝请求：不允许请求体');
  }

  return url;
}

/**
 * Perform a public review request, or refuse it.
 *
 * The forwarded `init` is rebuilt rather than spread, so the forwarded set is exactly what is listed here: the method, the
 * caller's headers, the caller's abort signal, and `credentials: 'omit'`. Anything else a caller passes is dropped by
 * construction, which is what keeps this an allowlist.
 *
 * The signal is forwarded unchanged, so the provider's own timeout and abort behaviour continue to work. `credentials: 'omit'`
 * overrides any value a caller might have supplied.
 *
 * @param input - the URL, already built by the provider.
 * @param init - the request options, already built by the provider.
 * @param underlying - the real `fetch`. Injectable so tests use a fake and never open a socket.
 * @returns the underlying response, untouched.
 */
export function createGuardedPublicReviewFetch(
  underlying: typeof fetch = globalThis.fetch,
): PublicReviewFetch {
  return async (input, init) => {
    const url = assertAllowedRequest(input, init);
    return underlying(url.href, {
      method: 'GET',
      headers: init?.headers,
      signal: init?.signal ?? undefined,
      credentials: 'omit',
    });
  };
}

/**
 * The boundary the worker injects into the provider.
 *
 * Created once, reusing the environment's `fetch`. It holds no state and persists nothing; constructing it performs no I/O.
 */
export const guardedPublicReviewFetch: PublicReviewFetch = createGuardedPublicReviewFetch();
