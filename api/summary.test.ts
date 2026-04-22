// @vitest-environment node
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  handleSummaryRequest,
  hashArticle,
  isAllowedReferer,
  isCaptchaRefusal,
  parseRecord,
  type SummaryRecord,
  type SummaryStore,
} from './summary';

const ALLOWED_REFERER = 'https://newshacker.app/item/1';

interface HNItemFixture {
  id?: number;
  type?: string;
  title?: string;
  url?: string;
  text?: string;
  score?: number;
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

// In-memory SummaryStore used in tests in place of a real Upstash client.
// Honors TTL via an injectable `now` so expiration tests still work.
function createTestStore(now: () => number = Date.now): SummaryStore & {
  map: Map<number, { record: SummaryRecord; expiresAt: number }>;
} {
  const map = new Map<number, { record: SummaryRecord; expiresAt: number }>();
  return {
    map,
    async get(storyId) {
      const entry = map.get(storyId);
      if (!entry) return null;
      if (now() >= entry.expiresAt) {
        map.delete(storyId);
        return null;
      }
      return entry.record;
    },
    async set(storyId, record, ttlSeconds) {
      map.set(storyId, {
        record,
        expiresAt: now() + ttlSeconds * 1000,
      });
    },
  };
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

// Mirrors api/warm-summaries.test.ts: wraps markdown content in Jina
// Reader's JSON envelope so the mock matches what the production fetch
// path now expects (accept: application/json).
function jinaBody(content: string, tokens = 123): string {
  return JSON.stringify({
    code: 200,
    status: 20000,
    data: { content, usage: { tokens } },
  });
}

describe('handleSummaryRequest', () => {
  const origGoogle = process.env.GOOGLE_API_KEY;
  const origJina = process.env.JINA_API_KEY;

  beforeEach(() => {
    process.env.GOOGLE_API_KEY = 'test-key';
    // Jina is a hard dependency after the raw-HTML fallback was
    // removed (TODO.md § "Article-fetch fallback"). Tests that assert
    // the not_configured branch delete this locally.
    process.env.JINA_API_KEY = 'test-jina-key';
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
      'https://r.jina.ai/https://example.com/a': { body: jinaBody('hi') },
    });
    const fetchItem = fetchItemFor({
      1: { id: 1, type: 'story', url: 'https://example.com/a', score: 10 },
    });
    const client = createFakeClient([{ text: 'ok' }]);
    const r1 = await handleSummaryRequest(
      makeRequest(1, { referer: 'http://localhost:5173/item/1' }),
      {
        createClient: () => client,
        fetchImpl,
        fetchItem,
        store: createTestStore(),
      },
    );
    expect(r1.status).toBe(200);

    const r2 = await handleSummaryRequest(
      makeRequest(1, {
        referer: 'https://newshacker-preview-abc.vercel.app/item/1',
      }),
      {
        createClient: () => createFakeClient([{ text: 'ok' }]),
        fetchImpl: createFakeFetch({
          'https://r.jina.ai/https://example.com/a': { body: jinaBody('hi') },
        }),
        fetchItem,
        store: createTestStore(),
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
    const res = await handleSummaryRequest(makeRequest(99), {
      fetchItem,
      store: null,
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a deleted or dead story', async () => {
    const fetchItem = fetchItemFor({
      11: { id: 11, type: 'story', deleted: true },
      12: { id: 12, type: 'story', dead: true },
    });
    const r1 = await handleSummaryRequest(makeRequest(11), {
      fetchItem,
      store: null,
    });
    expect(r1.status).toBe(404);
    const r2 = await handleSummaryRequest(makeRequest(12), {
      fetchItem,
      store: null,
    });
    expect(r2.status).toBe(404);
  });

  it('returns 400 with low_score for a story that has not earned an organic upvote', async () => {
    // `> 1` means "at least one vote beyond the submitter's implicit
    // self-upvote". Score 0 (flagged-to-oblivion), missing score
    // (API anomaly), and score 1 (fresh self-submit) all fail the floor.
    const fetchItem = fetchItemFor({
      21: {
        id: 21,
        type: 'story',
        url: 'https://example.com/zero',
        score: 0,
      },
      22: { id: 22, type: 'story', url: 'https://example.com/missing' },
      23: { id: 23, type: 'story', url: 'https://example.com/one', score: 1 },
    });
    for (const id of [21, 22, 23]) {
      const res = await handleSummaryRequest(makeRequest(id), {
        fetchItem,
        store: null,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Story is not eligible for summary',
        reason: 'low_score',
      });
    }
  });

  it('returns 400 with no_article when the story has neither url nor text', async () => {
    // e.g. a job post stub with nothing but a title. Previously all
    // self-posts hit this branch; now only truly empty ones do.
    const fetchItem = fetchItemFor({
      33: { id: 33, type: 'story', title: 'Empty', score: 10 },
    });
    const res = await handleSummaryRequest(makeRequest(33), {
      fetchItem,
      store: null,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Story has no article to summarize',
      reason: 'no_article',
    });
  });

  it('summarizes a self-post body when the story has no url but has text', async () => {
    // Real-world example: https://news.ycombinator.com/item?id=47825673
    // (Ask-HN-style body comparing Opus 4.7 vs 4.6). No URL, substantive
    // text. Previously returned no_article; now routed through Gemini
    // without touching Jina.
    const fetchItem = fetchItemFor({
      34: {
        id: 34,
        type: 'story',
        title: 'Ask HN: Opus 4.7 vs. 4.6 after 3 days',
        // The body uses HN's constrained HTML subset — the handler must
        // strip it before prompting Gemini.
        text: '<p>I spent some time today comparing Opus 4.6 and 4.7 using my own usage data to see how they actually behave side by side.</p><p>4.7 also uses fewer tools per turn than 4.6.</p>',
        score: 10,
      },
    });
    const client = createFakeClient([
      { text: "4.7 trades slightly fewer errors for meaningfully fewer tools per turn." },
    ]);
    // Jina must NOT be called for self-posts — the body is in-hand.
    const fetchImpl = vi.fn(async () => {
      throw new Error('Jina should not be called for self-posts');
    });
    const res = await handleSummaryRequest(makeRequest(34), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
      store: null,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      summary:
        '4.7 trades slightly fewer errors for meaningfully fewer tools per turn.',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.models.generateContent).toHaveBeenCalledTimes(1);
    const prompt = client.models.generateContent.mock.calls[0]![0].contents;
    // The HTML tags must be stripped from what Gemini sees.
    expect(prompt).not.toContain('<p>');
    expect(prompt).toContain('behave side by side');
    // Self-post prompts include the title and acknowledge the no-article shape.
    expect(prompt).toContain('Ask HN: Opus 4.7 vs. 4.6');
    expect(prompt).toContain('no external article');
  });

  it('summarizes a self-post even when JINA_API_KEY is unset', async () => {
    // Self-posts don't touch Jina, so the missing-jina-key check that
    // gates the article path must not reject them.
    delete process.env.JINA_API_KEY;
    const fetchItem = fetchItemFor({
      35: {
        id: 35,
        type: 'story',
        title: 'Ask HN: no jina needed',
        text: '<p>Body text of the post.</p>',
        score: 10,
      },
    });
    const client = createFakeClient([{ text: 'A summary.' }]);
    const res = await handleSummaryRequest(makeRequest(35), {
      createClient: () => client,
      fetchItem,
      store: null,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ summary: 'A summary.' });
  });

  it('returns 400 no_article when a self-post has only whitespace in text', async () => {
    // After HTML strip + trim, a body of `<p> </p>` is effectively empty
    // and has nothing to summarize.
    const fetchItem = fetchItemFor({
      36: {
        id: 36,
        type: 'story',
        title: 'Empty body',
        text: '<p>   </p>',
        score: 10,
      },
    });
    const res = await handleSummaryRequest(makeRequest(36), {
      fetchItem,
      store: null,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('no_article');
  });

  it('returns 502 with story_unreachable when the HN fetch throws', async () => {
    const fetchItem = vi.fn(async () => {
      throw new Error('boom');
    });
    const res = await handleSummaryRequest(makeRequest(44), {
      fetchItem,
      store: null,
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'Could not load story',
      reason: 'story_unreachable',
    });
  });

  it('returns 503 when GOOGLE_API_KEY is unset', async () => {
    delete process.env.GOOGLE_API_KEY;
    const fetchItem = fetchItemFor({
      1: { id: 1, type: 'story', url: 'https://example.com/a', score: 10 },
    });
    const res = await handleSummaryRequest(makeRequest(1), {
      fetchItem,
      store: null,
    });
    expect(res.status).toBe(503);
  });

  it('returns 503 not_configured when JINA_API_KEY is unset', async () => {
    // Raw-HTML fallback is gone — without a Jina key there is no
    // source-of-content path at all. The deploy surface must notice.
    delete process.env.JINA_API_KEY;
    const fetchItem = fetchItemFor({
      201: {
        id: 201,
        type: 'story',
        url: 'https://example.com/a',
        score: 10,
      },
    });
    const res = await handleSummaryRequest(makeRequest(201), {
      fetchItem,
      store: null,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'Summary is not configured',
      reason: 'not_configured',
    });
  });

  it('fetches via Jina when JINA_API_KEY is set and summarizes the result', async () => {
    process.env.JINA_API_KEY = 'jina-test-key';
    const fetchImpl = createFakeFetch({
      'https://r.jina.ai/https://www.theverge.com/foo': {
        body: jinaBody('# Article\n\nMain body text.'),
        contentType: 'application/json; charset=utf-8',
      },
    });
    const fetchItem = fetchItemFor({
      55: {
        id: 55,
        type: 'story',
        url: 'https://www.theverge.com/foo',
        score: 10,
      },
    });
    const client = createFakeClient([{ text: 'A one-sentence summary.' }]);
    const res = await handleSummaryRequest(makeRequest(55), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
      store: null,
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
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody('body') },
    });
    const fetchItem = fetchItemFor({
      66: { id: 66, type: 'story', url: articleUrl, score: 10 },
    });
    const client = createFakeClient([{ text: 'ok' }]);
    await handleSummaryRequest(makeRequest(66), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
      store: null,
    });
    const prompt = client.models.generateContent.mock.calls[0]![0].contents;
    expect(prompt).toMatch(/voice of the author/i);
    expect(prompt).toMatch(/The article argues/);
  });

  it('returns 502 with source_unreachable when Jina fails', async () => {
    const articleUrl = 'https://paywalled.example.com/story';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { status: 500 },
    });
    const fetchItem = fetchItemFor({
      111: { id: 111, type: 'story', url: articleUrl, score: 10 },
    });
    const client = createFakeClient([]);
    const res = await handleSummaryRequest(makeRequest(111), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
      store: null,
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'Could not access the article',
      reason: 'source_unreachable',
    });
    expect(client.models.generateContent).not.toHaveBeenCalled();
  });

  it('returns 503 with summary_budget_exhausted when Jina returns 402 Payment Required', async () => {
    // Regression guard: Jina's paid quota ran out (402) used to fall
    // into the generic source_unreachable branch, which told users the
    // article itself was down. Surface the real cause with a distinct
    // reason so the client can render "temporarily unavailable".
    const articleUrl = 'https://example.com/pay';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: {
        status: 402,
        body: 'Payment Required',
      },
    });
    const fetchItem = fetchItemFor({
      113: { id: 113, type: 'story', url: articleUrl, score: 10 },
    });
    const client = createFakeClient([]);
    const res = await handleSummaryRequest(makeRequest(113), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
      store: null,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'Summaries are temporarily unavailable',
      reason: 'summary_budget_exhausted',
    });
    expect(client.models.generateContent).not.toHaveBeenCalled();
  });

  it('returns 503 with summary_budget_exhausted when Jina returns 429 Too Many Requests', async () => {
    // 429 is the rate-limit / quota twin of 402 — treat identically so
    // an operator sees a single clear signal in the logs.
    const articleUrl = 'https://example.com/rate';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: {
        status: 429,
        body: 'Too Many Requests',
      },
    });
    const fetchItem = fetchItemFor({
      114: { id: 114, type: 'story', url: articleUrl, score: 10 },
    });
    const client = createFakeClient([]);
    const res = await handleSummaryRequest(makeRequest(114), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
      store: null,
    });
    expect(res.status).toBe(503);
    expect((await res.json()).reason).toBe('summary_budget_exhausted');
    expect(client.models.generateContent).not.toHaveBeenCalled();
  });

  it('returns 504 with source_timeout when Jina aborts', async () => {
    const articleUrl = 'https://slow.example.com/story';
    const abortErr = Object.assign(new Error('aborted'), {
      name: 'AbortError',
    });
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { throws: abortErr },
    });
    const fetchItem = fetchItemFor({
      112: { id: 112, type: 'story', url: articleUrl, score: 10 },
    });
    const client = createFakeClient([]);
    const res = await handleSummaryRequest(makeRequest(112), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
      store: null,
    });
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({
      error: "The article site didn't respond in time",
      reason: 'source_timeout',
    });
    expect(client.models.generateContent).not.toHaveBeenCalled();
  });

  it('returns 502 when the model returns an empty string', async () => {
    const articleUrl = 'https://example.com/b';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody('body') },
    });
    const fetchItem = fetchItemFor({
      120: { id: 120, type: 'story', url: articleUrl, score: 10 },
    });
    const client = createFakeClient([{ text: '   ' }]);
    const res = await handleSummaryRequest(makeRequest(120), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
      store: null,
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'Summarization failed',
      reason: 'summarization_failed',
    });
  });

  it('returns 502 with source_captcha when the model refuses due to a CAPTCHA page', async () => {
    const articleUrl = 'https://example.com/captcha';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody('challenge') },
    });
    const fetchItem = fetchItemFor({
      125: { id: 125, type: 'story', url: articleUrl, score: 10 },
    });
    const client = createFakeClient([
      {
        text: 'I cannot summarize the article because the provided content is a CAPTCHA page and does not contain any substantive information about cheap batteries taking over power grids.',
      },
    ]);
    const store = createTestStore();
    const res = await handleSummaryRequest(makeRequest(125), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
      store,
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'Could not generate a summary due to a CAPTCHA page',
      reason: 'source_captcha',
    });
    // A refusal must not be persisted as if it were a real summary.
    expect(store.map.size).toBe(0);
  });

  it('returns 502 when the model throws', async () => {
    const articleUrl = 'https://example.com/c';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody('body') },
    });
    const fetchItem = fetchItemFor({
      130: { id: 130, type: 'story', url: articleUrl, score: 10 },
    });
    const client = createFakeClient([new Error('boom')]);
    const res = await handleSummaryRequest(makeRequest(130), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
      store: null,
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
        body: jinaBody('Article text.'),
        contentType: 'application/json',
      },
    });
    const fetchItem = fetchItemFor({
      140: { id: 140, type: 'story', url: articleUrl, score: 10 },
    });
    const client = createFakeClient([{ text: 'Deps summary.' }]);
    const res = await handleSummaryRequest(makeRequest(140), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
      jinaApiKey: 'deps-key',
      store: null,
    });
    expect(res.status).toBe(200);
    const jinaInit = fetchImpl.mock.calls[0]![1]!;
    const headers = (jinaInit.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe('Bearer deps-key');
  });

  it('serves a cached summary on a repeat request via the shared store', async () => {
    const articleUrl = 'https://example.com/cached';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody('first') },
    });
    const fetchItem = fetchItemFor({
      150: { id: 150, type: 'story', url: articleUrl, score: 10 },
    });
    const store = createTestStore();
    const client = createFakeClient([{ text: 'first-summary' }]);
    const res1 = await handleSummaryRequest(makeRequest(150), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
      store,
    });
    expect(await res1.json()).toEqual({ summary: 'first-summary' });

    const client2 = createFakeClient([{ text: 'would-be-second' }]);
    const res2 = await handleSummaryRequest(makeRequest(150), {
      createClient: () => client2,
      fetchImpl,
      fetchItem,
      store,
    });
    expect(await res2.json()).toEqual({
      summary: 'first-summary',
      cached: true,
    });
    expect(client2.models.generateContent).not.toHaveBeenCalled();
  });

  it('writes a full record to the shared store with a 30d TTL', async () => {
    const articleUrl = 'https://example.com/ttl-set';
    const articleBody = 'body';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(articleBody) },
    });
    const fetchItem = fetchItemFor({
      155: { id: 155, type: 'story', url: articleUrl, score: 10 },
    });
    const get = vi.fn<SummaryStore['get']>(async () => null);
    const set = vi.fn<SummaryStore['set']>(async () => undefined);
    const now = 1_700_000_000_000;
    await handleSummaryRequest(makeRequest(155), {
      createClient: () => createFakeClient([{ text: 'ok' }]),
      fetchImpl,
      fetchItem,
      store: { get, set },
      now: () => now,
    });
    expect(set).toHaveBeenCalledTimes(1);
    const [id, record, ttlSeconds] = set.mock.calls[0]!;
    expect(id).toBe(155);
    expect(record.summary).toBe('ok');
    // Hash is the SHA-256 of the article content the handler saw.
    expect(record.articleHash).toBe(hashArticle(articleBody));
    // On a cache miss we treat "now" as both first-seen and last-changed —
    // there's no prior state to diff against.
    expect(record.firstSeenAt).toBe(now);
    expect(record.summaryGeneratedAt).toBe(now);
    expect(record.lastCheckedAt).toBe(now);
    expect(record.lastChangedAt).toBe(now);
    // 30d TTL — the cron owns freshness inside that window.
    expect(ttlSeconds).toBe(60 * 60 * 24 * 30);
  });

  it('sets no-store Cache-Control on successful responses', async () => {
    const articleUrl = 'https://example.com/cc';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody('body') },
    });
    const fetchItem = fetchItemFor({
      160: { id: 160, type: 'story', url: articleUrl, score: 10 },
    });
    const client = createFakeClient([{ text: 'ok' }]);
    const res = await handleSummaryRequest(makeRequest(160), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
      store: null,
    });
    // Edge CDN is explicitly not the shared cache — the function must
    // always run so KV can be consulted.
    expect(res.headers.get('cache-control') ?? '').toMatch(/no-store/);
  });

  it('sets no-store on error responses', async () => {
    const r403 = await handleSummaryRequest(
      makeRequest(1, { referer: null }),
    );
    expect(r403.headers.get('cache-control') ?? '').toMatch(/no-store/);

    const r400 = await handleSummaryRequest(makeRequest(null));
    expect(r400.headers.get('cache-control') ?? '').toMatch(/no-store/);
  });

  it('re-fetches after the shared-store ttl expires', async () => {
    // 30d TTL under the cron-owned freshness model: the user-facing
    // read path returns whatever is in the cache, and only regenerates
    // on a real cache miss (record absent or Upstash evicted).
    const articleUrl = 'https://example.com/expire';
    let now = 1_000_000;
    const store = createTestStore(() => now);
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody('body') },
    });
    const fetchItem = fetchItemFor({
      180: { id: 180, type: 'story', url: articleUrl, score: 10 },
    });
    const client = createFakeClient([{ text: 'v1' }]);
    await handleSummaryRequest(makeRequest(180), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
      store,
      now: () => now,
    });

    now += 60 * 60 * 24 * 30 * 1000 + 1;
    const client2 = createFakeClient([{ text: 'v2' }]);
    const fetchImpl2 = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody('body') },
    });
    const res2 = await handleSummaryRequest(makeRequest(180), {
      createClient: () => client2,
      fetchImpl: fetchImpl2,
      fetchItem,
      store,
      now: () => now,
    });
    expect(await res2.json()).toEqual({ summary: 'v2' });
    expect(client2.models.generateContent).toHaveBeenCalledTimes(1);
  });

  it('returns the cached record untouched on any hit within the 30d TTL', async () => {
    // Regression guard for the new "cron owns freshness" model: the
    // user-facing path must not regenerate just because the old 1h
    // summary TTL has passed. Only a real eviction triggers work.
    const articleUrl = 'https://example.com/still-cached';
    let now = 1_000_000;
    const store = createTestStore(() => now);
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody('body') },
    });
    const fetchItem = fetchItemFor({
      181: { id: 181, type: 'story', url: articleUrl, score: 10 },
    });
    const client = createFakeClient([{ text: 'v1' }]);
    await handleSummaryRequest(makeRequest(181), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
      store,
      now: () => now,
    });

    // 24h later — well past the old 1h TTL, well inside the new 30d one.
    now += 24 * 60 * 60 * 1000;
    const client2 = createFakeClient([]);
    const res2 = await handleSummaryRequest(makeRequest(181), {
      createClient: () => client2,
      fetchImpl,
      fetchItem,
      store,
      now: () => now,
    });
    expect(await res2.json()).toEqual({ summary: 'v1', cached: true });
    expect(client2.models.generateContent).not.toHaveBeenCalled();
  });

  it('parseRecord rejects legacy string entries and malformed objects', () => {
    // Pre-schema entries were plain strings; we treat them as absent so
    // the next hit writes a fresh record, which silently migrates them.
    expect(parseRecord('old-string-summary')).toBeNull();
    expect(parseRecord(null)).toBeNull();
    expect(parseRecord(undefined)).toBeNull();
    expect(parseRecord({})).toBeNull();
    expect(
      parseRecord({ summary: 'ok', articleHash: 'x' }),
    ).toBeNull();

    const good: SummaryRecord = {
      summary: 'ok',
      articleHash: 'x',
      firstSeenAt: 1,
      summaryGeneratedAt: 1,
      lastCheckedAt: 1,
      lastChangedAt: 1,
    };
    expect(parseRecord(good)).toEqual(good);
    // Strings round-trip through JSON.
    expect(parseRecord(JSON.stringify(good))).toEqual(good);
  });

  it('falls through to live generation when the shared store throws (fail-open)', async () => {
    // Defense-in-depth: even if a store implementation forgets to catch
    // its own errors, KV trouble must not break the endpoint. The
    // default Upstash store catches internally; this guards the
    // handler's belt-and-braces try/catch.
    const articleUrl = 'https://example.com/kv-down';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody('body') },
    });
    const fetchItem = fetchItemFor({
      190: { id: 190, type: 'story', url: articleUrl, score: 10 },
    });
    const store: SummaryStore = {
      get: vi.fn(async () => {
        throw new Error('kv get failed');
      }),
      set: vi.fn(async () => {
        throw new Error('kv set failed');
      }),
    };
    const res = await handleSummaryRequest(makeRequest(190), {
      createClient: () => createFakeClient([{ text: 'live' }]),
      fetchImpl,
      fetchItem,
      store,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ summary: 'live' });
    expect(store.get).toHaveBeenCalledTimes(1);
    // The handler still attempted to write — which also threw — but the
    // response is sent regardless.
    expect(store.set).toHaveBeenCalledTimes(1);
  });
});

describe('isCaptchaRefusal', () => {
  it('matches the canonical Gemini refusal for CAPTCHA pages', () => {
    expect(
      isCaptchaRefusal(
        'I cannot summarize the article because the provided content is a CAPTCHA page and does not contain any substantive information.',
      ),
    ).toBe(true);
  });

  it('matches contraction and alternate opener variants', () => {
    expect(
      isCaptchaRefusal("I can't summarize this — the page is a CAPTCHA check."),
    ).toBe(true);
    expect(
      isCaptchaRefusal(
        "I'm unable to summarize the article; the content is a CAPTCHA.",
      ),
    ).toBe(true);
    expect(
      isCaptchaRefusal('Unable to summarize: the fetched page is a CAPTCHA.'),
    ).toBe(true);
  });

  it('does not match a real summary that happens to mention CAPTCHA', () => {
    expect(
      isCaptchaRefusal(
        'CAPTCHA systems are a losing arms race against increasingly capable bots.',
      ),
    ).toBe(false);
  });

  it('does not match a refusal that is not about a CAPTCHA', () => {
    expect(
      isCaptchaRefusal(
        'I cannot summarize the article because the content is behind a paywall.',
      ),
    ).toBe(false);
  });
});
