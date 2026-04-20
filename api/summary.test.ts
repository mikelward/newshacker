import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  handleSummaryRequest,
  isAllowedReferer,
  __clearCacheForTests,
} from './summary';

const ALLOWED_REFERER = 'https://newshacker.app/item/1';

function makeRequest(
  url: string | null,
  opts: { referer?: string | null } = {},
) {
  const base = 'https://newshacker.app/api/summary';
  const full = url === null ? base : `${base}?url=${encodeURIComponent(url)}`;
  const headers = new Headers();
  const referer = opts.referer === undefined ? ALLOWED_REFERER : opts.referer;
  if (referer !== null) headers.set('referer', referer);
  return new Request(full, { headers });
}

interface GenerateRequest {
  model: string;
  contents: string;
  config?: {
    tools?: unknown[];
    thinkingConfig?: { thinkingBudget?: number };
  };
}

interface FakeResponse {
  text: string | null;
}

function createFakeClient(responses: Array<FakeResponse | Error>) {
  const queue = [...responses];
  const generateContent = vi.fn(async (_req: GenerateRequest) => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected generateContent call');
    if (next instanceof Error) throw next;
    return next;
  });
  return { models: { generateContent } };
}

interface FakeFetchResult {
  body?: string;
  status?: number;
  contentType?: string;
  throws?: Error;
}

function createFakeFetch(routes: Record<string, FakeFetchResult>) {
  return vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    const key = typeof url === 'string' ? url : url.toString();
    const route = routes[key];
    if (!route) throw new Error(`unexpected fetch: ${key}`);
    if (route.throws) throw route.throws;
    return new Response(route.body ?? '', {
      status: route.status ?? 200,
      headers: {
        'content-type': route.contentType ?? 'text/html; charset=utf-8',
      },
    });
  });
}

describe('handleSummaryRequest', () => {
  const origGoogle = process.env.GOOGLE_API_KEY;
  const origJina = process.env.JINA_API_KEY;

  beforeEach(() => {
    __clearCacheForTests();
    process.env.GOOGLE_API_KEY = 'test-key';
    delete process.env.JINA_API_KEY;
  });
  afterEach(() => {
    if (origGoogle === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = origGoogle;
    if (origJina === undefined) delete process.env.JINA_API_KEY;
    else process.env.JINA_API_KEY = origJina;
  });

  it('returns 403 when the Referer header is missing', async () => {
    const res = await handleSummaryRequest(
      makeRequest('https://example.com/a', { referer: null }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 for a disallowed Referer host', async () => {
    const res = await handleSummaryRequest(
      makeRequest('https://example.com/a', { referer: 'https://evil.com/' }),
    );
    expect(res.status).toBe(403);
  });

  it('accepts Referers from localhost and vercel.app previews', async () => {
    const fetchImpl = createFakeFetch({
      'https://example.com/a': { body: '<article>hi</article>' },
    });
    const client = createFakeClient([{ text: 'ok' }]);
    const r1 = await handleSummaryRequest(
      makeRequest('https://example.com/a', {
        referer: 'http://localhost:5173/item/1',
      }),
      { createClient: () => client, fetchImpl },
    );
    expect(r1.status).toBe(200);

    __clearCacheForTests();
    const r2 = await handleSummaryRequest(
      makeRequest('https://example.com/a', {
        referer: 'https://newshacker-preview-abc.vercel.app/item/1',
      }),
      {
        createClient: () => createFakeClient([{ text: 'ok' }]),
        fetchImpl: createFakeFetch({
          'https://example.com/a': { body: '<article>hi</article>' },
        }),
      },
    );
    expect(r2.status).toBe(200);
  });

  it('honors SUMMARY_REFERER_ALLOWLIST when set', async () => {
    const orig = process.env.SUMMARY_REFERER_ALLOWLIST;
    try {
      process.env.SUMMARY_REFERER_ALLOWLIST = 'example.org';
      expect(isAllowedReferer('https://example.org/foo')).toBe(true);
      expect(isAllowedReferer('https://sub.example.org/foo')).toBe(true);
      expect(isAllowedReferer('https://newshacker.app/foo')).toBe(false);
    } finally {
      if (orig === undefined) delete process.env.SUMMARY_REFERER_ALLOWLIST;
      else process.env.SUMMARY_REFERER_ALLOWLIST = orig;
    }
  });

  it('returns 400 when url is missing', async () => {
    const res = await handleSummaryRequest(makeRequest(null));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'Invalid url parameter' });
  });

  it('returns 400 for non-http(s) protocols', async () => {
    const res = await handleSummaryRequest(makeRequest('javascript:alert(1)'));
    expect(res.status).toBe(400);
  });

  it('returns 400 for malformed urls', async () => {
    const res = await handleSummaryRequest(makeRequest('not a url'));
    expect(res.status).toBe(400);
  });

  it('returns 503 when GOOGLE_API_KEY is unset', async () => {
    delete process.env.GOOGLE_API_KEY;
    const res = await handleSummaryRequest(
      makeRequest('https://example.com/a'),
    );
    expect(res.status).toBe(503);
  });

  it('fetches via Jina when JINA_API_KEY is set and summarizes the result', async () => {
    process.env.JINA_API_KEY = 'jina-test-key';
    const fetchImpl = createFakeFetch({
      'https://r.jina.ai/https://www.theverge.com/foo': {
        body: '# Article\n\nMain body text.',
        contentType: 'text/plain; charset=utf-8',
      },
    });
    const client = createFakeClient([{ text: 'A one-sentence summary.' }]);
    const res = await handleSummaryRequest(
      makeRequest('https://www.theverge.com/foo'),
      { createClient: () => client, fetchImpl },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ summary: 'A one-sentence summary.' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [jinaUrl, jinaInit] = fetchImpl.mock.calls[0]!;
    expect(jinaUrl).toBe('https://r.jina.ai/https://www.theverge.com/foo');
    const headers = (jinaInit!.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe('Bearer jina-test-key');
    expect(client.models.generateContent).toHaveBeenCalledTimes(1);
    const call = client.models.generateContent.mock.calls[0]![0];
    expect(call.contents).toContain('Main body text.');
    expect(call.contents).toContain('https://www.theverge.com/foo');
    // Thinking disabled — regression guard for the latency fix.
    expect(call.config?.thinkingConfig?.thinkingBudget).toBe(0);
  });

  it('instructs the model to write in the author voice and skip meta-framing', async () => {
    const articleUrl = 'https://example.com/voice';
    const fetchImpl = createFakeFetch({
      [articleUrl]: { body: '<article>body</article>' },
    });
    const client = createFakeClient([{ text: 'ok' }]);
    await handleSummaryRequest(makeRequest(articleUrl), {
      createClient: () => client,
      fetchImpl,
    });
    const prompt = client.models.generateContent.mock.calls[0]![0].contents;
    expect(prompt).toMatch(/voice of the author/i);
    expect(prompt).toMatch(/The article argues/);
  });

  it('falls back to raw fetch when Jina fails, then summarizes', async () => {
    process.env.JINA_API_KEY = 'jina-test-key';
    const articleUrl = 'https://example.com/a';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { status: 503 },
      [articleUrl]: {
        body: '<html><body><article>Plain HTML body.</article></body></html>',
      },
    });
    const client = createFakeClient([{ text: 'Raw-fetch summary.' }]);
    const res = await handleSummaryRequest(makeRequest(articleUrl), {
      createClient: () => client,
      fetchImpl,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ summary: 'Raw-fetch summary.' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const rawInit = fetchImpl.mock.calls[1]![1]!;
    const rawHeaders = (rawInit.headers ?? {}) as Record<string, string>;
    expect(rawHeaders['user-agent']).toMatch(/Mozilla/);
  });

  it('skips Jina entirely when no JINA_API_KEY is configured', async () => {
    const articleUrl = 'https://example.com/plain';
    const fetchImpl = createFakeFetch({
      [articleUrl]: { body: '<article>Raw HTML.</article>' },
    });
    const client = createFakeClient([{ text: 'Plain summary.' }]);
    const res = await handleSummaryRequest(makeRequest(articleUrl), {
      createClient: () => client,
      fetchImpl,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ summary: 'Plain summary.' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe(articleUrl);
  });

  it('returns 502 with a descriptive message when both Jina and raw fetch fail', async () => {
    process.env.JINA_API_KEY = 'jina-test-key';
    const articleUrl = 'https://paywalled.example.com/story';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { status: 500 },
      [articleUrl]: { status: 403 },
    });
    const client = createFakeClient([]);
    const res = await handleSummaryRequest(makeRequest(articleUrl), {
      createClient: () => client,
      fetchImpl,
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'Could not access the article',
      reason: 'source_unreachable',
    });
    expect(client.models.generateContent).not.toHaveBeenCalled();
  });

  it('returns 504 with source_timeout when both Jina and raw fetch abort', async () => {
    process.env.JINA_API_KEY = 'jina-test-key';
    const articleUrl = 'https://slow.example.com/story';
    const abortErr = Object.assign(new Error('aborted'), {
      name: 'AbortError',
    });
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { throws: abortErr },
      [articleUrl]: { throws: abortErr },
    });
    const client = createFakeClient([]);
    const res = await handleSummaryRequest(makeRequest(articleUrl), {
      createClient: () => client,
      fetchImpl,
    });
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({
      error: "The article site didn't respond in time",
      reason: 'source_timeout',
    });
    expect(client.models.generateContent).not.toHaveBeenCalled();
  });

  it('returns 504 when only the raw fetch times out (no Jina configured)', async () => {
    const articleUrl = 'https://slow.example.com/only-raw';
    const abortErr = Object.assign(new Error('aborted'), {
      name: 'AbortError',
    });
    const fetchImpl = createFakeFetch({
      [articleUrl]: { throws: abortErr },
    });
    const client = createFakeClient([]);
    const res = await handleSummaryRequest(makeRequest(articleUrl), {
      createClient: () => client,
      fetchImpl,
    });
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({
      error: "The article site didn't respond in time",
      reason: 'source_timeout',
    });
  });

  it('returns 502 when the model returns an empty string', async () => {
    const articleUrl = 'https://example.com/b';
    const fetchImpl = createFakeFetch({
      [articleUrl]: { body: '<article>body</article>' },
    });
    const client = createFakeClient([{ text: '   ' }]);
    const res = await handleSummaryRequest(makeRequest(articleUrl), {
      createClient: () => client,
      fetchImpl,
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'Summarization failed',
      reason: 'summarization_failed',
    });
  });

  it('returns 502 when the model throws', async () => {
    const articleUrl = 'https://example.com/c';
    const fetchImpl = createFakeFetch({
      [articleUrl]: { body: '<article>body</article>' },
    });
    const client = createFakeClient([new Error('boom')]);
    const res = await handleSummaryRequest(makeRequest(articleUrl), {
      createClient: () => client,
      fetchImpl,
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'Summarization failed',
      reason: 'summarization_failed',
    });
  });

  it('accepts jinaApiKey passed explicitly via deps', async () => {
    const articleUrl = 'https://example.com/via-deps';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: {
        body: 'Article text.',
        contentType: 'text/plain',
      },
    });
    const client = createFakeClient([{ text: 'Deps summary.' }]);
    const res = await handleSummaryRequest(makeRequest(articleUrl), {
      createClient: () => client,
      fetchImpl,
      jinaApiKey: 'deps-key',
    });
    expect(res.status).toBe(200);
    const jinaInit = fetchImpl.mock.calls[0]![1]!;
    const headers = (jinaInit.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe('Bearer deps-key');
  });

  it('serves a cached summary on a repeat request', async () => {
    const url = 'https://example.com/cached';
    const fetchImpl = createFakeFetch({
      [url]: { body: '<article>first</article>' },
    });
    const client = createFakeClient([{ text: 'first-summary' }]);
    const res1 = await handleSummaryRequest(makeRequest(url), {
      createClient: () => client,
      fetchImpl,
    });
    expect(await res1.json()).toEqual({ summary: 'first-summary' });

    const client2 = createFakeClient([{ text: 'would-be-second' }]);
    const res2 = await handleSummaryRequest(makeRequest(url), {
      createClient: () => client2,
      fetchImpl,
    });
    expect(await res2.json()).toEqual({
      summary: 'first-summary',
      cached: true,
    });
    expect(client2.models.generateContent).not.toHaveBeenCalled();
  });

  it('sets a shared-cache Cache-Control header on successful responses', async () => {
    const articleUrl = 'https://example.com/cc';
    const fetchImpl = createFakeFetch({
      [articleUrl]: { body: '<article>body</article>' },
    });
    const client = createFakeClient([{ text: 'ok' }]);
    const res = await handleSummaryRequest(makeRequest(articleUrl), {
      createClient: () => client,
      fetchImpl,
    });
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toMatch(/public/);
    expect(cc).toMatch(/s-maxage=3600/);
    expect(cc).toMatch(/stale-while-revalidate=86400/);
  });

  it('also sets the shared-cache header when serving from the in-memory cache', async () => {
    const articleUrl = 'https://example.com/cc-hit';
    const fetchImpl = createFakeFetch({
      [articleUrl]: { body: '<article>body</article>' },
    });
    const client = createFakeClient([{ text: 'first' }]);
    await handleSummaryRequest(makeRequest(articleUrl), {
      createClient: () => client,
      fetchImpl,
    });
    const res2 = await handleSummaryRequest(makeRequest(articleUrl), {
      createClient: () => createFakeClient([]),
      fetchImpl,
    });
    expect((await res2.json()) as { cached?: boolean }).toMatchObject({
      cached: true,
    });
    expect(res2.headers.get('cache-control') ?? '').toMatch(/s-maxage=3600/);
  });

  it('sets no-store on error responses so the edge cache does not pin them', async () => {
    const r403 = await handleSummaryRequest(
      makeRequest('https://example.com/a', { referer: null }),
    );
    expect(r403.headers.get('cache-control') ?? '').toMatch(/no-store/);

    const r400 = await handleSummaryRequest(makeRequest(null));
    expect(r400.headers.get('cache-control') ?? '').toMatch(/no-store/);
  });

  it('re-fetches after the cache ttl expires', async () => {
    const url = 'https://example.com/expire';
    let now = 1_000_000;
    const fetchImpl = createFakeFetch({
      [url]: { body: '<article>body</article>' },
    });
    const client = createFakeClient([{ text: 'v1' }]);
    await handleSummaryRequest(makeRequest(url), {
      createClient: () => client,
      fetchImpl,
      now: () => now,
    });

    now += 60 * 60 * 1000 + 1;
    const client2 = createFakeClient([{ text: 'v2' }]);
    const fetchImpl2 = createFakeFetch({
      [url]: { body: '<article>body</article>' },
    });
    const res2 = await handleSummaryRequest(makeRequest(url), {
      createClient: () => client2,
      fetchImpl: fetchImpl2,
      now: () => now,
    });
    expect(await res2.json()).toEqual({ summary: 'v2' });
    expect(client2.models.generateContent).toHaveBeenCalledTimes(1);
  });
});
