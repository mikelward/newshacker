import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  handleSummaryRequest,
  isAllowedReferer,
  __clearCacheForTests,
} from './summary';

const ALLOWED_REFERER = 'https://newshacker.app/item/1';

interface HNItemFixture {
  id?: number;
  type?: string;
  title?: string;
  url?: string;
  dead?: boolean;
  deleted?: boolean;
}

function makeRequest(
  storyId: number | null,
  opts: { referer?: string | null } = {},
) {
  const base = 'https://newshacker.app/api/summary';
  const full = storyId === null ? base : `${base}?id=${storyId}`;
  const headers = new Headers();
  const referer = opts.referer === undefined ? ALLOWED_REFERER : opts.referer;
  if (referer !== null) headers.set('referer', referer);
  return new Request(full, { headers });
}

function makeRawRequest(
  query: string | null,
  opts: { referer?: string | null } = {},
) {
  const base = 'https://newshacker.app/api/summary';
  const full = query === null ? base : `${base}?${query}`;
  const headers = new Headers();
  const referer = opts.referer === undefined ? ALLOWED_REFERER : opts.referer;
  if (referer !== null) headers.set('referer', referer);
  return new Request(full, { headers });
}

function fetchItemFor(items: Record<number, HNItemFixture | null>) {
  return vi.fn(async (id: number) => items[id] ?? null);
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
      makeRequest(1, { referer: null }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 for a disallowed Referer host', async () => {
    const res = await handleSummaryRequest(
      makeRequest(1, { referer: 'https://evil.com/' }),
    );
    expect(res.status).toBe(403);
  });

  it('accepts Referers from localhost and vercel.app previews', async () => {
    const fetchImpl = createFakeFetch({
      'https://example.com/a': { body: '<article>hi</article>' },
    });
    const fetchItem = fetchItemFor({
      1: { id: 1, type: 'story', url: 'https://example.com/a' },
    });
    const client = createFakeClient([{ text: 'ok' }]);
    const r1 = await handleSummaryRequest(
      makeRequest(1, { referer: 'http://localhost:5173/item/1' }),
      { createClient: () => client, fetchImpl, fetchItem },
    );
    expect(r1.status).toBe(200);

    __clearCacheForTests();
    const r2 = await handleSummaryRequest(
      makeRequest(1, {
        referer: 'https://newshacker-preview-abc.vercel.app/item/1',
      }),
      {
        createClient: () => createFakeClient([{ text: 'ok' }]),
        fetchImpl: createFakeFetch({
          'https://example.com/a': { body: '<article>hi</article>' },
        }),
        fetchItem,
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

  it('returns 400 when id is missing', async () => {
    const res = await handleSummaryRequest(makeRequest(null));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'Invalid id parameter' });
  });

  it('returns 400 for a non-numeric id', async () => {
    const res = await handleSummaryRequest(makeRawRequest('id=abc'));
    expect(res.status).toBe(400);
  });

  it('returns 400 for a negative or zero id', async () => {
    const r1 = await handleSummaryRequest(makeRawRequest('id=0'));
    expect(r1.status).toBe(400);
    const r2 = await handleSummaryRequest(makeRawRequest('id=-5'));
    expect(r2.status).toBe(400);
  });

  it('rejects the legacy ?url= parameter with 400', async () => {
    // Regression guard: anyone can spoof Referer, so we must not accept
    // a caller-supplied URL. Per-item-id lookup is the whole point.
    const res = await handleSummaryRequest(
      makeRawRequest('url=' + encodeURIComponent('https://example.com/a')),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when the story does not exist', async () => {
    const fetchItem = fetchItemFor({ 99: null });
    const res = await handleSummaryRequest(makeRequest(99), { fetchItem });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a deleted or dead story', async () => {
    const fetchItem = fetchItemFor({
      11: { id: 11, type: 'story', deleted: true },
      12: { id: 12, type: 'story', dead: true },
    });
    const r1 = await handleSummaryRequest(makeRequest(11), { fetchItem });
    expect(r1.status).toBe(404);
    const r2 = await handleSummaryRequest(makeRequest(12), { fetchItem });
    expect(r2.status).toBe(404);
  });

  it('returns 400 with no_article reason for a self-post', async () => {
    const fetchItem = fetchItemFor({
      33: { id: 33, type: 'story', title: 'Ask HN' },
    });
    const res = await handleSummaryRequest(makeRequest(33), { fetchItem });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Story has no article to summarize',
      reason: 'no_article',
    });
  });

  it('returns 502 with story_unreachable when the HN fetch throws', async () => {
    const fetchItem = vi.fn(async () => {
      throw new Error('boom');
    });
    const res = await handleSummaryRequest(makeRequest(44), { fetchItem });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'Could not load story',
      reason: 'story_unreachable',
    });
  });

  it('returns 503 when GOOGLE_API_KEY is unset', async () => {
    delete process.env.GOOGLE_API_KEY;
    const fetchItem = fetchItemFor({
      1: { id: 1, type: 'story', url: 'https://example.com/a' },
    });
    const res = await handleSummaryRequest(makeRequest(1), { fetchItem });
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
    const fetchItem = fetchItemFor({
      55: { id: 55, type: 'story', url: 'https://www.theverge.com/foo' },
    });
    const client = createFakeClient([{ text: 'A one-sentence summary.' }]);
    const res = await handleSummaryRequest(makeRequest(55), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
    });
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
    const fetchItem = fetchItemFor({
      66: { id: 66, type: 'story', url: articleUrl },
    });
    const client = createFakeClient([{ text: 'ok' }]);
    await handleSummaryRequest(makeRequest(66), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
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
    const fetchItem = fetchItemFor({
      77: { id: 77, type: 'story', url: articleUrl },
    });
    const client = createFakeClient([{ text: 'Raw-fetch summary.' }]);
    const res = await handleSummaryRequest(makeRequest(77), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
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
    const fetchItem = fetchItemFor({
      88: { id: 88, type: 'story', url: articleUrl },
    });
    const client = createFakeClient([{ text: 'Plain summary.' }]);
    const res = await handleSummaryRequest(makeRequest(88), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
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
    const fetchItem = fetchItemFor({
      111: { id: 111, type: 'story', url: articleUrl },
    });
    const client = createFakeClient([]);
    const res = await handleSummaryRequest(makeRequest(111), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
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
    const fetchItem = fetchItemFor({
      112: { id: 112, type: 'story', url: articleUrl },
    });
    const client = createFakeClient([]);
    const res = await handleSummaryRequest(makeRequest(112), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
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
    const fetchItem = fetchItemFor({
      113: { id: 113, type: 'story', url: articleUrl },
    });
    const client = createFakeClient([]);
    const res = await handleSummaryRequest(makeRequest(113), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
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
    const fetchItem = fetchItemFor({
      120: { id: 120, type: 'story', url: articleUrl },
    });
    const client = createFakeClient([{ text: '   ' }]);
    const res = await handleSummaryRequest(makeRequest(120), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
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
    const fetchItem = fetchItemFor({
      130: { id: 130, type: 'story', url: articleUrl },
    });
    const client = createFakeClient([new Error('boom')]);
    const res = await handleSummaryRequest(makeRequest(130), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
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
    const fetchItem = fetchItemFor({
      140: { id: 140, type: 'story', url: articleUrl },
    });
    const client = createFakeClient([{ text: 'Deps summary.' }]);
    const res = await handleSummaryRequest(makeRequest(140), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
      jinaApiKey: 'deps-key',
    });
    expect(res.status).toBe(200);
    const jinaInit = fetchImpl.mock.calls[0]![1]!;
    const headers = (jinaInit.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe('Bearer deps-key');
  });

  it('serves a cached summary on a repeat request', async () => {
    const articleUrl = 'https://example.com/cached';
    const fetchImpl = createFakeFetch({
      [articleUrl]: { body: '<article>first</article>' },
    });
    const fetchItem = fetchItemFor({
      150: { id: 150, type: 'story', url: articleUrl },
    });
    const client = createFakeClient([{ text: 'first-summary' }]);
    const res1 = await handleSummaryRequest(makeRequest(150), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
    });
    expect(await res1.json()).toEqual({ summary: 'first-summary' });

    const client2 = createFakeClient([{ text: 'would-be-second' }]);
    const res2 = await handleSummaryRequest(makeRequest(150), {
      createClient: () => client2,
      fetchImpl,
      fetchItem,
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
    const fetchItem = fetchItemFor({
      160: { id: 160, type: 'story', url: articleUrl },
    });
    const client = createFakeClient([{ text: 'ok' }]);
    const res = await handleSummaryRequest(makeRequest(160), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
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
    const fetchItem = fetchItemFor({
      170: { id: 170, type: 'story', url: articleUrl },
    });
    const client = createFakeClient([{ text: 'first' }]);
    await handleSummaryRequest(makeRequest(170), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
    });
    const res2 = await handleSummaryRequest(makeRequest(170), {
      createClient: () => createFakeClient([]),
      fetchImpl,
      fetchItem,
    });
    expect((await res2.json()) as { cached?: boolean }).toMatchObject({
      cached: true,
    });
    expect(res2.headers.get('cache-control') ?? '').toMatch(/s-maxage=3600/);
  });

  it('sets no-store on error responses so the edge cache does not pin them', async () => {
    const r403 = await handleSummaryRequest(
      makeRequest(1, { referer: null }),
    );
    expect(r403.headers.get('cache-control') ?? '').toMatch(/no-store/);

    const r400 = await handleSummaryRequest(makeRequest(null));
    expect(r400.headers.get('cache-control') ?? '').toMatch(/no-store/);
  });

  it('re-fetches after the cache ttl expires', async () => {
    const articleUrl = 'https://example.com/expire';
    let now = 1_000_000;
    const fetchImpl = createFakeFetch({
      [articleUrl]: { body: '<article>body</article>' },
    });
    const fetchItem = fetchItemFor({
      180: { id: 180, type: 'story', url: articleUrl },
    });
    const client = createFakeClient([{ text: 'v1' }]);
    await handleSummaryRequest(makeRequest(180), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
      now: () => now,
    });

    now += 60 * 60 * 1000 + 1;
    const client2 = createFakeClient([{ text: 'v2' }]);
    const fetchImpl2 = createFakeFetch({
      [articleUrl]: { body: '<article>body</article>' },
    });
    const res2 = await handleSummaryRequest(makeRequest(180), {
      createClient: () => client2,
      fetchImpl: fetchImpl2,
      fetchItem,
      now: () => now,
    });
    expect(await res2.json()).toEqual({ summary: 'v2' });
    expect(client2.models.generateContent).toHaveBeenCalledTimes(1);
  });
});
