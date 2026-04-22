// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decideInterval,
  handleWarmRequest,
  hashArticle,
  hashTranscript,
  isAuthorizedCronRequest,
  parseWarmFeed,
  parseWarmN,
  readKnobs,
  type CommentsSummaryRecord,
  type CommentsSummaryStore,
  type RunLog,
  type StoryLog,
  type SummaryRecord,
  type SummaryStore,
  type WarmFeed,
  type WarmKnobs,
} from './warm-summaries';

interface HNItemFixture {
  id?: number;
  type?: string;
  title?: string;
  url?: string;
  text?: string;
  time?: number;
  score?: number;
  kids?: number[];
  dead?: boolean;
  deleted?: boolean;
}

interface WarmRequestOpts {
  secret?: string | null;
}

function makeRequest(
  opts: WarmRequestOpts = {},
  queryString: string = '',
): Request {
  const headers = new Headers();
  if (opts.secret !== null && opts.secret !== undefined) {
    headers.set('authorization', `Bearer ${opts.secret}`);
  }
  const url =
    'https://newshacker.app/api/warm-summaries' +
    (queryString ? `?${queryString}` : '');
  return new Request(url, { headers });
}

function fetchItemFor(items: Record<number, HNItemFixture | null>) {
  return vi.fn(async (id: number) => items[id] ?? null);
}

function createTestStore(): SummaryStore & {
  map: Map<number, SummaryRecord>;
} {
  const map = new Map<number, SummaryRecord>();
  return {
    map,
    async get(storyId) {
      return map.get(storyId) ?? null;
    },
    async set(storyId, record) {
      map.set(storyId, record);
    },
  };
}

function createCommentsTestStore(): CommentsSummaryStore & {
  map: Map<number, CommentsSummaryRecord>;
} {
  const map = new Map<number, CommentsSummaryRecord>();
  return {
    map,
    async get(storyId) {
      return map.get(storyId) ?? null;
    },
    async set(storyId, record) {
      map.set(storyId, record);
    },
  };
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

function createFakeClient(responses: Array<{ text: string | null } | Error>) {
  const queue = [...responses];
  const generateContent = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected generateContent call');
    if (next instanceof Error) throw next;
    return next;
  });
  return { models: { generateContent } };
}

function captureLogger(): {
  logger: (entry: StoryLog | RunLog) => void;
  stories: StoryLog[];
  runs: RunLog[];
} {
  const stories: StoryLog[] = [];
  const runs: RunLog[] = [];
  return {
    stories,
    runs,
    logger(entry) {
      if (entry.type === 'warm-story') stories.push(entry);
      else runs.push(entry);
    },
  };
}

const SECONDS = 1_000;
const MINUTES = 60 * SECONDS;
const HOURS = 60 * MINUTES;

describe('isAuthorizedCronRequest', () => {
  const orig = process.env.CRON_SECRET;
  afterEach(() => {
    if (orig === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = orig;
  });

  it('allows any request when CRON_SECRET is unset (local dev)', () => {
    delete process.env.CRON_SECRET;
    expect(isAuthorizedCronRequest(makeRequest({ secret: null }))).toBe(true);
  });

  it('requires a matching bearer token when CRON_SECRET is set', () => {
    process.env.CRON_SECRET = 'shh';
    expect(isAuthorizedCronRequest(makeRequest({ secret: 'shh' }))).toBe(true);
    expect(isAuthorizedCronRequest(makeRequest({ secret: 'wrong' }))).toBe(
      false,
    );
    expect(isAuthorizedCronRequest(makeRequest({ secret: null }))).toBe(false);
  });
});

describe('parseWarmFeed', () => {
  it('defaults to top when the param is missing', () => {
    expect(parseWarmFeed(null)).toBe<WarmFeed>('top');
  });
  it('accepts all known feed slices', () => {
    for (const slice of ['top', 'new', 'best', 'ask', 'show', 'jobs']) {
      expect(parseWarmFeed(slice)).toBe(slice);
    }
  });
  it('rejects unknown values with null', () => {
    expect(parseWarmFeed('pinned')).toBeNull();
    expect(parseWarmFeed('')).toBe<WarmFeed>('top'); // empty → default
    expect(parseWarmFeed('../etc/passwd')).toBeNull();
  });
});

describe('parseWarmN', () => {
  it('falls back to the caller default when missing', () => {
    expect(parseWarmN(null, 30)).toBe(30);
  });
  it('accepts positive integers up to the hard cap', () => {
    expect(parseWarmN('1', 30)).toBe(1);
    expect(parseWarmN('100', 30)).toBe(100);
  });
  it('rejects zero, negatives, floats, and oversized values', () => {
    expect(parseWarmN('0', 30)).toBeNull();
    expect(parseWarmN('-5', 30)).toBeNull();
    expect(parseWarmN('1.5', 30)).toBeNull();
    expect(parseWarmN('101', 30)).toBeNull();
    expect(parseWarmN('abc', 30)).toBeNull();
  });
});

describe('readKnobs', () => {
  it('defaults match the documented 30-min / 2-h / 6-h / 48-h / top-30 tuning', () => {
    const knobs = readKnobs({});
    expect(knobs.refreshCheckIntervalSeconds).toBe(30 * 60);
    expect(knobs.stableCheckIntervalSeconds).toBe(2 * 60 * 60);
    expect(knobs.stableThresholdSeconds).toBe(6 * 60 * 60);
    expect(knobs.maxStoryAgeSeconds).toBe(48 * 60 * 60);
    expect(knobs.topN).toBe(30);
  });

  it('reads env overrides and rejects junk values', () => {
    const knobs = readKnobs({
      WARM_REFRESH_CHECK_INTERVAL_SECONDS: '600',
      WARM_TOP_N: '5',
      WARM_MAX_STORY_AGE_SECONDS: 'not-a-number',
    });
    expect(knobs.refreshCheckIntervalSeconds).toBe(600);
    expect(knobs.topN).toBe(5);
    expect(knobs.maxStoryAgeSeconds).toBe(48 * 60 * 60); // falls back
  });
});

describe('decideInterval', () => {
  const base: WarmKnobs = {
    refreshCheckIntervalSeconds: 30 * 60,
    stableCheckIntervalSeconds: 2 * 60 * 60,
    stableThresholdSeconds: 6 * 60 * 60,
    maxStoryAgeSeconds: 48 * 60 * 60,
    topN: 30,
  };

  it('waits for the fresh-interval when the article is not yet stable', () => {
    const now = 10 * HOURS;
    const record: SummaryRecord = {
      summary: 'x',
      articleHash: 'a',
      firstSeenAt: now - 1 * HOURS,
      summaryGeneratedAt: now - 1 * HOURS,
      lastCheckedAt: now - 10 * MINUTES,
      lastChangedAt: now - 1 * HOURS, // changed recently → not stable
    };
    const { shouldCheck, stableFor } = decideInterval(record, now, base);
    expect(stableFor).toBe(1 * HOURS);
    // 10 min since last check < 30 min fresh interval
    expect(shouldCheck).toBe(false);
  });

  it('triggers at the fresh interval when enough time has passed', () => {
    const now = 10 * HOURS;
    const record: SummaryRecord = {
      summary: 'x',
      articleHash: 'a',
      firstSeenAt: now - 2 * HOURS,
      summaryGeneratedAt: now - 2 * HOURS,
      lastCheckedAt: now - 31 * MINUTES,
      lastChangedAt: now - 2 * HOURS,
    };
    expect(decideInterval(record, now, base).shouldCheck).toBe(true);
  });

  it('applies the longer stable interval once the article has been quiet ≥ 6 h', () => {
    const now = 24 * HOURS;
    const record: SummaryRecord = {
      summary: 'x',
      articleHash: 'a',
      firstSeenAt: now - 20 * HOURS,
      summaryGeneratedAt: now - 20 * HOURS,
      lastCheckedAt: now - 45 * MINUTES, // 45 min since check
      lastChangedAt: now - 20 * HOURS, // stable for 20 h ≥ 6 h threshold
    };
    // Fresh-interval (30 min) would have fired; stable-interval (2 h) has not.
    expect(decideInterval(record, now, base).shouldCheck).toBe(false);

    const later = now + 2 * HOURS;
    const bumped = { ...record, lastCheckedAt: later - (2 * HOURS + MINUTES) };
    expect(decideInterval(bumped, later, base).shouldCheck).toBe(true);
  });
});

describe('handleWarmRequest', () => {
  const origGoogle = process.env.GOOGLE_API_KEY;
  const origJina = process.env.JINA_API_KEY;
  const origCron = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.GOOGLE_API_KEY = 'test-key';
    delete process.env.JINA_API_KEY;
    delete process.env.CRON_SECRET;
  });
  afterEach(() => {
    if (origGoogle === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = origGoogle;
    if (origJina === undefined) delete process.env.JINA_API_KEY;
    else process.env.JINA_API_KEY = origJina;
    if (origCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = origCron;
  });

  it('rejects unauthenticated callers when CRON_SECRET is set', async () => {
    process.env.CRON_SECRET = 'shh';
    const res = await handleWarmRequest(makeRequest({ secret: 'nope' }));
    expect(res.status).toBe(403);
  });

  it('returns 503 when no store is configured', async () => {
    const { logger, runs } = captureLogger();
    const res = await handleWarmRequest(makeRequest({ secret: null }), {
      store: null,
      commentsStore: null,
      logger,
    });
    expect(res.status).toBe(503);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.processed).toBe(0);
  });

  it('first-seen: creates a record and logs first_seen for a new story', async () => {
    const articleUrl = 'https://example.com/first';
    const fetchImpl = createFakeFetch({
      [articleUrl]: { body: '<article>body v1</article>' },
    });
    const fetchItem = fetchItemFor({
      1001: { id: 1001, type: 'story', url: articleUrl, score: 42 },
    });
    const store = createTestStore();
    const client = createFakeClient([{ text: 'summary v1' }]);
    const { logger, stories, runs } = captureLogger();
    const now = 1_700_000_000_000;

    const res = await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [1001],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => now,
    });

    expect(res.status).toBe(200);
    // Two logs per story — one per track. This fixture has no kids,
    // so the comments track immediately returns skipped_no_content.
    expect(stories).toHaveLength(2);
    const article = stories.find((s) => s.track === 'article')!;
    const comments = stories.find((s) => s.track === 'comments')!;
    expect(article.outcome).toBe('first_seen');
    expect(comments.outcome).toBe('skipped_no_content');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcomes.article.first_seen).toBe(1);
    expect(runs[0]!.outcomes.comments.skipped_no_content).toBe(1);
    expect(runs[0]!.storyCount).toBe(1);

    const record = store.map.get(1001)!;
    expect(record.summary).toBe('summary v1');
    expect(record.articleHash).toBe(hashArticle('<article>body v1</article>'));
    expect(record.firstSeenAt).toBe(now);
    expect(record.lastChangedAt).toBe(now);
    expect(record.lastCheckedAt).toBe(now);
  });

  it('unchanged: bumps lastCheckedAt but does not call Gemini', async () => {
    const articleUrl = 'https://example.com/same';
    const body = '<article>stable body</article>';
    const fetchImpl = createFakeFetch({ [articleUrl]: { body } });
    const fetchItem = fetchItemFor({
      1002: { id: 1002, type: 'story', url: articleUrl, score: 10 },
    });
    const store = createTestStore();
    const firstSeenAt = 1_000_000_000_000;
    const originalHash = hashArticle(body);
    store.map.set(1002, {
      summary: 'old',
      articleHash: originalHash,
      firstSeenAt,
      summaryGeneratedAt: firstSeenAt,
      lastCheckedAt: firstSeenAt,
      lastChangedAt: firstSeenAt,
    });
    const client = createFakeClient([]); // must never be called
    const { logger, stories } = captureLogger();
    const now = firstSeenAt + 45 * MINUTES; // past the 30-min fresh interval

    const res = await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [1002],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => now,
    });

    expect(res.status).toBe(200);
    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('unchanged');
    expect(client.models.generateContent).not.toHaveBeenCalled();
    const updated = store.map.get(1002)!;
    expect(updated.summary).toBe('old'); // untouched
    expect(updated.lastCheckedAt).toBe(now);
    expect(updated.lastChangedAt).toBe(firstSeenAt);
  });

  it('changed: regenerates summary and records a new hash + lastChangedAt', async () => {
    const articleUrl = 'https://example.com/edited';
    const oldBody = '<article>before</article>';
    const newBody = '<article>after the update</article>';
    const fetchImpl = createFakeFetch({ [articleUrl]: { body: newBody } });
    const fetchItem = fetchItemFor({
      1003: { id: 1003, type: 'story', url: articleUrl, score: 10 },
    });
    const store = createTestStore();
    const firstSeenAt = 1_000_000_000_000;
    store.map.set(1003, {
      summary: 'old summary',
      articleHash: hashArticle(oldBody),
      firstSeenAt,
      summaryGeneratedAt: firstSeenAt,
      lastCheckedAt: firstSeenAt,
      lastChangedAt: firstSeenAt,
    });
    const client = createFakeClient([{ text: 'new summary' }]);
    const { logger, stories } = captureLogger();
    const now = firstSeenAt + 45 * MINUTES;

    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [1003],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => now,
    });

    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('changed');
    expect(article.summaryChanged).toBe(true);
    expect(article.stableForMinutes).toBe(45); // 45 min from firstSeen
    const updated = store.map.get(1003)!;
    expect(updated.summary).toBe('new summary');
    expect(updated.articleHash).toBe(hashArticle(newBody));
    expect(updated.firstSeenAt).toBe(firstSeenAt);
    expect(updated.lastChangedAt).toBe(now);
    expect(updated.summaryGeneratedAt).toBe(now);
  });

  it('skipped_age: past MAX_STORY_AGE we stop checking but keep the cached record', async () => {
    const articleUrl = 'https://example.com/old';
    const fetchImpl = createFakeFetch({
      [articleUrl]: { body: '<article>never fetched</article>' },
    });
    const fetchItem = fetchItemFor({});
    const store = createTestStore();
    const firstSeenAt = 1_000_000_000_000;
    const existing: SummaryRecord = {
      summary: 'preserved',
      articleHash: 'preserved-hash',
      firstSeenAt,
      summaryGeneratedAt: firstSeenAt,
      lastCheckedAt: firstSeenAt + 1 * HOURS,
      lastChangedAt: firstSeenAt,
    };
    store.map.set(1004, existing);
    const { logger, stories } = captureLogger();
    // 49 h later — past the 48 h default.
    const now = firstSeenAt + 49 * HOURS;

    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [1004],
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => now,
    });

    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('skipped_age');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.map.get(1004)).toEqual(existing); // untouched
  });

  it('skipped_interval: still inside the fresh-interval window', async () => {
    const articleUrl = 'https://example.com/quiet';
    const fetchImpl = createFakeFetch({
      [articleUrl]: { body: '<article>body</article>' },
    });
    const fetchItem = fetchItemFor({});
    const store = createTestStore();
    const firstSeenAt = 1_000_000_000_000;
    store.map.set(1005, {
      summary: 'x',
      articleHash: 'x',
      firstSeenAt,
      summaryGeneratedAt: firstSeenAt,
      lastCheckedAt: firstSeenAt + 29 * MINUTES, // 29 min < 30 min interval
      lastChangedAt: firstSeenAt,
    });
    const { logger, stories } = captureLogger();
    const now = firstSeenAt + 30 * MINUTES;

    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [1005],
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => now,
    });

    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('skipped_interval');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('processes top-N ids in order, honoring the topN knob', async () => {
    const fetchItem = fetchItemFor({
      1: { id: 1, type: 'story', url: 'https://example.com/1', score: 10 },
      2: { id: 2, type: 'story', url: 'https://example.com/2', score: 10 },
      3: { id: 3, type: 'story', url: 'https://example.com/3', score: 10 },
    });
    const fetchImpl = createFakeFetch({
      'https://example.com/1': { body: '1' },
      'https://example.com/2': { body: '2' },
    });
    const store = createTestStore();
    const { logger, stories } = captureLogger();
    const client = createFakeClient([{ text: 's1' }, { text: 's2' }]);

    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [1, 2, 3, 4, 5],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      knobs: { topN: 2 },
      now: () => 1_700_000_000_000,
    });

    const articleStoryIds = stories
      .filter((s) => s.track === 'article')
      .map((s) => s.storyId)
      .sort();
    expect(articleStoryIds).toEqual([1, 2]);
  });

  it('run log aggregates outcome counts per track and reports knob values', async () => {
    const fetchItem = fetchItemFor({
      1: { id: 1, type: 'story', url: 'https://example.com/a', score: 10 },
      2: { id: 2, type: 'story', score: 10 }, // no url → article skipped_no_content
      3: { id: 3, type: 'story', url: 'https://example.com/c', score: 0 }, // low score → both tracks
    });
    const fetchImpl = createFakeFetch({
      'https://example.com/a': { body: 'A' },
    });
    const store = createTestStore();
    const client = createFakeClient([{ text: 'sa' }]);
    const { logger, runs } = captureLogger();

    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [1, 2, 3],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => 1_700_000_000_000,
    });

    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.storyCount).toBe(3);
    expect(run.processed).toBe(6); // 3 stories × 2 tracks
    // Article track outcomes:
    //   id 1 → first_seen (has url, regenerates summary)
    //   id 2 → skipped_no_content (no url)
    //   id 3 → skipped_low_score (score 0)
    expect(run.outcomes.article.first_seen).toBe(1);
    expect(run.outcomes.article.skipped_no_content).toBe(1);
    expect(run.outcomes.article.skipped_low_score).toBe(1);
    // Comments track outcomes:
    //   id 1 → skipped_no_content (no kids)
    //   id 2 → skipped_no_content (no kids)
    //   id 3 → skipped_low_score (score 0)
    expect(run.outcomes.comments.skipped_no_content).toBe(2);
    expect(run.outcomes.comments.skipped_low_score).toBe(1);
    expect(run.knobs.topN).toBe(30);
  });

  it('returns 502 when the feed fetch fails', async () => {
    const store = createTestStore();
    const res = await handleWarmRequest(makeRequest({ secret: null }), {
      store,
      commentsStore: createCommentsTestStore(),
      fetchFeedIds: async () => {
        throw new Error('firebase down');
      },
    });
    expect(res.status).toBe(502);
  });

  it('honours ?feed=new and passes the feed to the id fetcher', async () => {
    const fetchFeedIds = vi.fn<
      (feed: WarmFeed, signal?: AbortSignal) => Promise<number[]>
    >(async () => []);
    const store = createTestStore();
    const { logger, runs } = captureLogger();
    const res = await handleWarmRequest(
      makeRequest({ secret: null }, 'feed=new&n=2'),
      {
        store,
        commentsStore: createCommentsTestStore(),
        logger,
        fetchFeedIds,
      },
    );
    expect(res.status).toBe(200);
    expect(fetchFeedIds).toHaveBeenCalledWith('new', expect.anything());
    expect(runs[0]!.feed).toBe('new');
    expect(runs[0]!.topNRequested).toBe(2);
  });

  it('returns 400 for unknown ?feed values', async () => {
    const res = await handleWarmRequest(
      makeRequest({ secret: null }, 'feed=bogus'),
      {
        store: createTestStore(),
        commentsStore: createCommentsTestStore(),
      },
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for malformed ?n values', async () => {
    const res = await handleWarmRequest(
      makeRequest({ secret: null }, 'n=NaN'),
      {
        store: createTestStore(),
        commentsStore: createCommentsTestStore(),
      },
    );
    expect(res.status).toBe(400);
  });

  // ---- comments track ----

  it('comments first_seen: builds the transcript, hashes it, and stores insights', async () => {
    const fetchItem = fetchItemFor({
      2001: {
        id: 2001,
        type: 'story',
        title: 'Discuss this',
        // No url → article track skips; comments track does the work.
        score: 10,
        kids: [2002, 2003],
      },
      2002: {
        id: 2002,
        type: 'comment',
        text: 'First insight',
        time: 1,
      },
      2003: {
        id: 2003,
        type: 'comment',
        text: 'Second insight',
        time: 2,
      },
    });
    const commentsStore = createCommentsTestStore();
    const client = createFakeClient([
      { text: 'Insight one\nInsight two' },
    ]);
    const { logger, stories } = captureLogger();
    const now = 1_700_000_000_000;

    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchItem,
      fetchFeedIds: async () => [2001],
      createClient: () => client,
      store: createTestStore(),
      commentsStore,
      logger,
      now: () => now,
    });

    const comments = stories.find((s) => s.track === 'comments')!;
    expect(comments.outcome).toBe('first_seen');
    const record = commentsStore.map.get(2001)!;
    expect(record.insights).toEqual(['Insight one', 'Insight two']);
    expect(record.transcriptHash).toBe(
      hashTranscript('[#1]\nFirst insight\n\n[#2]\nSecond insight'),
    );
    expect(record.firstSeenAt).toBe(now);
    expect(record.lastChangedAt).toBe(now);
  });

  it('comments unchanged: identical transcript skips Gemini, bumps lastCheckedAt', async () => {
    const existingTranscript = '[#1]\nSame comment';
    const fetchItem = fetchItemFor({
      2010: {
        id: 2010,
        type: 'story',
        title: 't',
        score: 10,
        kids: [2011],
      },
      2011: {
        id: 2011,
        type: 'comment',
        text: 'Same comment',
        time: 1,
      },
    });
    const commentsStore = createCommentsTestStore();
    const firstSeenAt = 1_000_000_000_000;
    commentsStore.map.set(2010, {
      insights: ['old'],
      transcriptHash: hashTranscript(existingTranscript),
      firstSeenAt,
      summaryGeneratedAt: firstSeenAt,
      lastCheckedAt: firstSeenAt,
      lastChangedAt: firstSeenAt,
    });
    const client = createFakeClient([]); // never called
    const { logger, stories } = captureLogger();
    const now = firstSeenAt + 45 * MINUTES;

    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchItem,
      fetchFeedIds: async () => [2010],
      createClient: () => client,
      store: createTestStore(),
      commentsStore,
      logger,
      now: () => now,
    });

    const comments = stories.find((s) => s.track === 'comments')!;
    expect(comments.outcome).toBe('unchanged');
    expect(client.models.generateContent).not.toHaveBeenCalled();
    const updated = commentsStore.map.get(2010)!;
    expect(updated.insights).toEqual(['old']); // untouched
    expect(updated.lastCheckedAt).toBe(now);
    expect(updated.lastChangedAt).toBe(firstSeenAt);
  });

  it('comments changed: new transcript regenerates insights and updates lastChangedAt', async () => {
    const fetchItem = fetchItemFor({
      2020: {
        id: 2020,
        type: 'story',
        title: 't',
        score: 10,
        kids: [2021],
      },
      2021: {
        id: 2021,
        type: 'comment',
        text: 'New body',
        time: 1,
      },
    });
    const commentsStore = createCommentsTestStore();
    const firstSeenAt = 1_000_000_000_000;
    commentsStore.map.set(2020, {
      insights: ['old insight'],
      transcriptHash: hashTranscript('[#1]\nOld body'),
      firstSeenAt,
      summaryGeneratedAt: firstSeenAt,
      lastCheckedAt: firstSeenAt,
      lastChangedAt: firstSeenAt,
    });
    const client = createFakeClient([{ text: 'new a\nnew b' }]);
    const { logger, stories } = captureLogger();
    const now = firstSeenAt + 45 * MINUTES;

    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchItem,
      fetchFeedIds: async () => [2020],
      createClient: () => client,
      store: createTestStore(),
      commentsStore,
      logger,
      now: () => now,
    });

    const comments = stories.find((s) => s.track === 'comments')!;
    expect(comments.outcome).toBe('changed');
    expect(comments.insightsChanged).toBe(true);
    const updated = commentsStore.map.get(2020)!;
    expect(updated.insights).toEqual(['new a', 'new b']);
    expect(updated.transcriptHash).toBe(hashTranscript('[#1]\nNew body'));
    expect(updated.firstSeenAt).toBe(firstSeenAt);
    expect(updated.lastChangedAt).toBe(now);
  });

  it('tracks are independent: article skipped_interval while comments first_seen', async () => {
    // Article track has a fresh record (skipped_interval), but the
    // comments track has never been populated, so it runs normally.
    const fetchItem = fetchItemFor({
      3001: {
        id: 3001,
        type: 'story',
        title: 't',
        url: 'https://example.com/x',
        score: 10,
        kids: [3002],
      },
      3002: { id: 3002, type: 'comment', text: 'a thought', time: 1 },
    });
    const fetchImpl = createFakeFetch({
      'https://example.com/x': { body: 'article' },
    });
    const store = createTestStore();
    const commentsStore = createCommentsTestStore();
    const firstSeenAt = 1_000_000_000_000;
    store.map.set(3001, {
      summary: 'art v1',
      articleHash: 'art-hash',
      firstSeenAt,
      summaryGeneratedAt: firstSeenAt,
      lastCheckedAt: firstSeenAt + 5 * MINUTES,
      lastChangedAt: firstSeenAt,
    });
    const client = createFakeClient([{ text: 'c insight' }]);
    const { logger, stories } = captureLogger();
    const now = firstSeenAt + 20 * MINUTES; // under 30-min fresh interval

    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [3001],
      createClient: () => client,
      store,
      commentsStore,
      logger,
      now: () => now,
    });

    const article = stories.find((s) => s.track === 'article')!;
    const comments = stories.find((s) => s.track === 'comments')!;
    expect(article.outcome).toBe('skipped_interval');
    expect(comments.outcome).toBe('first_seen');
    // Article was skipped by backoff, so Jina must not have been called.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
