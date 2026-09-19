// @vitest-environment node
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  buildTranscript,
  handleCommentsSummaryRequest,
  hashTranscript,
  parseCommentsRecord,
  type CommentsSummaryRecord,
  type CommentsSummaryStore,
  type RateLimitStore,
  type RateLimitTier,
  __resetStoreWriteBreaker,
} from './comments-summary';

// The store write breaker is module-scoped and persists across cases; a
// test that trips it must not leave it open for the next. Reset before every
// test in the file.
beforeEach(() => {
  __resetStoreWriteBreaker();
});
// Local type mirrors the handler's internal HNItem — duplicated
// intentionally so the test doesn't reach into the handler's private
// module shape.
interface HNItem {
  id?: number;
  type?: string;
  by?: string;
  time?: number;
  title?: string;
  url?: string;
  text?: string;
  score?: number;
  descendants?: number;
  dead?: boolean;
  deleted?: boolean;
  kids?: number[];
}

const ALLOWED_REFERER = 'https://newshacker.app/item/100';

function makeRequest(
  id: string | null,
  opts: {
    referer?: string | null;
    forwardedFor?: string;
    realIp?: string;
  } = {},
) {
  const base = 'https://newshacker.app/api/comments-summary';
  const full = id === null ? base : `${base}?id=${id}`;
  const headers = new Headers();
  const referer = opts.referer === undefined ? ALLOWED_REFERER : opts.referer;
  if (referer !== null) headers.set('referer', referer);
  if (opts.forwardedFor) headers.set('x-forwarded-for', opts.forwardedFor);
  if (opts.realIp) headers.set('x-real-ip', opts.realIp);
  return new Request(full, { headers });
}

// Shared in-memory RateLimitStore for comments-summary tests. Mirror of
// the helper in api/summary.test.ts.
function createTestRateLimitStore(): RateLimitStore & {
  counts: Map<string, number>;
  calls: string[];
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

interface GenerateRequest {
  model: string;
  contents: string;
  config?: {
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

function fetchItemFrom(items: Record<number, HNItem | null>) {
  return vi.fn(async (id: number) => items[id] ?? null);
}

// In-memory CommentsSummaryStore for tests. Honors TTL via an injectable
// `now` so expiration tests still work.
function createTestStore(
  now: () => number = Date.now,
): CommentsSummaryStore & {
  map: Map<number, { record: CommentsSummaryRecord; expiresAt: number }>;
} {
  const map = new Map<
    number,
    { record: CommentsSummaryRecord; expiresAt: number }
  >();
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

// A fixed timestamp that is safely "old" relative to any `now` the tests
// bind to (test `now` is in 2023/2024, this story is from Sept 2020).
// Using a wall-clock-relative value would interact badly with tests that
// pin `now` to a past moment, flipping the young-story TTL branch on.
const OLD_STORY_TIME = 1_600_000_000;

describe('handleCommentsSummaryRequest', () => {
  const origGoogle = process.env.GOOGLE_API_KEY;

  beforeEach(() => {
    process.env.GOOGLE_API_KEY = 'test-key';
  });
  afterEach(() => {
    if (origGoogle === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = origGoogle;
  });

  it('returns 403 when the Referer header is missing', async () => {
    const res = await handleCommentsSummaryRequest(
      makeRequest('1', { referer: null }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 for a disallowed Referer host', async () => {
    const res = await handleCommentsSummaryRequest(
      makeRequest('1', { referer: 'https://evil.com/' }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 when id is missing', async () => {
    const res = await handleCommentsSummaryRequest(makeRequest(null));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid id parameter' });
  });

  it('returns 400 for non-numeric ids', async () => {
    const res = await handleCommentsSummaryRequest(makeRequest('abc'));
    expect(res.status).toBe(400);
  });

  it('returns 400 for zero / negative ids', async () => {
    expect(
      (await handleCommentsSummaryRequest(makeRequest('0'))).status,
    ).toBe(400);
    expect(
      (await handleCommentsSummaryRequest(makeRequest('-5'))).status,
    ).toBe(400);
  });

  it('returns 503 when GOOGLE_API_KEY is unset', async () => {
    delete process.env.GOOGLE_API_KEY;
    const res = await handleCommentsSummaryRequest(makeRequest('1'), {
      store: null,
    });
    expect(res.status).toBe(503);
  });

  it('returns 404 when the story is missing / deleted / dead', async () => {
    const fetchItem = fetchItemFrom({ 1: null });
    const res = await handleCommentsSummaryRequest(makeRequest('1'), {
      fetchItem,
      store: null,
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 with low_score for a story that has not earned an organic upvote', async () => {
    // `> 1` means "at least one vote beyond the submitter's implicit
    // self-upvote". Score 0, missing score, and score 1 all fail.
    const fetchItem = fetchItemFrom({
      3: {
        id: 3,
        type: 'story',
        kids: [99],
        time: OLD_STORY_TIME,
        score: 0,
      },
      5: { id: 5, type: 'story', kids: [99], time: OLD_STORY_TIME },
      7: {
        id: 7,
        type: 'story',
        kids: [99],
        time: OLD_STORY_TIME,
        score: 1,
      },
      99: { id: 99, type: 'comment', by: 'x', text: 'hi', time: 1 },
    });
    for (const id of ['3', '5', '7']) {
      const res = await handleCommentsSummaryRequest(makeRequest(id), {
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

  it('returns 404 when a story has no kids', async () => {
    const fetchItem = fetchItemFrom({
      1: {
        id: 1,
        type: 'story',
        title: 'No comments',
        time: OLD_STORY_TIME,
        score: 10,
      },
    });
    const res = await handleCommentsSummaryRequest(makeRequest('1'), {
      fetchItem,
      store: null,
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when all kids are deleted / dead / missing', async () => {
    const fetchItem = fetchItemFrom({
      10: {
        id: 10,
        type: 'story',
        kids: [11, 12, 13],
        time: OLD_STORY_TIME,
        score: 10,
      },
      11: { id: 11, type: 'comment', deleted: true },
      12: { id: 12, type: 'comment', dead: true, by: 'x', text: 'y' },
      13: null,
    });
    const res = await handleCommentsSummaryRequest(makeRequest('10'), {
      fetchItem,
      store: null,
    });
    expect(res.status).toBe(404);
  });

  it('summarizes the top comments and strips HTML before sending to the model', async () => {
    const fetchItem = fetchItemFrom({
      100: {
        id: 100,
        type: 'story',
        title: 'Great post',
        kids: [101, 102],
        time: OLD_STORY_TIME,
        score: 10,
      },
      101: {
        id: 101,
        type: 'comment',
        by: 'alice',
        text: '<p>I <i>agree</i> with the author.</p>',
        time: OLD_STORY_TIME + 60,
      },
      102: {
        id: 102,
        type: 'comment',
        by: 'bob',
        text: 'counterpoint &amp; caveat',
        time: OLD_STORY_TIME + 120,
      },
    });
    const client = createFakeClient([
      { text: 'Readers mostly agree.\nOne caveat raised.' },
    ]);
    const res = await handleCommentsSummaryRequest(makeRequest('100'), {
      fetchItem,
      createClient: () => client,
      store: null,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      insights: ['Readers mostly agree.', 'One caveat raised.'],
    });

    const call = client.models.generateContent.mock.calls[0]![0];
    // Title in header
    expect(call.contents).toContain('Great post');
    // HTML stripped; entities decoded
    expect(call.contents).toContain('I agree with the author.');
    expect(call.contents).toContain('counterpoint & caveat');
    // Comment sections are numbered without usernames
    expect(call.contents).toContain('[#1]');
    expect(call.contents).toContain('[#2]');
    expect(call.contents).not.toContain('alice');
    expect(call.contents).not.toContain('bob');
    // Thinking disabled — regression guard for the latency fix.
    expect(call.config?.thinkingConfig?.thinkingBudget).toBe(0);
  });

  it('strips stray bullet / numbering markers the model may add', async () => {
    const fetchItem = fetchItemFrom({
      105: {
        id: 105,
        type: 'story',
        kids: [106],
        time: OLD_STORY_TIME,
        score: 10,
      },
      106: {
        id: 106,
        type: 'comment',
        by: 'alice',
        text: 'a point',
        time: 1,
      },
    });
    const client = createFakeClient([
      { text: '- First.\n* Second.\n1. Third.\n2) Fourth.' },
    ]);
    const res = await handleCommentsSummaryRequest(makeRequest('105'), {
      fetchItem,
      createClient: () => client,
      store: null,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      insights: ['First.', 'Second.', 'Third.', 'Fourth.'],
    });
  });

  it('filters deleted / dead kids before building the transcript', async () => {
    const fetchItem = fetchItemFrom({
      200: {
        id: 200,
        type: 'story',
        kids: [201, 202, 203],
        time: OLD_STORY_TIME,
        score: 10,
      },
      201: { id: 201, type: 'comment', by: 'a', text: 'real 1', time: 1 },
      202: { id: 202, type: 'comment', deleted: true },
      203: { id: 203, type: 'comment', by: 'c', text: 'real 2', time: 2 },
    });
    const client = createFakeClient([{ text: 'ok' }]);
    await handleCommentsSummaryRequest(makeRequest('200'), {
      fetchItem,
      createClient: () => client,
      store: null,
    });
    const contents = client.models.generateContent.mock.calls[0]![0].contents;
    expect(contents).toContain('real 1');
    expect(contents).toContain('real 2');
    expect(contents).toContain('[#1]');
    expect(contents).toContain('[#2]');
    expect(contents).not.toContain('[#3]');
  });

  it('caps the sample at the first 20 top-level kids', async () => {
    const kidIds = Array.from({ length: 30 }, (_, i) => 1000 + i);
    const items: Record<number, HNItem | null> = {
      500: {
        id: 500,
        type: 'story',
        kids: kidIds,
        time: OLD_STORY_TIME,
        score: 10,
      },
    };
    for (const id of kidIds) {
      items[id] = {
        id,
        type: 'comment',
        by: `u${id}`,
        text: `body-${id}`,
        time: 1,
      };
    }
    const fetchItem = fetchItemFrom(items);
    const client = createFakeClient([{ text: 'x' }]);
    await handleCommentsSummaryRequest(makeRequest('500'), {
      fetchItem,
      createClient: () => client,
      store: null,
    });
    // Story fetch (1) + first 20 kid fetches = 21 calls.
    expect(fetchItem).toHaveBeenCalledTimes(21);
    const contents = client.models.generateContent.mock.calls[0]![0].contents;
    expect(contents).toContain('body-1000');
    expect(contents).toContain('body-1019');
    expect(contents).not.toContain('body-1020');
  });

  it('supports Ask HN self-posts (no url) as long as there are kids', async () => {
    const fetchItem = fetchItemFrom({
      700: {
        id: 700,
        type: 'story',
        title: 'Ask HN: what do you think?',
        // no url
        kids: [701],
        time: OLD_STORY_TIME,
        score: 10,
      },
      701: {
        id: 701,
        type: 'comment',
        by: 'x',
        text: 'here is my take',
        time: 1,
      },
    });
    const client = createFakeClient([{ text: 'Takes are taken.' }]);
    const res = await handleCommentsSummaryRequest(makeRequest('700'), {
      fetchItem,
      createClient: () => client,
      store: null,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ insights: ['Takes are taken.'] });
  });

  it('returns 502 when the model throws', async () => {
    const fetchItem = fetchItemFrom({
      900: {
        id: 900,
        type: 'story',
        kids: [901],
        time: OLD_STORY_TIME,
        score: 10,
      },
      901: { id: 901, type: 'comment', by: 'x', text: 'hi', time: 1 },
    });
    const client = createFakeClient([new Error('boom')]);
    const res = await handleCommentsSummaryRequest(makeRequest('900'), {
      fetchItem,
      createClient: () => client,
      store: null,
    });
    expect(res.status).toBe(502);
  });

  it('returns 502 when the model returns an empty response', async () => {
    const fetchItem = fetchItemFrom({
      910: {
        id: 910,
        type: 'story',
        kids: [911],
        time: OLD_STORY_TIME,
        score: 10,
      },
      911: { id: 911, type: 'comment', by: 'x', text: 'hi', time: 1 },
    });
    const client = createFakeClient([{ text: '   ' }]);
    const res = await handleCommentsSummaryRequest(makeRequest('910'), {
      fetchItem,
      createClient: () => client,
      store: null,
    });
    expect(res.status).toBe(502);
  });

  it('serves a cached summary on a repeat request via the shared store', async () => {
    const fetchItem = fetchItemFrom({
      1000: {
        id: 1000,
        type: 'story',
        kids: [1001],
        time: OLD_STORY_TIME,
        score: 10,
      },
      1001: { id: 1001, type: 'comment', by: 'x', text: 'hi', time: 1 },
    });
    let now = 1_700_000_000_000;
    const store = createTestStore(() => now);
    const client = createFakeClient([{ text: 'one' }]);
    const r1 = await handleCommentsSummaryRequest(makeRequest('1000'), {
      fetchItem,
      createClient: () => client,
      now: () => now,
      store,
    });
    expect(await r1.json()).toEqual({ insights: ['one'] });

    // 24 h later — under the new cron-owned model, any record hit
    // returns cached regardless of the old "1 h stale" clock.
    now += 24 * 60 * 60 * 1000;
    const client2 = createFakeClient([{ text: 'two' }]);
    const r2 = await handleCommentsSummaryRequest(makeRequest('1000'), {
      fetchItem,
      createClient: () => client2,
      now: () => now,
      store,
    });
    expect(await r2.json()).toEqual({
      insights: ['one'],
      cached: true,
    });
    expect(client2.models.generateContent).not.toHaveBeenCalled();
  });

  it('writes a full record to the shared store with a 30d TTL', async () => {
    const commentText = 'hi';
    const fetchItem = fetchItemFrom({
      1300: {
        id: 1300,
        type: 'story',
        kids: [1301],
        time: OLD_STORY_TIME,
        score: 10,
      },
      1301: {
        id: 1301,
        type: 'comment',
        by: 'x',
        text: commentText,
        time: 1,
      },
    });
    const get = vi.fn<CommentsSummaryStore['get']>(async () => null);
    const set = vi.fn<CommentsSummaryStore['set']>(async () => undefined);
    const now = 1_700_000_000_000;
    await handleCommentsSummaryRequest(makeRequest('1300'), {
      fetchItem,
      createClient: () => createFakeClient([{ text: 'ok' }]),
      now: () => now,
      store: { get, set },
    });
    expect(set).toHaveBeenCalledTimes(1);
    const [id, record, ttlSeconds] = set.mock.calls[0]!;
    expect(id).toBe(1300);
    expect(record.insights).toEqual(['ok']);
    // Hash the same transcript shape the handler builds.
    expect(record.transcriptHash).toBe(
      hashTranscript(
        buildTranscript([{ id: 1301, text: commentText } as never]),
      ),
    );
    expect(record.firstSeenAt).toBe(now);
    expect(record.summaryGeneratedAt).toBe(now);
    expect(record.lastCheckedAt).toBe(now);
    expect(record.lastChangedAt).toBe(now);
    // 30d TTL — cron owns freshness inside that window.
    expect(ttlSeconds).toBe(60 * 60 * 24 * 30);
  });

  it('sets no-store Cache-Control on successful responses', async () => {
    const fetchItem = fetchItemFrom({
      1320: {
        id: 1320,
        type: 'story',
        kids: [1321],
        time: OLD_STORY_TIME,
        score: 10,
      },
      1321: { id: 1321, type: 'comment', by: 'x', text: 'hi', time: 1 },
    });
    const res = await handleCommentsSummaryRequest(makeRequest('1320'), {
      fetchItem,
      createClient: () => createFakeClient([{ text: 'ok' }]),
      now: () => 1_700_000_000_000,
      store: null,
    });
    // Edge CDN is not the shared cache — the function must always run
    // so KV can be consulted.
    expect(res.headers.get('cache-control') ?? '').toMatch(/no-store/);
  });

  it('sets no-store on error responses', async () => {
    const r403 = await handleCommentsSummaryRequest(
      makeRequest('1', { referer: null }),
    );
    expect(r403.headers.get('cache-control') ?? '').toMatch(/no-store/);

    const r400 = await handleCommentsSummaryRequest(makeRequest(null));
    expect(r400.headers.get('cache-control') ?? '').toMatch(/no-store/);
  });

  it('re-fetches only after the 30d Upstash TTL expires, not sooner', async () => {
    // Cron-owned freshness model: the user-facing path never regenerates
    // on a still-present record. Only a true Upstash eviction (TTL or
    // manual delete) triggers work.
    const fetchItem = fetchItemFrom({
      1100: {
        id: 1100,
        type: 'story',
        kids: [1101],
        time: OLD_STORY_TIME,
        score: 10,
      },
      1101: { id: 1101, type: 'comment', by: 'x', text: 'hi', time: 1 },
    });
    let now = 1_700_000_000_000;
    const store = createTestStore(() => now);
    const client1 = createFakeClient([{ text: 'v1' }]);
    await handleCommentsSummaryRequest(makeRequest('1100'), {
      fetchItem,
      createClient: () => client1,
      now: () => now,
      store,
    });

    now += 60 * 60 * 24 * 30 * 1000 + 1;
    const client2 = createFakeClient([{ text: 'v2' }]);
    const res = await handleCommentsSummaryRequest(makeRequest('1100'), {
      fetchItem,
      createClient: () => client2,
      now: () => now,
      store,
    });
    expect(await res.json()).toEqual({ insights: ['v2'] });
  });

  it('parseCommentsRecord rejects legacy string-array entries and bad shapes', () => {
    // Pre-schema entries stored a bare string[] of insights. Treat as
    // absent so the next write silently migrates them.
    expect(parseCommentsRecord(['one', 'two'])).toBeNull();
    expect(parseCommentsRecord(null)).toBeNull();
    expect(parseCommentsRecord(undefined)).toBeNull();
    expect(parseCommentsRecord({})).toBeNull();
    expect(
      parseCommentsRecord({ insights: ['ok'], transcriptHash: 'x' }),
    ).toBeNull();

    const good: CommentsSummaryRecord = {
      insights: ['a', 'b'],
      transcriptHash: 'x',
      firstSeenAt: 1,
      summaryGeneratedAt: 1,
      lastCheckedAt: 1,
      lastChangedAt: 1,
    };
    expect(parseCommentsRecord(good)).toEqual(good);
    // JSON round-trips.
    expect(parseCommentsRecord(JSON.stringify(good))).toEqual(good);
  });

  it('fails closed with 503 when the store read errors (circuit breaker, no generation)', async () => {
    // Redis unreachable. Generating insights we can neither cache nor
    // rate-limit is unbounded, throwaway spend — the outage runaway.
    // Serve 503 instead of paying Gemini on every request.
    const fetchItem = fetchItemFrom({
      1400: {
        id: 1400,
        type: 'story',
        kids: [1401],
        time: OLD_STORY_TIME,
        score: 10,
      },
      1401: { id: 1401, type: 'comment', by: 'x', text: 'hi', time: 1 },
    });
    const store: CommentsSummaryStore = {
      get: vi.fn(async () => {
        throw new Error('kv get failed');
      }),
      set: vi.fn(async () => {}),
    };
    const client = createFakeClient([{ text: 'live insight' }]);
    const res = await handleCommentsSummaryRequest(makeRequest('1400'), {
      fetchItem,
      createClient: () => client,
      now: () => 1_700_000_000_000,
      store,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'Summary is temporarily unavailable',
      reason: 'store_unreachable',
    });
    expect(store.get).toHaveBeenCalledTimes(1);
    // Fail closed: no Gemini, no write.
    expect(client.models.generateContent).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });

  it('opens the write breaker on a failed set, then fails closed on the next miss', async () => {
    // Reads succeed (miss) but writes throw, so the read breaker never
    // fires: the first request generates, the write fails, nothing caches,
    // and without the write breaker every following request would repeat
    // that. The failed set opens the breaker; the next miss serves 503.
    __resetStoreWriteBreaker();
    const fetchItem = fetchItemFrom({
      1410: {
        id: 1410,
        type: 'story',
        kids: [1411],
        time: OLD_STORY_TIME,
        score: 10,
      },
      1411: { id: 1411, type: 'comment', by: 'x', text: 'hi', time: 1 },
    });
    const store: CommentsSummaryStore = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {
        throw new Error('kv set failed');
      }),
    };
    const client = createFakeClient([{ text: 'live insight' }]);
    const deps = {
      fetchItem,
      createClient: () => client,
      now: () => 1_700_000_000_000,
      store,
    };

    // First request: miss, generate, write throws — still served here, but
    // the breaker is now open.
    const first = await handleCommentsSummaryRequest(makeRequest('1410'), deps);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ insights: ['live insight'] });
    expect(store.set).toHaveBeenCalledTimes(1);
    expect(client.models.generateContent).toHaveBeenCalledTimes(1);

    // Second request within the cooldown: miss again, breaker open, fail
    // closed without generating.
    const second = await handleCommentsSummaryRequest(makeRequest('1410'), deps);
    expect(second.status).toBe(503);
    expect(await second.json()).toEqual({
      error: 'Summary is temporarily unavailable',
      reason: 'store_unreachable',
    });
    expect(client.models.generateContent).toHaveBeenCalledTimes(1);
    expect(store.set).toHaveBeenCalledTimes(1);
  });

  it('probe-gates every miss: a write-only outage never generates', async () => {
    // Reads succeed (miss) but writes are rejected. The pre-generation probe
    // fails closed on every miss — cold instance and after the cooldown alike
    // — so a sustained write-only outage generates nothing.
    __resetStoreWriteBreaker();
    const fetchItem = fetchItemFrom({
      1420: {
        id: 1420,
        type: 'story',
        kids: [1421],
        time: OLD_STORY_TIME,
        score: 10,
      },
      1421: { id: 1421, type: 'comment', by: 'x', text: 'hi', time: 1 },
    });
    const store: CommentsSummaryStore = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      probe: vi.fn(async () => {
        throw new Error('kv write rejected');
      }),
    };
    const client = createFakeClient([]); // must never be called
    let clock = 1_700_000_000_000;
    const deps = {
      fetchItem,
      createClient: () => client,
      now: () => clock,
      store,
    };

    const first = await handleCommentsSummaryRequest(makeRequest('1420'), deps);
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({
      error: 'Summary is temporarily unavailable',
      reason: 'store_unreachable',
    });
    // Past the cooldown: the breaker would re-open, but the probe re-gates.
    clock += 61_000;
    const second = await handleCommentsSummaryRequest(makeRequest('1420'), deps);
    expect(second.status).toBe(503);

    expect(store.probe).toHaveBeenCalledTimes(2);
    expect(client.models.generateContent).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });

  it('does not probe for a request rejected before generation (low score)', async () => {
    // The probe write sits after the free validations, so a rejected request
    // (low-score story) never burns Upstash write quota.
    __resetStoreWriteBreaker();
    const fetchItem = fetchItemFrom({
      1430: {
        id: 1430,
        type: 'story',
        kids: [1431],
        time: OLD_STORY_TIME,
        score: 1,
      },
      1431: { id: 1431, type: 'comment', by: 'x', text: 'hi', time: 1 },
    });
    const store: CommentsSummaryStore = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      probe: vi.fn(async () => {}),
    };
    const res = await handleCommentsSummaryRequest(makeRequest('1430'), {
      fetchItem,
      createClient: () => createFakeClient([]),
      store,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('low_score');
    expect(store.probe).not.toHaveBeenCalled();
  });

  it('bounds a store that accepts the probe but rejects the record write', async () => {
    // A store whose probe SET succeeds but whose record SET fails (a strictly
    // size-proportional quota where the tiny probe fits but the record does
    // not — the default store's fresh-key probe already tracks a
    // new-allocation rejection like noeviction). The probe can't catch this,
    // but the write breaker does: the first miss generates once, the failed
    // record set trips the breaker, and the next miss fails closed — one
    // generation per cooldown per instance, not the unbounded runaway.
    __resetStoreWriteBreaker();
    const fetchItem = fetchItemFrom({
      1440: {
        id: 1440,
        type: 'story',
        kids: [1441],
        time: OLD_STORY_TIME,
        score: 10,
      },
      1441: { id: 1441, type: 'comment', by: 'x', text: 'hi', time: 1 },
    });
    const store: CommentsSummaryStore = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {
        throw new Error('kv set failed');
      }),
      probe: vi.fn(async () => {}), // probe write is accepted
    };
    const client = createFakeClient([{ text: 'live insight' }]);
    const deps = {
      fetchItem,
      createClient: () => client,
      now: () => 1_700_000_000_000,
      store,
    };

    // First miss: probe passes, generate, record set throws — served here,
    // but the failed set opens the breaker.
    const first = await handleCommentsSummaryRequest(makeRequest('1440'), deps);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ insights: ['live insight'] });
    expect(store.probe).toHaveBeenCalledTimes(1);
    expect(client.models.generateContent).toHaveBeenCalledTimes(1);

    // Second miss within the cooldown: the in-memory open-breaker check fails
    // closed right after the miss — before the story + comment-item fetches,
    // the rate-limit INCRs, and the probe — bounded to the one generation.
    const second = await handleCommentsSummaryRequest(makeRequest('1440'), deps);
    expect(second.status).toBe(503);
    expect(client.models.generateContent).toHaveBeenCalledTimes(1);
    expect(store.probe).toHaveBeenCalledTimes(1); // not re-probed while open
    // The open breaker short-circuits before any HN fetch: only the first
    // request fetched (story 1440 + comment 1441 = 2), not the second.
    expect(fetchItem).toHaveBeenCalledTimes(2);
  });
});

describe('handleCommentsSummaryRequest — rate limiting', () => {
  const origGoogle = process.env.GOOGLE_API_KEY;
  beforeEach(() => {
    process.env.GOOGLE_API_KEY = 'test-key';
  });
  afterEach(() => {
    if (origGoogle === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = origGoogle;
  });

  function buildSuccessDeps(
    rateLimitStore: RateLimitStore | null,
    tiers: RateLimitTier[],
  ) {
    return {
      fetchItem: fetchItemFrom({
        1: {
          id: 1,
          type: 'story',
          score: 10,
          kids: [2],
          time: OLD_STORY_TIME,
          title: 'Test',
        },
        2: {
          id: 2,
          type: 'comment',
          text: 'Hello world',
        },
      }),
      createClient: () => createFakeClient([{ text: 'an insight' }]),
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
    const r1 = await handleCommentsSummaryRequest(
      makeRequest('1', { forwardedFor: '203.0.113.7' }),
      buildSuccessDeps(rateLimitStore, tiers),
    );
    const r2 = await handleCommentsSummaryRequest(
      makeRequest('1', { forwardedFor: '203.0.113.7' }),
      buildSuccessDeps(rateLimitStore, tiers),
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const blocked = await handleCommentsSummaryRequest(
      makeRequest('1', { forwardedFor: '203.0.113.7' }),
      buildSuccessDeps(rateLimitStore, tiers),
    );
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body.reason).toBe('rate_limited');
    expect(typeof body.retryAfterSeconds).toBe('number');
    expect(blocked.headers.get('retry-after')).toBe(
      String(body.retryAfterSeconds),
    );
  });

  it('cache hits bypass the rate-limit bucket entirely', async () => {
    const store = createTestStore();
    const now = 1_700_000_000_000;
    await store.set(
      1,
      {
        insights: ['cached'],
        transcriptHash: hashTranscript('x'),
        firstSeenAt: now,
        summaryGeneratedAt: now,
        lastCheckedAt: now,
        lastChangedAt: now,
      },
      60,
    );
    const rateLimitStore = createTestRateLimitStore();
    const tiers: RateLimitTier[] = [
      { name: 'burst', limit: 1, windowSeconds: 600 },
    ];
    for (let i = 0; i < 5; i += 1) {
      const res = await handleCommentsSummaryRequest(
        makeRequest('1', { forwardedFor: '203.0.113.7' }),
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
    const r1 = await handleCommentsSummaryRequest(
      makeRequest('1', { forwardedFor: '203.0.113.7' }),
      buildSuccessDeps(rateLimitStore, tiers),
    );
    const r2 = await handleCommentsSummaryRequest(
      makeRequest('1', { forwardedFor: '203.0.113.7' }),
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
    const r1 = await handleCommentsSummaryRequest(
      makeRequest('1', { forwardedFor: '2001:db8:abcd:12::1' }),
      buildSuccessDeps(rateLimitStore, tiers),
    );
    const r2 = await handleCommentsSummaryRequest(
      makeRequest('1', {
        forwardedFor: '2001:db8:abcd:12:ffff:ffff:ffff:ffff',
      }),
      buildSuccessDeps(rateLimitStore, tiers),
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(429);
  });

  it('falls open and skips the check when the client IP is unknown', async () => {
    const rateLimitStore = createTestRateLimitStore();
    const tiers: RateLimitTier[] = [
      { name: 'burst', limit: 0, windowSeconds: 600 },
    ];
    const res = await handleCommentsSummaryRequest(
      makeRequest('1'),
      buildSuccessDeps(rateLimitStore, tiers),
    );
    expect(res.status).toBe(200);
    expect(rateLimitStore.calls.length).toBe(0);
  });

  // Regression guard: the gate sits after all free validation
  // branches, so 404s (no kids, no usable comments), 400s (low score),
  // and 503s (missing GOOGLE_API_KEY) must not consume quota.
  it('does not consume quota when the story has no kids', async () => {
    const rateLimitStore = createTestRateLimitStore();
    const tiers: RateLimitTier[] = [
      { name: 'burst', limit: 0, windowSeconds: 600 },
    ];
    const res = await handleCommentsSummaryRequest(
      makeRequest('1', { forwardedFor: '203.0.113.7' }),
      {
        fetchItem: fetchItemFrom({
          1: {
            id: 1,
            type: 'story',
            score: 10,
            kids: [],
            time: OLD_STORY_TIME,
            title: 'no-kids',
          },
        }),
        store: null,
        rateLimitStore,
        rateLimitTiers: tiers,
      },
    );
    expect(res.status).toBe(404);
    expect(rateLimitStore.calls.length).toBe(0);
  });

  it('does not consume quota when GOOGLE_API_KEY is missing', async () => {
    delete process.env.GOOGLE_API_KEY;
    const rateLimitStore = createTestRateLimitStore();
    const tiers: RateLimitTier[] = [
      { name: 'burst', limit: 0, windowSeconds: 600 },
    ];
    const res = await handleCommentsSummaryRequest(
      makeRequest('1', { forwardedFor: '203.0.113.7' }),
      {
        fetchItem: fetchItemFrom({
          1: {
            id: 1,
            type: 'story',
            score: 10,
            kids: [2],
            time: OLD_STORY_TIME,
            title: 'unconfigured',
          },
          2: { id: 2, type: 'comment', text: 'hi' },
        }),
        store: null,
        rateLimitStore,
        rateLimitTiers: tiers,
      },
    );
    expect(res.status).toBe(503);
    expect(rateLimitStore.calls.length).toBe(0);
  });
});

describe('handleCommentsSummaryRequest — comments-summary-outcome log events', () => {
  const origGoogle = process.env.GOOGLE_API_KEY;

  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.GOOGLE_API_KEY = 'test-key';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    if (origGoogle === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = origGoogle;
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
          (obj as { type?: unknown }).type === 'comments-summary-outcome',
      );
  }

  it('logs outcome=cached with total insight chars + count on a cache hit', async () => {
    const store = createTestStore();
    const now = 1_700_000_000_000;
    await store.set(
      7,
      {
        insights: ['alpha', 'beta', 'gamma'], // 5+4+5 = 14 chars, 3 insights
        transcriptHash: hashTranscript('x'),
        firstSeenAt: now,
        summaryGeneratedAt: now,
        lastCheckedAt: now,
        lastChangedAt: now,
      },
      60,
    );

    const res = await handleCommentsSummaryRequest(makeRequest('7'), {
      store,
    });
    expect(res.status).toBe(200);

    const lines = outcomeLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: 'comments-summary-outcome',
      endpoint: 'comments-summary',
      outcome: 'cached',
      storyId: 7,
      chars: 14,
      insightCount: 3,
    });
  });

  it('logs outcome=generated with Gemini token metadata, total chars, and insight count', async () => {
    const fetchItem = fetchItemFrom({
      20: {
        id: 20,
        type: 'story',
        score: 10,
        kids: [21],
        time: OLD_STORY_TIME,
        title: 'Outcome test',
      },
      21: { id: 21, type: 'comment', text: 'first comment body' },
    });
    const client = {
      models: {
        generateContent: vi.fn(async () => ({
          text: 'one insight\nanother insight',
          usageMetadata: {
            promptTokenCount: 2345,
            candidatesTokenCount: 67,
            totalTokenCount: 2412,
          },
        })),
      },
    };

    const res = await handleCommentsSummaryRequest(makeRequest('20'), {
      fetchItem,
      createClient: () => client,
      store: null,
    });
    expect(res.status).toBe(200);

    const lines = outcomeLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      type: 'comments-summary-outcome',
      endpoint: 'comments-summary',
      outcome: 'generated',
      storyId: 20,
      // "one insight" = 11, "another insight" = 15 → 26
      chars: 26,
      insightCount: 2,
      geminiPromptTokens: 2345,
      geminiOutputTokens: 67,
      geminiTotalTokens: 2412,
    });
  });

  it('logs outcome=error with reason=no_comments when the story has no kids', async () => {
    const fetchItem = fetchItemFrom({
      40: {
        id: 40,
        type: 'story',
        score: 10,
        kids: [],
        time: OLD_STORY_TIME,
        title: 'nothing to say',
      },
    });
    const res = await handleCommentsSummaryRequest(makeRequest('40'), {
      fetchItem,
      store: null,
    });
    expect(res.status).toBe(404);

    const lines = outcomeLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      outcome: 'error',
      reason: 'no_comments',
      storyId: 40,
    });
  });

  it('logs outcome=rate_limited when the bucket rejects a request', async () => {
    const rateLimitStore = {
      async incrementWithExpiry() {
        return 999;
      },
    };
    const res = await handleCommentsSummaryRequest(
      makeRequest('1', { forwardedFor: '203.0.113.7' }),
      {
        fetchItem: fetchItemFrom({
          1: {
            id: 1,
            type: 'story',
            score: 10,
            kids: [2],
            time: OLD_STORY_TIME,
            title: 'test',
          },
          2: { id: 2, type: 'comment', text: 'hello' },
        }),
        createClient: () =>
          createFakeClient([{ text: 'should not be called' }]),
        store: null,
        rateLimitStore,
        rateLimitTiers: [{ name: 'burst', limit: 1, windowSeconds: 600 }],
      },
    );
    expect(res.status).toBe(429);

    const lines = outcomeLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      outcome: 'rate_limited',
      storyId: 1,
    });
  });
});

describe('handleCommentsSummaryRequest cost throttles', () => {
  const origGoogle = process.env.GOOGLE_API_KEY;
  const origDisabled = process.env.SUMMARY_GENERATION_DISABLED;
  const origMinScore = process.env.SUMMARY_MIN_SCORE;

  beforeEach(() => {
    process.env.GOOGLE_API_KEY = 'test-key';
  });
  afterEach(() => {
    for (const [k, v] of [
      ['GOOGLE_API_KEY', origGoogle],
      ['SUMMARY_GENERATION_DISABLED', origDisabled],
      ['SUMMARY_MIN_SCORE', origMinScore],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('SUMMARY_GENERATION_DISABLED refuses a miss with 503 and never fetches or generates', async () => {
    process.env.SUMMARY_GENERATION_DISABLED = 'on';
    const fetchItem = vi.fn(async () => null);
    const client = createFakeClient([]);
    const res = await handleCommentsSummaryRequest(makeRequest('4001'), {
      fetchItem,
      createClient: () => client,
      store: createTestStore(),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'Summary generation is disabled',
      reason: 'generation_disabled',
    });
    expect(fetchItem).not.toHaveBeenCalled();
    expect(client.models.generateContent).not.toHaveBeenCalled();
  });

  it('SUMMARY_MIN_SCORE raises the eligibility floor', async () => {
    process.env.SUMMARY_MIN_SCORE = '100';
    const fetchItem = fetchItemFrom({
      // Score 50 clears the default `> 1` floor but not a raised `> 100`.
      4002: {
        id: 4002,
        type: 'story',
        kids: [4003],
        time: OLD_STORY_TIME,
        score: 50,
      },
      4003: { id: 4003, type: 'comment', by: 'x', text: 'hi', time: 1 },
    });
    const res = await handleCommentsSummaryRequest(makeRequest('4002'), {
      fetchItem,
      store: null,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('low_score');
  });
});
