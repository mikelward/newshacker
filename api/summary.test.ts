// @vitest-environment node
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  checkRateLimit,
  detectPaywall,
  extractClientIp,
  handleSummaryRequest,
  hashArticle,
  isAllowedReferer,
  isCaptchaRefusal,
  normalizeIpForRateLimit,
  parseRecord,
  type RateLimitStore,
  type RateLimitTier,
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
  opts: {
    referer?: string | null;
    forwardedFor?: string;
    realIp?: string;
  } = {},
) {
  const base = 'https://newshacker.app/api/summary';
  const full = storyId === null ? base : `${base}?id=${storyId}`;
  const headers = new Headers();
  const referer = opts.referer === undefined ? ALLOWED_REFERER : opts.referer;
  if (referer !== null) headers.set('referer', referer);
  if (opts.forwardedFor) headers.set('x-forwarded-for', opts.forwardedFor);
  if (opts.realIp) headers.set('x-real-ip', opts.realIp);
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

// Shared in-memory RateLimitStore used across tests. The `calls` array
// records every increment so a shared-bucket test can assert that the
// same key is touched by both summary handlers.
export function createTestRateLimitStore(): RateLimitStore & {
  counts: Map<string, number>;
  calls: string[];
  // Force the next N increments to throw — exercises the fail-open path.
  throwNext: (n: number) => void;
} {
  const counts = new Map<string, number>();
  const calls: string[] = [];
  let throwRemaining = 0;
  return {
    counts,
    calls,
    throwNext(n: number) {
      throwRemaining = n;
    },
    async incrementWithExpiry(key: string) {
      calls.push(key);
      if (throwRemaining > 0) {
        throwRemaining -= 1;
        throw new Error('rate-limit store unavailable');
      }
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
  };
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

describe('rate limiting (helpers)', () => {
  it('extracts the leftmost IP from x-forwarded-for', () => {
    const h = new Headers();
    h.set('x-forwarded-for', '203.0.113.7, 10.0.0.1, 10.0.0.2');
    expect(extractClientIp(h)).toBe('203.0.113.7');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    const h = new Headers();
    h.set('x-real-ip', '198.51.100.42');
    expect(extractClientIp(h)).toBe('198.51.100.42');
  });

  it('returns null when neither header is present', () => {
    expect(extractClientIp(new Headers())).toBeNull();
  });

  it('leaves IPv4 addresses unchanged', () => {
    expect(normalizeIpForRateLimit('203.0.113.7')).toBe('203.0.113.7');
  });

  it('reduces a full IPv6 address to its /64 prefix', () => {
    // Two addresses in the same /64 hash to the same key.
    const a = normalizeIpForRateLimit(
      '2001:0db8:abcd:0012:0000:0000:0000:0001',
    );
    const b = normalizeIpForRateLimit(
      '2001:0db8:abcd:0012:ffff:ffff:ffff:ffff',
    );
    expect(a).toBe(b);
    expect(a).toBe('2001:0db8:abcd:0012');
  });

  it('expands :: shorthand before taking the /64', () => {
    // `::` at the start, end, and middle — all should normalize by
    // zero-filling then slicing first 4 groups.
    expect(normalizeIpForRateLimit('2001:db8::1')).toBe('2001:db8:0:0');
    expect(normalizeIpForRateLimit('::1')).toBe('0:0:0:0');
    expect(normalizeIpForRateLimit('fe80::abcd:1234')).toBe('fe80:0:0:0');
  });

  it('strips IPv6 zone identifiers before normalizing', () => {
    // `fe80::1%eth0` and `fe80::1%wlan0` should hash to the same /64.
    expect(normalizeIpForRateLimit('fe80::1%eth0')).toBe(
      normalizeIpForRateLimit('fe80::1%wlan0'),
    );
  });

  it('admits requests under the limit and 429s at the first increment that exceeds', async () => {
    const store = createTestRateLimitStore();
    const tiers: RateLimitTier[] = [
      { name: 'burst', limit: 2, windowSeconds: 600 },
    ];
    const nowMs = 1_700_000_000_000;
    const r1 = await checkRateLimit(store, '1.2.3.4', tiers, nowMs);
    const r2 = await checkRateLimit(store, '1.2.3.4', tiers, nowMs);
    const r3 = await checkRateLimit(store, '1.2.3.4', tiers, nowMs);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(false);
    expect(r3.exceededTier).toBe('burst');
    expect(r3.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('reports the first-exceeded tier when multiple tiers are in play', async () => {
    const store = createTestRateLimitStore();
    const tiers: RateLimitTier[] = [
      { name: 'burst', limit: 5, windowSeconds: 600 },
      { name: 'daily', limit: 2, windowSeconds: 86_400 },
    ];
    const nowMs = 1_700_000_000_000;
    await checkRateLimit(store, '1.2.3.4', tiers, nowMs);
    await checkRateLimit(store, '1.2.3.4', tiers, nowMs);
    const over = await checkRateLimit(store, '1.2.3.4', tiers, nowMs);
    expect(over.ok).toBe(false);
    expect(over.exceededTier).toBe('daily');
  });

  it('fails open if the store throws on this tier (never blocks)', async () => {
    const store = createTestRateLimitStore();
    const tiers: RateLimitTier[] = [
      { name: 'burst', limit: 1, windowSeconds: 600 },
    ];
    const nowMs = 1_700_000_000_000;
    store.throwNext(10);
    // Even at 10× the limit, a throwing store yields `ok: true` — we
    // never block a request when the limiter itself is broken.
    for (let i = 0; i < 10; i += 1) {
      const r = await checkRateLimit(store, '1.2.3.4', tiers, nowMs);
      expect(r.ok).toBe(true);
    }
  });
});

describe('handleSummaryRequest — rate limiting', () => {
  const origGoogle = process.env.GOOGLE_API_KEY;
  const origJina = process.env.JINA_API_KEY;

  beforeEach(() => {
    process.env.GOOGLE_API_KEY = 'test-key';
    process.env.JINA_API_KEY = 'test-jina-key';
  });
  afterEach(() => {
    if (origGoogle === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = origGoogle;
    if (origJina === undefined) delete process.env.JINA_API_KEY;
    else process.env.JINA_API_KEY = origJina;
  });

  function buildSuccessDeps(
    rateLimitStore: RateLimitStore | null,
    tiers: RateLimitTier[],
  ) {
    return {
      createClient: () => createFakeClient([{ text: 'summary' }]),
      fetchImpl: createFakeFetch({
        'https://r.jina.ai/https://example.com/a': { body: jinaBody('body') },
      }),
      fetchItem: fetchItemFor({
        1: { id: 1, type: 'story', url: 'https://example.com/a', score: 10 },
      }),
      store: createTestStore(),
      rateLimitStore,
      rateLimitTiers: tiers,
    };
  }

  it('returns 429 with retry-after after the burst limit is exceeded', async () => {
    const rateLimitStore = createTestRateLimitStore();
    const tiers: RateLimitTier[] = [
      { name: 'burst', limit: 2, windowSeconds: 600 },
    ];

    const r1 = await handleSummaryRequest(
      makeRequest(1, { forwardedFor: '203.0.113.7' }),
      buildSuccessDeps(rateLimitStore, tiers),
    );
    const r2 = await handleSummaryRequest(
      makeRequest(1, { forwardedFor: '203.0.113.7' }),
      buildSuccessDeps(rateLimitStore, tiers),
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const blocked = await handleSummaryRequest(
      makeRequest(1, { forwardedFor: '203.0.113.7' }),
      buildSuccessDeps(rateLimitStore, tiers),
    );
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body.reason).toBe('rate_limited');
    expect(typeof body.retryAfterSeconds).toBe('number');
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.headers.get('retry-after')).toBe(
      String(body.retryAfterSeconds),
    );
  });

  it('cache hits bypass the rate-limit bucket entirely', async () => {
    // Preload the cache with a record for story 1 so the handler never
    // reaches the rate-limit check.
    const store = createTestStore();
    const now = 1_700_000_000_000;
    await store.set(
      1,
      {
        summary: 'cached summary',
        articleHash: hashArticle('body'),
        firstSeenAt: now,
        summaryGeneratedAt: now,
        lastCheckedAt: now,
        lastChangedAt: now,
      },
      60,
    );
    const rateLimitStore = createTestRateLimitStore();
    const tiers: RateLimitTier[] = [
      // Limit of 0 would block a live call, but the cache hit must not
      // touch the bucket.
      { name: 'burst', limit: 1, windowSeconds: 600 },
    ];

    for (let i = 0; i < 5; i += 1) {
      const res = await handleSummaryRequest(
        makeRequest(1, { forwardedFor: '203.0.113.7' }),
        {
          store,
          rateLimitStore,
          rateLimitTiers: tiers,
        },
      );
      expect(res.status).toBe(200);
    }
    expect(rateLimitStore.calls.length).toBe(0);
  });

  it('fails open when the rate-limit store throws', async () => {
    const rateLimitStore = createTestRateLimitStore();
    rateLimitStore.throwNext(100);
    const tiers: RateLimitTier[] = [
      { name: 'burst', limit: 1, windowSeconds: 600 },
    ];
    // Two back-to-back cache-miss requests — both succeed because the
    // store throws on every increment and the handler fails open.
    const r1 = await handleSummaryRequest(
      makeRequest(1, { forwardedFor: '203.0.113.7' }),
      buildSuccessDeps(rateLimitStore, tiers),
    );
    const r2 = await handleSummaryRequest(
      makeRequest(1, { forwardedFor: '203.0.113.7' }),
      buildSuccessDeps(rateLimitStore, tiers),
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  it('buckets two IPv6 addresses in the same /64 together', async () => {
    const rateLimitStore = createTestRateLimitStore();
    const tiers: RateLimitTier[] = [
      { name: 'burst', limit: 1, windowSeconds: 600 },
    ];
    const r1 = await handleSummaryRequest(
      makeRequest(1, {
        forwardedFor: '2001:db8:abcd:12::1',
      }),
      buildSuccessDeps(rateLimitStore, tiers),
    );
    const r2 = await handleSummaryRequest(
      makeRequest(1, {
        forwardedFor: '2001:db8:abcd:12:ffff:ffff:ffff:ffff',
      }),
      buildSuccessDeps(rateLimitStore, tiers),
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(429);
  });

  it('keeps separate buckets for different IPs', async () => {
    const rateLimitStore = createTestRateLimitStore();
    const tiers: RateLimitTier[] = [
      { name: 'burst', limit: 1, windowSeconds: 600 },
    ];
    const r1 = await handleSummaryRequest(
      makeRequest(1, { forwardedFor: '203.0.113.7' }),
      buildSuccessDeps(rateLimitStore, tiers),
    );
    const r2 = await handleSummaryRequest(
      makeRequest(1, { forwardedFor: '198.51.100.42' }),
      buildSuccessDeps(rateLimitStore, tiers),
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  it('falls open and skips the check when the client IP is unknown', async () => {
    const rateLimitStore = createTestRateLimitStore();
    const tiers: RateLimitTier[] = [
      { name: 'burst', limit: 0, windowSeconds: 600 },
    ];
    // No x-forwarded-for, no x-real-ip — handler should neither 429 nor
    // touch the store.
    const res = await handleSummaryRequest(
      makeRequest(1),
      buildSuccessDeps(rateLimitStore, tiers),
    );
    expect(res.status).toBe(200);
    expect(rateLimitStore.calls.length).toBe(0);
  });

  // Regression guard for the rate-limit gate placement: requests that
  // end in a 400/404/503 for non-rate-limit reasons (low score,
  // missing URL, missing GOOGLE_API_KEY) must not consume quota,
  // because they never reach the paid Gemini / Jina path. If the gate
  // ever moves back to the top of the handler, these tests start
  // failing — which is the whole point.
  it('does not consume quota when the story is ineligible (low score)', async () => {
    const rateLimitStore = createTestRateLimitStore();
    const tiers: RateLimitTier[] = [
      // A limit of 0 would 429 on the very first call if the gate ran;
      // the low-score 400 branch must run first and skip the gate.
      { name: 'burst', limit: 0, windowSeconds: 600 },
    ];
    const res = await handleSummaryRequest(
      makeRequest(1, { forwardedFor: '203.0.113.7' }),
      {
        fetchItem: fetchItemFor({
          1: { id: 1, type: 'story', url: 'https://example.com/a', score: 1 },
        }),
        store: null,
        rateLimitStore,
        rateLimitTiers: tiers,
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe('low_score');
    expect(rateLimitStore.calls.length).toBe(0);
  });

  it('does not consume quota when GOOGLE_API_KEY is missing', async () => {
    delete process.env.GOOGLE_API_KEY;
    const rateLimitStore = createTestRateLimitStore();
    const tiers: RateLimitTier[] = [
      { name: 'burst', limit: 0, windowSeconds: 600 },
    ];
    const res = await handleSummaryRequest(
      makeRequest(1, { forwardedFor: '203.0.113.7' }),
      {
        fetchItem: fetchItemFor({
          1: { id: 1, type: 'story', url: 'https://example.com/a', score: 10 },
        }),
        store: null,
        rateLimitStore,
        rateLimitTiers: tiers,
      },
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.reason).toBe('not_configured');
    expect(rateLimitStore.calls.length).toBe(0);
  });
});

describe('handleSummaryRequest — summary-outcome log events', () => {
  const origGoogle = process.env.GOOGLE_API_KEY;
  const origJina = process.env.JINA_API_KEY;

  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.GOOGLE_API_KEY = 'test-key';
    process.env.JINA_API_KEY = 'test-jina-key';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    if (origGoogle === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = origGoogle;
    if (origJina === undefined) delete process.env.JINA_API_KEY;
    else process.env.JINA_API_KEY = origJina;
  });

  function outcomeLines(): Array<Record<string, unknown>> {
    return logSpy.mock.calls
      .map((c: unknown[]) => (typeof c[0] === 'string' ? c[0] : ''))
      .map((raw: string): unknown => {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      })
      .filter(
        (obj: unknown): obj is Record<string, unknown> =>
          typeof obj === 'object' &&
          obj !== null &&
          (obj as { type?: unknown }).type === 'summary-outcome',
      );
  }

  it('logs outcome=cached on a cache hit, with the cached summary length', async () => {
    const store = createTestStore();
    const now = 1_700_000_000_000;
    await store.set(
      7,
      {
        summary: 'a twelve chrs', // 13 chars
        articleHash: hashArticle('body'),
        firstSeenAt: now,
        summaryGeneratedAt: now,
        lastCheckedAt: now,
        lastChangedAt: now,
      },
      60,
    );

    const res = await handleSummaryRequest(makeRequest(7), { store });
    expect(res.status).toBe(200);

    const lines = outcomeLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: 'summary-outcome',
      endpoint: 'summary',
      outcome: 'cached',
      storyId: 7,
      chars: 13,
    });
  });

  it('logs outcome=generated with Gemini token metadata, Jina tokens, and summary length', async () => {
    const fetchImpl = createFakeFetch({
      'https://r.jina.ai/https://example.com/a': {
        body: JSON.stringify({
          code: 200,
          status: 20000,
          data: {
            content: 'article body',
            usage: { tokens: 4567 },
          },
        }),
      },
    });
    const fetchItem = fetchItemFor({
      50: { id: 50, type: 'story', url: 'https://example.com/a', score: 10 },
    });
    const client = {
      models: {
        generateContent: vi.fn(async () => ({
          text: 'Generated summary of length 33.',
          usageMetadata: {
            promptTokenCount: 1234,
            candidatesTokenCount: 56,
            totalTokenCount: 1290,
          },
        })),
      },
    };

    const res = await handleSummaryRequest(makeRequest(50), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
      store: null,
    });
    expect(res.status).toBe(200);

    const lines = outcomeLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      type: 'summary-outcome',
      endpoint: 'summary',
      outcome: 'generated',
      storyId: 50,
      chars: 'Generated summary of length 33.'.length,
      geminiPromptTokens: 1234,
      geminiOutputTokens: 56,
      geminiTotalTokens: 1290,
      jinaTokens: 4567,
      // Paywall-detector verdict on the Jina-clean body. "article body"
      // matches no marker phrases, so this fixture reliably logs false.
      paywalled: false,
    });
  });

  it('logs outcome=rate_limited when the bucket rejects a request', async () => {
    const rateLimitStore = {
      async incrementWithExpiry() {
        return 999; // way over any limit
      },
    };
    const res = await handleSummaryRequest(
      makeRequest(1, { forwardedFor: '203.0.113.7' }),
      {
        createClient: () => createFakeClient([{ text: 'ok' }]),
        fetchImpl: createFakeFetch({}),
        fetchItem: fetchItemFor({
          1: { id: 1, type: 'story', url: 'https://example.com/a', score: 10 },
        }),
        store: null,
        rateLimitStore,
        rateLimitTiers: [{ name: 'burst', limit: 1, windowSeconds: 600 }],
      },
    );
    expect(res.status).toBe(429);

    const lines = outcomeLines();
    // The rate-limited branch emits one outcome line; no other log lines
    // from this path belong to the taxonomy.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: 'summary-outcome',
      endpoint: 'summary',
      outcome: 'rate_limited',
      storyId: 1,
    });
  });

  it('logs outcome=error with reason=low_score on the anti-abuse floor', async () => {
    const res = await handleSummaryRequest(makeRequest(9), {
      fetchItem: fetchItemFor({
        9: { id: 9, type: 'story', url: 'https://example.com/a', score: 1 },
      }),
      store: null,
    });
    expect(res.status).toBe(400);

    const lines = outcomeLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: 'summary-outcome',
      outcome: 'error',
      reason: 'low_score',
      storyId: 9,
    });
  });

  it('logs outcome=error with reason=summary_budget_exhausted when Jina 402s (alongside the existing jina-payment-required line)', async () => {
    // This test verifies that the two log lines co-exist — the
    // existing console.error alert line and the new console.log
    // outcome line — so a monitor keyed on either still fires.
    const errSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    try {
      const fetchImpl = createFakeFetch({
        'https://r.jina.ai/https://example.com/a': { status: 402 },
      });
      const fetchItem = fetchItemFor({
        12: {
          id: 12,
          type: 'story',
          url: 'https://example.com/a',
          score: 10,
        },
      });
      const res = await handleSummaryRequest(makeRequest(12), {
        createClient: () => createFakeClient([]),
        fetchImpl,
        fetchItem,
        store: null,
      });
      expect(res.status).toBe(503);

      const outcomes = outcomeLines();
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({
        outcome: 'error',
        reason: 'summary_budget_exhausted',
        storyId: 12,
      });

      // Existing alert line still fires — this is the signal that
      // the Axiom monitor keys off for "Jina credit exhausted".
      const alertCalls = errSpy.mock.calls.filter((c) =>
        typeof c[0] === 'string' && c[0].includes('summary-jina-payment-required'),
      );
      expect(alertCalls).toHaveLength(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('detectPaywall', () => {
  it('returns false on empty content', () => {
    expect(detectPaywall('')).toBe(false);
  });

  it('returns false on a long article that never mentions a paywall marker', () => {
    // 4 KB of lorem-ish text. No paywall markers. Should stay negative
    // even though it's a generic article body.
    const body =
      'The early 19th-century development of mechanical looms reshaped the textile towns of Lancashire. ' +
      'Weavers gathered in small workshops, and their apprentices learned the craft by repetition and observation. '.repeat(30);
    expect(body.length).toBeGreaterThan(2000);
    expect(detectPaywall(body)).toBe(false);
  });

  it('returns false on a long article that mentions "subscribe" incidentally', () => {
    // Long body + one incidental marker ("subscribe to our newsletter" —
    // not in the overlay-copy pattern table anyway). Nothing matches.
    const body =
      'A walking tour of the neighbourhood starts at the old library. '.repeat(80) +
      '\n\nIf you enjoyed this post, subscribe to our newsletter for more.';
    expect(body.length).toBeGreaterThan(2000);
    expect(detectPaywall(body)).toBe(false);
  });

  it('returns false on a long article with a single real marker (one-marker + short-body gate)', () => {
    // A long readable article that happens to include overlay-style
    // copy in a sidebar should NOT trip (body > 2000 gate).
    const body =
      'The tram lines curved past the market square as the rain came on. '.repeat(60) +
      '\n\nSign in to continue reading on our sister site.';
    expect(body.length).toBeGreaterThan(2000);
    expect(detectPaywall(body)).toBe(false);
  });

  it('returns true on a short paywall overlay (single marker + short body)', () => {
    const body =
      'Premium Story\n\nSubscribe to continue reading this article. Already a subscriber? Sign in.';
    expect(body.length).toBeLessThanOrEqual(2000);
    expect(detectPaywall(body)).toBe(true);
  });

  it('returns true when two markers hit, regardless of length', () => {
    // Dynamic paywall page: a few KB of marketing, ad slot copy, and
    // a sign-in form. Two distinct marker hits trip the 2-hit gate.
    const body =
      'Welcome to our site. '.repeat(100) +
      '\nThis article is for subscribers only. '.repeat(3) +
      'Please sign in to continue reading. ';
    expect(body.length).toBeGreaterThan(2000);
    expect(detectPaywall(body)).toBe(true);
  });

  it('returns true on a "X of Y free articles" counter', () => {
    const body =
      'You have 2 free articles remaining this month.\n\n' +
      'The conference opened with a keynote on supply-chain economics.';
    expect(detectPaywall(body)).toBe(true);
  });

  it('returns true on a JSON-LD isAccessibleForFree:false marker (strong signal)', () => {
    // This alone should trip, even if the body is otherwise long and
    // contains no marker phrases — schema.org tells us directly.
    const body =
      'The industrial revolution reshaped how textile work was organised. '.repeat(60) +
      '\n\n<script type="application/ld+json">' +
      '{"@type":"NewsArticle","isAccessibleForFree": false}</script>';
    expect(body.length).toBeGreaterThan(2000);
    expect(detectPaywall(body)).toBe(true);
  });

  it('matches the isAccessibleForFree marker with whitespace and case variations', () => {
    expect(detectPaywall('{"isAccessibleForFree":false}')).toBe(true);
    expect(detectPaywall('{"isAccessibleForFree": false}')).toBe(true);
    expect(detectPaywall('{"isAccessibleForFree"  :  false}')).toBe(true);
    // Must be literal `false` — `true` doesn't count.
    expect(detectPaywall('{"isAccessibleForFree":true}')).toBe(false);
  });

  it('is case-insensitive across marker phrases', () => {
    expect(
      detectPaywall('SUBSCRIBE TO CONTINUE reading this article.'),
    ).toBe(true);
    expect(
      detectPaywall('This Article Is For Subscribers Only.'),
    ).toBe(true);
  });

  it('does not trip on the word "paywall" alone', () => {
    // An article that discusses paywalls should not be flagged as
    // being paywalled just for mentioning the topic.
    const body =
      'The rise of the paywall is a major shift in how digital journalism ' +
      'funds itself. News outlets have experimented with paywalls of many ' +
      'shapes, from hard walls to metered models. '.repeat(10);
    expect(detectPaywall(body)).toBe(false);
  });
});

describe('handleSummaryRequest — paywalled field propagation', () => {
  const origGoogle = process.env.GOOGLE_API_KEY;
  const origJina = process.env.JINA_API_KEY;

  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.GOOGLE_API_KEY = 'test-key';
    process.env.JINA_API_KEY = 'test-jina-key';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    if (origGoogle === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = origGoogle;
    if (origJina === undefined) delete process.env.JINA_API_KEY;
    else process.env.JINA_API_KEY = origJina;
  });

  function outcomeLines(): Array<Record<string, unknown>> {
    return logSpy.mock.calls
      .map((c: unknown[]) => (typeof c[0] === 'string' ? c[0] : ''))
      .map((raw: string): unknown => {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      })
      .filter(
        (obj: unknown): obj is Record<string, unknown> =>
          typeof obj === 'object' &&
          obj !== null &&
          (obj as { type?: unknown }).type === 'summary-outcome',
      );
  }

  it('writes paywalled=true onto the record and the generated log line when Jina returns a paywall teaser', async () => {
    const articleUrl = 'https://paywalled.example.com/a';
    const paywallBody =
      'Premium Story\n\nSubscribe to continue reading this article.';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(paywallBody) },
    });
    const fetchItem = fetchItemFor({
      700: { id: 700, type: 'story', url: articleUrl, score: 10 },
    });
    const store = createTestStore();
    const client = createFakeClient([{ text: 'ok' }]);
    const res = await handleSummaryRequest(makeRequest(700), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
      store,
    });
    expect(res.status).toBe(200);

    const record = store.map.get(700)!.record;
    expect(record.paywalled).toBe(true);

    const lines = outcomeLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      outcome: 'generated',
      storyId: 700,
      paywalled: true,
    });
  });

  it('writes paywalled=false onto the record and the generated log line for real article content', async () => {
    const articleUrl = 'https://example.com/real';
    const realBody =
      'The tram lines curved past the market square as the rain came on. '.repeat(30);
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(realBody) },
    });
    const fetchItem = fetchItemFor({
      701: { id: 701, type: 'story', url: articleUrl, score: 10 },
    });
    const store = createTestStore();
    await handleSummaryRequest(makeRequest(701), {
      createClient: () => createFakeClient([{ text: 'ok' }]),
      fetchImpl,
      fetchItem,
      store,
    });

    expect(store.map.get(701)!.record.paywalled).toBe(false);
    const lines = outcomeLines();
    expect(lines[0]).toMatchObject({ outcome: 'generated', paywalled: false });
  });

  it('propagates paywalled from a cached record onto the cached log line', async () => {
    const store = createTestStore();
    const now = 1_700_000_000_000;
    await store.set(
      702,
      {
        summary: 'cached summary',
        articleHash: hashArticle('body'),
        firstSeenAt: now,
        summaryGeneratedAt: now,
        lastCheckedAt: now,
        lastChangedAt: now,
        paywalled: true,
      },
      60,
    );
    await handleSummaryRequest(makeRequest(702), { store });
    const lines = outcomeLines();
    expect(lines[0]).toMatchObject({
      outcome: 'cached',
      storyId: 702,
      paywalled: true,
    });
  });

  it('omits paywalled on the cached log line when the stored record predates the field', async () => {
    // Pre-detector records don't carry the field. The log line must
    // omit it rather than emit `undefined` or `null` — keeps APL
    // queries simple and avoids false cardinality on the monitor
    // dashboards.
    const store = createTestStore();
    const now = 1_700_000_000_000;
    await store.set(
      703,
      {
        summary: 'legacy summary',
        articleHash: hashArticle('body'),
        firstSeenAt: now,
        summaryGeneratedAt: now,
        lastCheckedAt: now,
        lastChangedAt: now,
      },
      60,
    );
    await handleSummaryRequest(makeRequest(703), { store });
    const lines = outcomeLines();
    expect(lines[0]).toMatchObject({ outcome: 'cached' });
    expect(lines[0]).not.toHaveProperty('paywalled');
  });

  it('omits paywalled on self-post generated log lines (no Jina round-trip)', async () => {
    // Ask HN / Show HN / text-only submissions skip Jina entirely, so
    // there's nothing to run detection on. The field should be absent
    // from both the record and the log line — not set to false.
    const fetchItem = fetchItemFor({
      704: {
        id: 704,
        type: 'story',
        title: 'Ask HN: anyone else?',
        text: 'Body of the ask-hn post.',
        score: 10,
      },
    });
    const store = createTestStore();
    await handleSummaryRequest(makeRequest(704), {
      createClient: () => createFakeClient([{ text: 'ok' }]),
      fetchItem,
      store,
    });
    expect(store.map.get(704)!.record.paywalled).toBeUndefined();
    const lines = outcomeLines();
    expect(lines[0]).toMatchObject({ outcome: 'generated', storyId: 704 });
    expect(lines[0]).not.toHaveProperty('paywalled');
  });

  it('omits paywalled on summarization_failed even though Jina succeeded', async () => {
    // `summarization_failed` fires after a successful Jina fetch — so
    // the detector verdict IS known. We deliberately drop it from
    // the log line anyway, to keep the paywall-prevalence query's
    // numerator / denominator cleanly scoped to "summaries we
    // actually served" (cached + generated). A future change that
    // emits `paywalled` on error paths would silently skew the
    // per-host prevalence shares; this test is the regression guard.
    const articleUrl = 'https://paywalled.example.com/captcha';
    const paywallBody =
      'Premium Story\n\nSubscribe to continue reading this article.';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(paywallBody) },
    });
    const fetchItem = fetchItemFor({
      705: { id: 705, type: 'story', url: articleUrl, score: 10 },
    });
    // Gemini returns empty → handler falls to summarization_failed.
    const client = createFakeClient([{ text: null }]);
    const res = await handleSummaryRequest(makeRequest(705), {
      createClient: () => client,
      fetchImpl,
      fetchItem,
      store: null,
    });
    expect(res.status).toBe(502);
    const lines = outcomeLines();
    expect(lines[0]).toMatchObject({
      outcome: 'error',
      reason: 'summarization_failed',
    });
    expect(lines[0]).not.toHaveProperty('paywalled');
  });
});

describe('parseRecord — paywalled field round-trip', () => {
  it('preserves paywalled=true', () => {
    const r: SummaryRecord = {
      summary: 's',
      articleHash: 'h',
      firstSeenAt: 1,
      summaryGeneratedAt: 1,
      lastCheckedAt: 1,
      lastChangedAt: 1,
      paywalled: true,
    };
    expect(parseRecord(r)).toEqual(r);
    expect(parseRecord(JSON.stringify(r))).toEqual(r);
  });

  it('preserves paywalled=false', () => {
    const r: SummaryRecord = {
      summary: 's',
      articleHash: 'h',
      firstSeenAt: 1,
      summaryGeneratedAt: 1,
      lastCheckedAt: 1,
      lastChangedAt: 1,
      paywalled: false,
    };
    expect(parseRecord(r)).toEqual(r);
  });

  it('treats non-boolean paywalled as absent (ignores garbage, not a parse error)', () => {
    const parsed = parseRecord({
      summary: 's',
      articleHash: 'h',
      firstSeenAt: 1,
      summaryGeneratedAt: 1,
      lastCheckedAt: 1,
      lastChangedAt: 1,
      paywalled: 'yes' as unknown as boolean,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.paywalled).toBeUndefined();
  });
});
