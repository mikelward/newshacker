import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleWarmSummariesRequest,
  isAllowedReferer,
  type WarmKv,
} from './warm-summaries';

const ALLOWED_REFERER = 'https://newshacker.app/top';

interface HNFixture {
  id?: number;
  type?: string;
  title?: string;
  url?: string;
  score?: number;
  dead?: boolean;
  deleted?: boolean;
}

function makeRequest(
  body: unknown,
  opts: { referer?: string | null; method?: string; ip?: string } = {},
) {
  const headers = new Headers();
  const referer = opts.referer === undefined ? ALLOWED_REFERER : opts.referer;
  if (referer !== null) headers.set('referer', referer);
  if (opts.ip) headers.set('x-forwarded-for', opts.ip);
  headers.set('content-type', 'application/json');
  return new Request('https://newshacker.app/api/warm-summaries', {
    method: opts.method ?? 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// In-memory KV with TTL support. Covers the subset of the Upstash API the
// warm endpoint uses: GET, SET-NX with expiry, INCR with first-write TTL.
function createTestKv(now: () => number = Date.now) {
  const map = new Map<string, { value: string; expiresAt: number }>();
  function active(key: string) {
    const entry = map.get(key);
    if (!entry) return null;
    if (now() >= entry.expiresAt) {
      map.delete(key);
      return null;
    }
    return entry;
  }
  const kv: WarmKv & {
    map: typeof map;
    count(prefix: string): number;
    peek(key: string): string | null;
  } = {
    map,
    count(prefix) {
      let c = 0;
      for (const k of map.keys()) if (k.startsWith(prefix)) c++;
      return c;
    },
    peek(key) {
      const entry = active(key);
      return entry ? entry.value : null;
    },
    async get(key) {
      return active(key)?.value ?? null;
    },
    async setIfAbsent(key, value, ttlSeconds) {
      if (active(key)) return false;
      map.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
      return true;
    },
    async incrWithTtl(key, ttlSeconds) {
      const entry = active(key);
      if (!entry) {
        map.set(key, { value: '1', expiresAt: now() + ttlSeconds * 1000 });
        return 1;
      }
      const next = Number(entry.value) + 1;
      entry.value = String(next);
      return next;
    },
  };
  return kv;
}

function summaryOk(cached = false): Response {
  return new Response(
    JSON.stringify(cached ? { summary: 's', cached: true } : { summary: 's' }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function summaryError(status = 502): Response {
  return new Response(JSON.stringify({ error: 'x', reason: 'y' }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('isAllowedReferer', () => {
  it('accepts newshacker.app, localhost, and vercel.app previews', () => {
    expect(isAllowedReferer('https://newshacker.app/top')).toBe(true);
    expect(isAllowedReferer('http://localhost:5173/top')).toBe(true);
    expect(isAllowedReferer('https://preview-abc.vercel.app/top')).toBe(true);
  });
  it('rejects unknown hosts and missing referer', () => {
    expect(isAllowedReferer(null)).toBe(false);
    expect(isAllowedReferer('https://evil.com/')).toBe(false);
    expect(isAllowedReferer('not a url')).toBe(false);
  });
});

describe('handleWarmSummariesRequest', () => {
  const origBudget = process.env.WARM_DAILY_BUDGET;
  beforeEach(() => {
    delete process.env.WARM_DAILY_BUDGET;
  });
  afterEach(() => {
    if (origBudget === undefined) delete process.env.WARM_DAILY_BUDGET;
    else process.env.WARM_DAILY_BUDGET = origBudget;
  });

  it('rejects GET and other non-POST methods with 405', async () => {
    const res = await handleWarmSummariesRequest(
      makeRequest(undefined, { method: 'GET' }),
      { kv: null },
    );
    expect(res.status).toBe(405);
  });

  it('rejects requests with a disallowed Referer with 403', async () => {
    const res = await handleWarmSummariesRequest(
      makeRequest({ ids: [1] }, { referer: 'https://evil.com/' }),
      { kv: null },
    );
    expect(res.status).toBe(403);
  });

  it('rejects missing Referer with 403', async () => {
    const res = await handleWarmSummariesRequest(
      makeRequest({ ids: [1] }, { referer: null }),
      { kv: null },
    );
    expect(res.status).toBe(403);
  });

  it('rejects malformed JSON body with 400', async () => {
    const headers = new Headers();
    headers.set('referer', ALLOWED_REFERER);
    const req = new Request('https://newshacker.app/api/warm-summaries', {
      method: 'POST',
      headers,
      body: 'not-json',
    });
    const res = await handleWarmSummariesRequest(req, { kv: null });
    expect(res.status).toBe(400);
  });

  it('rejects bodies without an ids array', async () => {
    const res = await handleWarmSummariesRequest(
      makeRequest({ foo: 'bar' }),
      { kv: null },
    );
    expect(res.status).toBe(400);
  });

  it('rejects empty and oversized id arrays', async () => {
    const r1 = await handleWarmSummariesRequest(
      makeRequest({ ids: [] }),
      { kv: null },
    );
    expect(r1.status).toBe(400);
    const big = Array.from({ length: 31 }, (_, i) => i + 1);
    const r2 = await handleWarmSummariesRequest(
      makeRequest({ ids: big }),
      { kv: null },
    );
    expect(r2.status).toBe(400);
  });

  it('rejects non-integer / negative / zero ids', async () => {
    const r1 = await handleWarmSummariesRequest(
      makeRequest({ ids: [1, 'two'] }),
      { kv: null },
    );
    expect(r1.status).toBe(400);
    const r2 = await handleWarmSummariesRequest(
      makeRequest({ ids: [1, 0] }),
      { kv: null },
    );
    expect(r2.status).toBe(400);
    const r3 = await handleWarmSummariesRequest(
      makeRequest({ ids: [1, -5] }),
      { kv: null },
    );
    expect(r3.status).toBe(400);
  });

  it('warms an eligible story and returns generated outcome', async () => {
    const fetchItem = vi.fn(async (): Promise<HNFixture> => ({
      id: 1,
      type: 'story',
      title: 't',
      url: 'https://example.com/a',
      score: 10,
    }));
    const invokeSummary = vi.fn(async () => summaryOk(false));
    const res = await handleWarmSummariesRequest(makeRequest({ ids: [1] }), {
      kv: null,
      fetchItem,
      invokeSummary,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ results: { '1': 'generated' } });
    expect(invokeSummary).toHaveBeenCalledTimes(1);
  });

  it('reports cached when the summary endpoint reports cached=true', async () => {
    const fetchItem = async () => ({
      id: 2,
      url: 'https://example.com/b',
      score: 5,
    });
    const invokeSummary = vi.fn(async () => summaryOk(true));
    const res = await handleWarmSummariesRequest(makeRequest({ ids: [2] }), {
      kv: null,
      fetchItem,
      invokeSummary,
    });
    const body = await res.json();
    expect(body.results['2']).toBe('cached');
  });

  it('skips stories with no url (Ask HN / self-posts)', async () => {
    const fetchItem = async () => ({ id: 3, score: 50 });
    const invokeSummary = vi.fn(async () => summaryOk(false));
    const res = await handleWarmSummariesRequest(makeRequest({ ids: [3] }), {
      kv: null,
      fetchItem,
      invokeSummary,
    });
    expect((await res.json()).results['3']).toBe('skip:no-url');
    expect(invokeSummary).not.toHaveBeenCalled();
  });

  it('skips stories with score <= 0 (flagged / killed)', async () => {
    const fetchItem = async (id: number) => ({
      id,
      url: 'https://example.com/a',
      score: id === 4 ? 0 : -2,
    });
    const invokeSummary = vi.fn(async () => summaryOk(false));
    const res = await handleWarmSummariesRequest(
      makeRequest({ ids: [4, 5] }),
      {
        kv: null,
        fetchItem,
        invokeSummary,
      },
    );
    const body = await res.json();
    expect(body.results['4']).toBe('skip:low-score');
    expect(body.results['5']).toBe('skip:low-score');
    expect(invokeSummary).not.toHaveBeenCalled();
  });

  it('skips dead or deleted stories', async () => {
    const fetchItem = async (id: number) => ({
      id,
      url: 'https://example.com/a',
      score: 50,
      dead: id === 6,
      deleted: id === 7,
    });
    const res = await handleWarmSummariesRequest(
      makeRequest({ ids: [6, 7] }),
      {
        kv: null,
        fetchItem,
        invokeSummary: async () => summaryOk(false),
      },
    );
    const body = await res.json();
    expect(body.results['6']).toBe('skip:dead');
    expect(body.results['7']).toBe('skip:dead');
  });

  it('reports skip:missing-item for ids that resolve to null', async () => {
    const fetchItem = async () => null;
    const res = await handleWarmSummariesRequest(makeRequest({ ids: [8] }), {
      kv: null,
      fetchItem,
      invokeSummary: async () => summaryOk(false),
    });
    expect((await res.json()).results['8']).toBe('skip:missing-item');
  });

  it('reports error:firebase when the HN fetch throws', async () => {
    const fetchItem = async () => {
      throw new Error('boom');
    };
    const res = await handleWarmSummariesRequest(makeRequest({ ids: [9] }), {
      kv: null,
      fetchItem,
      invokeSummary: async () => summaryOk(false),
    });
    expect((await res.json()).results['9']).toBe('error:firebase');
  });

  it('reports error:gemini when the summary handler returns non-200', async () => {
    const fetchItem = async (id: number) => ({
      id,
      url: 'https://example.com/a',
      score: 10,
    });
    const res = await handleWarmSummariesRequest(makeRequest({ ids: [10] }), {
      kv: null,
      fetchItem,
      invokeSummary: async () => summaryError(502),
    });
    expect((await res.json()).results['10']).toBe('error:gemini');
  });

  it('deduplicates a second warm of the same id within the TTL window', async () => {
    const kv = createTestKv();
    const fetchItem = vi.fn(async (id: number) => ({
      id,
      url: 'https://example.com/a',
      score: 10,
    }));
    const invokeSummary = vi.fn(async () => summaryOk(false));
    const r1 = await handleWarmSummariesRequest(makeRequest({ ids: [20] }), {
      kv,
      fetchItem,
      invokeSummary,
    });
    expect((await r1.json()).results['20']).toBe('generated');
    const r2 = await handleWarmSummariesRequest(makeRequest({ ids: [20] }), {
      kv,
      fetchItem,
      invokeSummary,
    });
    expect((await r2.json()).results['20']).toBe('skip:dedup');
    expect(invokeSummary).toHaveBeenCalledTimes(1);
    // The dedup marker also survives errors — i.e. it's the negative cache
    // for failed generations. Tested separately below.
  });

  it('keeps the dedup marker set on error so retry storms are absorbed', async () => {
    const kv = createTestKv();
    const fetchItem = async (id: number) => ({
      id,
      url: 'https://example.com/a',
      score: 10,
    });
    const invokeSummary = vi
      .fn(async () => summaryError(502))
      .mockImplementationOnce(async () => summaryError(502));
    const r1 = await handleWarmSummariesRequest(makeRequest({ ids: [21] }), {
      kv,
      fetchItem,
      invokeSummary,
    });
    expect((await r1.json()).results['21']).toBe('error:gemini');
    const r2 = await handleWarmSummariesRequest(makeRequest({ ids: [21] }), {
      kv,
      fetchItem,
      invokeSummary,
    });
    expect((await r2.json()).results['21']).toBe('skip:dedup');
  });

  it('stops generating once the daily budget is reached', async () => {
    const kv = createTestKv();
    const fetchItem = async (id: number) => ({
      id,
      url: 'https://example.com/a',
      score: 10,
    });
    const invokeSummary = vi.fn(async () => summaryOk(false));
    // First call consumes the budget of 1.
    const r1 = await handleWarmSummariesRequest(makeRequest({ ids: [30] }), {
      kv,
      fetchItem,
      invokeSummary,
      dailyBudget: 1,
    });
    expect((await r1.json()).results['30']).toBe('generated');

    // Second call with a different id should be short-circuited with
    // skip:budget before invokeSummary is called.
    const r2 = await handleWarmSummariesRequest(makeRequest({ ids: [31] }), {
      kv,
      fetchItem,
      invokeSummary,
      dailyBudget: 1,
    });
    expect((await r2.json()).results['31']).toBe('skip:budget');
    expect(invokeSummary).toHaveBeenCalledTimes(1);
  });

  it('cached hits do not charge the daily budget', async () => {
    const kv = createTestKv();
    const fetchItem = async (id: number) => ({
      id,
      url: 'https://example.com/a',
      score: 10,
    });
    // 10 ids, all served from cache. Budget of 1 should survive.
    const ids = Array.from({ length: 10 }, (_, i) => 100 + i);
    const invokeSummary = vi.fn(async () => summaryOk(true));
    const res = await handleWarmSummariesRequest(makeRequest({ ids }), {
      kv,
      fetchItem,
      invokeSummary,
      dailyBudget: 1,
    });
    const results = (await res.json()).results as Record<string, string>;
    for (const id of ids) expect(results[String(id)]).toBe('cached');
  });

  it('rate-limits a single IP that exceeds RATE_LIMIT_REQUESTS_PER_MIN', async () => {
    const kv = createTestKv();
    const fetchItem = async () => ({
      id: 1,
      url: 'https://example.com/a',
      score: 10,
    });
    const invokeSummary = async () => summaryOk(true);
    // 60 is the cap; the 61st request should 429.
    for (let i = 0; i < 60; i++) {
      const res = await handleWarmSummariesRequest(
        makeRequest({ ids: [200 + i] }, { ip: '1.2.3.4' }),
        { kv, fetchItem, invokeSummary },
      );
      expect(res.status).toBe(200);
    }
    const res = await handleWarmSummariesRequest(
      makeRequest({ ids: [999] }, { ip: '1.2.3.4' }),
      { kv, fetchItem, invokeSummary },
    );
    expect(res.status).toBe(429);
  });

  it('rate limits are scoped per IP — a different IP is not blocked', async () => {
    const kv = createTestKv();
    const fetchItem = async () => ({
      id: 1,
      url: 'https://example.com/a',
      score: 10,
    });
    const invokeSummary = async () => summaryOk(true);
    for (let i = 0; i < 60; i++) {
      await handleWarmSummariesRequest(
        makeRequest({ ids: [300 + i] }, { ip: '1.2.3.4' }),
        { kv, fetchItem, invokeSummary },
      );
    }
    const res = await handleWarmSummariesRequest(
      makeRequest({ ids: [400] }, { ip: '5.6.7.8' }),
      { kv, fetchItem, invokeSummary },
    );
    expect(res.status).toBe(200);
  });

  it('records per-outcome counters so /api/warm-stats can surface them', async () => {
    const kv = createTestKv();
    const fetchItem = async (id: number) => {
      if (id === 500)
        return { id, url: 'https://example.com/a', score: 10 };
      if (id === 501) return { id, score: 10 }; // no url
      return null;
    };
    const invokeSummary = async () => summaryOk(false);
    await handleWarmSummariesRequest(
      makeRequest({ ids: [500, 501, 502] }),
      { kv, fetchItem, invokeSummary },
    );
    // The counter key format is derived from the helper's dayKey, which
    // uses UTC. We just assert the counters exist (values > 0) without
    // hardcoding a date here.
    expect(kv.count('newshacker:warm:counter:generated:')).toBe(1);
    expect(kv.count('newshacker:warm:counter:skip:no-url:')).toBe(1);
    expect(kv.count('newshacker:warm:counter:skip:missing-item:')).toBe(1);
  });

  it('processes multiple ids in the same request', async () => {
    const kv = createTestKv();
    const fetchItem = async (id: number) => ({
      id,
      url: `https://example.com/${id}`,
      score: 10,
    });
    const invokeSummary = async () => summaryOk(false);
    const res = await handleWarmSummariesRequest(
      makeRequest({ ids: [40, 41, 42] }),
      {
        kv,
        fetchItem,
        invokeSummary,
      },
    );
    const body = await res.json();
    expect(body.results['40']).toBe('generated');
    expect(body.results['41']).toBe('generated');
    expect(body.results['42']).toBe('generated');
  });

  it('sets no-store on successful responses', async () => {
    const res = await handleWarmSummariesRequest(
      makeRequest({ ids: [1] }),
      {
        kv: null,
        fetchItem: async (id: number) => ({
          id,
          url: 'https://example.com/a',
          score: 10,
        }),
        invokeSummary: async () => summaryOk(false),
      },
    );
    expect(res.headers.get('cache-control') ?? '').toMatch(/no-store/);
  });
});
