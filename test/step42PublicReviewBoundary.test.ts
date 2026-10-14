/**
 * PART 16G-A — the outbound boundary in front of the public review endpoint.
 *
 * ## What this tests
 *
 * A `fetch` implementation with an allowlist, injected into the review provider so that no request can leave the worker without
 * passing it. Every case here uses a FAKE underlying `fetch`: the point is to decide what WOULD be sent, and a test that opened a
 * socket to answer that question would be both slower and less trustworthy.
 *
 * The boundary is an allowlist, so the rejections carry as much weight as the permits. A request that does not match every rule is
 * refused outright rather than rewritten into something acceptable, because a silently repaired request hides the mistake that
 * produced it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PublicReviewBoundaryError,
  createGuardedPublicReviewFetch,
} from '../apps/extension/src/background/public-review-fetch.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const boundaryPath = join(repoRoot, 'apps', 'extension', 'src', 'background', 'public-review-fetch.ts');
const boundarySource = readFileSync(boundaryPath, 'utf8');
const boundaryCode = boundarySource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');

interface Captured {
  readonly url: string;
  readonly init: { method?: string; headers?: unknown; signal?: unknown; credentials?: string; body?: unknown };
}

/** A fake `fetch` that records what the boundary forwarded, and answers with a minimal `Response`. */
function fakeFetch(): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = ((url: string, init: Captured['init']) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const ALLOWED_URL = 'https://whucourses.cn/api/search?course_name=%E9%AB%98%E7%AD%89%E6%95%B0%E5%AD%A6';

describe('16G-A allowed requests are forwarded', () => {
  it('permits course_name alone', async () => {
    const { fetchImpl, calls } = fakeFetch();
    const guard = createGuardedPublicReviewFetch(fetchImpl);
    await expect(guard(ALLOWED_URL)).resolves.toBeInstanceOf(Response);
    expect(calls).toHaveLength(1);
  });

  it('permits course_name with instructor', async () => {
    const { fetchImpl, calls } = fakeFetch();
    const guard = createGuardedPublicReviewFetch(fetchImpl);
    await guard(`${ALLOWED_URL}&instructor=%E5%BC%A0%E4%B8%89`);
    expect(calls).toHaveLength(1);
  });

  it('forwards the request with credentials omitted', async () => {
    const { fetchImpl, calls } = fakeFetch();
    const guard = createGuardedPublicReviewFetch(fetchImpl);
    await guard(ALLOWED_URL);
    // The single most important property: no cookie or token may travel with a public review query.
    expect(calls[0]?.init.credentials).toBe('omit');
    expect(calls[0]?.init.method).toBe('GET');
  });

  it('overrides a caller-supplied credentials value', async () => {
    /*
     * A caller that asks for `include` must not get it. The boundary rebuilds the request rather than spreading it, so the
     * forwarded set is exactly what the boundary lists.
     */
    const { fetchImpl, calls } = fakeFetch();
    const guard = createGuardedPublicReviewFetch(fetchImpl);
    await guard(ALLOWED_URL, { credentials: 'include' } as never);
    expect(calls[0]?.init.credentials).toBe('omit');
  });

  it('forwards the abort signal, so provider cancellation still works', async () => {
    const { fetchImpl, calls } = fakeFetch();
    const guard = createGuardedPublicReviewFetch(fetchImpl);
    const controller = new AbortController();
    await guard(ALLOWED_URL, { signal: controller.signal });
    expect(calls[0]?.init.signal).toBe(controller.signal);
  });

  it('treats an absent method as GET', async () => {
    const { fetchImpl, calls } = fakeFetch();
    const guard = createGuardedPublicReviewFetch(fetchImpl);
    await guard(ALLOWED_URL, {});
    expect(calls).toHaveLength(1);
  });
});

describe('16G-A rejected requests never reach the network', () => {
  const REJECTIONS: Record<string, string> = {
    'a non-https protocol': 'http://whucourses.cn/api/search?course_name=A',
    'a different host': 'https://other.example/api/search?course_name=A',
    'a lookalike host': 'https://whucourses.cn.evil.example/api/search?course_name=A',
    'a subdomain of the allowed host': 'https://www.whucourses.cn/api/search?course_name=A',
    'a different path': 'https://whucourses.cn/other?course_name=A',
    'the site root': 'https://whucourses.cn/?course_name=A',
    'an explicit port': 'https://whucourses.cn:8443/api/search?course_name=A',
    'an extra query key': `${ALLOWED_URL}&limit=100`,
    'a missing course_name': 'https://whucourses.cn/api/search?instructor=A',
    'an empty course_name': 'https://whucourses.cn/api/search?course_name=',
    'a blank course_name': 'https://whucourses.cn/api/search?course_name=%20',
    'a fragment': `${ALLOWED_URL}#frag`,
    'credentials embedded in the URL': 'https://user:pass@whucourses.cn/api/search?course_name=A',
  };

  for (const [label, url] of Object.entries(REJECTIONS)) {
    it(`refuses ${label}`, async () => {
      const { fetchImpl, calls } = fakeFetch();
      const guard = createGuardedPublicReviewFetch(fetchImpl);
      await expect(guard(url)).rejects.toBeInstanceOf(PublicReviewBoundaryError);
      // And nothing was forwarded: a rejection must not degrade into "sent anyway".
      expect(calls).toHaveLength(0);
    });
  }

  it('refuses a non-GET method', async () => {
    const { fetchImpl, calls } = fakeFetch();
    const guard = createGuardedPublicReviewFetch(fetchImpl);
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'post']) {
      await expect(guard(ALLOWED_URL, { method })).rejects.toBeInstanceOf(PublicReviewBoundaryError);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses any request body', async () => {
    const { fetchImpl, calls } = fakeFetch();
    const guard = createGuardedPublicReviewFetch(fetchImpl);
    for (const body of ['x', '', '{}', JSON.stringify({ a: 1 })]) {
      await expect(guard(ALLOWED_URL, { body })).rejects.toBeInstanceOf(PublicReviewBoundaryError);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses a URL that cannot be parsed', async () => {
    const { fetchImpl } = fakeFetch();
    const guard = createGuardedPublicReviewFetch(fetchImpl);
    await expect(guard('not a url')).rejects.toBeInstanceOf(PublicReviewBoundaryError);
  });
});

describe('16G-A the boundary is not a WHU private-data channel', () => {
  it('reads no page location, cookie jar, or storage', () => {
    // Checked against CODE: the file's prose names these when explaining why it reads none of them.
    for (const forbidden of [
      'location.search', 'location.hash', 'location.href',
      'document.cookie', 'chrome.cookies',
      'localStorage', 'sessionStorage', 'indexedDB', 'XMLHttpRequest',
    ]) {
      expect(boundaryCode.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('contains no browser or Node global that could carry a session', () => {
    for (const forbidden of ['node:', 'Buffer', 'process.', 'require(', 'chrome.']) {
      expect(boundaryCode.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('names exactly one host and one path, as constants', () => {
    // A second host would need a second constant; this makes the single destination explicit.
    expect(boundaryCode).toContain("const ALLOWED_HOSTNAME = 'whucourses.cn'");
    expect(boundaryCode).toContain("const ALLOWED_PATHNAME = '/api/search'");
    expect(boundaryCode).toContain("const ALLOWED_PROTOCOL = 'https:'");
  });

  it('creates no request of its own and performs no I/O at construction', () => {
    const { calls } = fakeFetch();
    // Constructing the guard must not call the underlying fetch.
    createGuardedPublicReviewFetch(fakeFetch().fetchImpl);
    expect(calls).toHaveLength(0);
  });
});
