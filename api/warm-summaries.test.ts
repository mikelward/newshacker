// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ageBandFromMinutes,
  decideCommentsInterval,
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

// Wraps a markdown body in Jina Reader's JSON envelope so the mock
// matches what production Jina returns now that we request
// `accept: application/json`. Tokens default to a non-zero sentinel so
// the `tokens` / `articleTokensTotal` rollup is easy to assert.
function jinaBody(content: string, tokens = 123): string {
  return JSON.stringify({
    code: 200,
    status: 20000,
    data: { content, usage: { tokens } },
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
  const origSecret = process.env.CRON_SECRET;
  const origNodeEnv = process.env.NODE_ENV;
  const origVercelEnv = process.env.VERCEL_ENV;
  afterEach(() => {
    if (origSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = origSecret;
    if (origNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origNodeEnv;
    if (origVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = origVercelEnv;
  });

  it('allows any request when CRON_SECRET is unset in dev/test mode', () => {
    delete process.env.CRON_SECRET;
    // Vitest runs under NODE_ENV=test by default, so this is also the
    // path the other tests in this file implicitly rely on.
    process.env.NODE_ENV = 'test';
    expect(isAuthorizedCronRequest(makeRequest({ secret: null }))).toBe(true);
  });

  it('fails closed when CRON_SECRET is unset in a production-like env', () => {
    // Guards against a misconfigured prod deploy dropping the env var
    // and silently opening the expensive warmer to the world.
    delete process.env.CRON_SECRET;
    process.env.NODE_ENV = 'production';
    delete process.env.VERCEL_ENV;
    expect(isAuthorizedCronRequest(makeRequest({ secret: null }))).toBe(false);

    process.env.VERCEL_ENV = 'production';
    expect(isAuthorizedCronRequest(makeRequest({ secret: null }))).toBe(false);

    process.env.VERCEL_ENV = 'preview';
    expect(isAuthorizedCronRequest(makeRequest({ secret: null }))).toBe(false);
  });

  it('allows a vercel local-dev preview when CRON_SECRET is unset', () => {
    delete process.env.CRON_SECRET;
    process.env.NODE_ENV = 'production';
    process.env.VERCEL_ENV = 'development';
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
  it('defaults match the documented 30-min / 2-h / 6-h / 32-h / top-30 tuning', () => {
    const knobs = readKnobs({});
    expect(knobs.refreshCheckIntervalSeconds).toBe(30 * 60);
    expect(knobs.stableCheckIntervalSeconds).toBe(2 * 60 * 60);
    expect(knobs.stableThresholdSeconds).toBe(6 * 60 * 60);
    // Both tracks now stop at 32 h — the old 48 h was paying Jina to
    // check stories that almost never change past the 12 h mark.
    expect(knobs.maxStoryAgeSeconds).toBe(32 * 60 * 60);
    expect(knobs.commentsMaxStoryAgeSeconds).toBe(32 * 60 * 60);
    expect(knobs.topN).toBe(30);
  });

  it('reads env overrides and rejects junk values', () => {
    const knobs = readKnobs({
      WARM_REFRESH_CHECK_INTERVAL_SECONDS: '600',
      WARM_TOP_N: '5',
      WARM_MAX_STORY_AGE_SECONDS: 'not-a-number',
      WARM_COMMENTS_MAX_AGE_SECONDS: '7200',
    });
    expect(knobs.refreshCheckIntervalSeconds).toBe(600);
    expect(knobs.topN).toBe(5);
    expect(knobs.maxStoryAgeSeconds).toBe(32 * 60 * 60); // falls back
    expect(knobs.commentsMaxStoryAgeSeconds).toBe(7200);
  });
});

describe('ageBandFromMinutes', () => {
  it('maps minutes to the doubling-width buckets used by analytics', () => {
    expect(ageBandFromMinutes(0)).toBe('0-1h');
    expect(ageBandFromMinutes(30)).toBe('0-1h');
    expect(ageBandFromMinutes(60)).toBe('1-2h'); // boundary is exclusive on the low side
    expect(ageBandFromMinutes(90)).toBe('1-2h');
    expect(ageBandFromMinutes(120)).toBe('2-4h');
    expect(ageBandFromMinutes(240)).toBe('4-8h');
    expect(ageBandFromMinutes(480)).toBe('8-16h');
    expect(ageBandFromMinutes(960)).toBe('16-32h');
    expect(ageBandFromMinutes(1920)).toBe('32h+');
  });
});

describe('decideInterval', () => {
  const base: WarmKnobs = {
    refreshCheckIntervalSeconds: 30 * 60,
    stableCheckIntervalSeconds: 2 * 60 * 60,
    stableThresholdSeconds: 6 * 60 * 60,
    maxStoryAgeSeconds: 32 * 60 * 60,
    topN: 30,
    commentsMaxStoryAgeSeconds: 32 * 60 * 60,
    commentsMinKids: 5,
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

describe('decideCommentsInterval', () => {
  const base: WarmKnobs = {
    refreshCheckIntervalSeconds: 30 * 60,
    stableCheckIntervalSeconds: 2 * 60 * 60,
    stableThresholdSeconds: 6 * 60 * 60,
    maxStoryAgeSeconds: 32 * 60 * 60,
    topN: 30,
    commentsMaxStoryAgeSeconds: 32 * 60 * 60,
    commentsMinKids: 5,
  };
  const now = 1_700_000_000_000;

  function recordLastCheckedAgo(ms: number): CommentsSummaryRecord {
    return {
      insights: ['x'],
      transcriptHash: 'x',
      firstSeenAt: now - 30 * MINUTES,
      summaryGeneratedAt: now - 30 * MINUTES,
      lastCheckedAt: now - ms,
      lastChangedAt: now - 30 * MINUTES,
    };
  }

  function storyAgedSec(seconds: number) {
    return { id: 1, type: 'story' as const, time: Math.floor((now - seconds * 1000) / 1000) };
  }

  it('tier 1 (≤ 1 h old): polls at 15 min', () => {
    const story = storyAgedSec(30 * 60); // 30 min old → tier 1
    expect(decideCommentsInterval(recordLastCheckedAgo(14 * MINUTES), story, now, base).shouldCheck).toBe(false);
    expect(decideCommentsInterval(recordLastCheckedAgo(15 * MINUTES), story, now, base).shouldCheck).toBe(true);
  });

  it('tier 3 (2-4 h old): polls at 60 min', () => {
    const story = storyAgedSec(3 * 60 * 60); // 3 h old → tier 3
    expect(decideCommentsInterval(recordLastCheckedAgo(59 * MINUTES), story, now, base).shouldCheck).toBe(false);
    expect(decideCommentsInterval(recordLastCheckedAgo(60 * MINUTES), story, now, base).shouldCheck).toBe(true);
  });

  it('tier 6 (16-32 h old): polls at 480 min', () => {
    const story = storyAgedSec(20 * 60 * 60); // 20 h old → tier 6
    expect(decideCommentsInterval(recordLastCheckedAgo(7 * HOURS), story, now, base).shouldCheck).toBe(false);
    expect(decideCommentsInterval(recordLastCheckedAgo(8 * HOURS), story, now, base).shouldCheck).toBe(true);
  });

  it('stable short-circuit overrides the tier ladder', () => {
    // Young story (15 min old → would be tier 1, 15 min interval) but
    // the hash has been stable for 7 h (> 6 h threshold). Stable wins:
    // we back off to the 2 h stable interval even though the ladder
    // would poll every 15 min.
    const story = storyAgedSec(15 * 60);
    const record: CommentsSummaryRecord = {
      insights: ['x'],
      transcriptHash: 'x',
      firstSeenAt: now - 7 * HOURS,
      summaryGeneratedAt: now - 7 * HOURS,
      lastCheckedAt: now - 16 * MINUTES,
      lastChangedAt: now - 7 * HOURS,
    };
    expect(decideCommentsInterval(record, story, now, base).shouldCheck).toBe(false);
  });

  it('falls back to the flat fresh interval when story.time is missing', () => {
    // Without a submission timestamp we can't place the story on the
    // ladder; the fallback keeps a sensible 30 min cadence instead of
    // picking tier 1 and over-polling.
    expect(
      decideCommentsInterval(recordLastCheckedAgo(29 * MINUTES), null, now, base).shouldCheck,
    ).toBe(false);
    expect(
      decideCommentsInterval(recordLastCheckedAgo(30 * MINUTES), null, now, base).shouldCheck,
    ).toBe(true);
  });
});

describe('handleWarmRequest', () => {
  const origGoogle = process.env.GOOGLE_API_KEY;
  const origJina = process.env.JINA_API_KEY;
  const origCron = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.GOOGLE_API_KEY = 'test-key';
    // Jina is a hard dependency after the raw-HTML fallback was
    // removed (TODO.md § "Article-fetch fallback"). Tests that
    // assert the "no Jina configured" behavior delete this locally.
    process.env.JINA_API_KEY = 'test-jina-key';
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
    const articleBody = 'body v1';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(articleBody) },
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
    // The Jina-billed token count (from `usage.tokens` in the JSON
    // envelope) is surfaced on the per-story log so operators can spot
    // per-publisher token hogs; and the URL host is carried alongside
    // so per-domain grep works without re-joining against HN item
    // data.
    expect(article.tokens).toBe(123);
    expect(article.urlHost).toBe('example.com');
    expect(comments.outcome).toBe('skipped_no_content');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcomes.article.first_seen).toBe(1);
    expect(runs[0]!.outcomes.comments.skipped_no_content).toBe(1);
    expect(runs[0]!.storyCount).toBe(1);
    // The run log rolls token counts up so you can watch total Jina
    // spend per tick without post-processing the per-story lines.
    expect(runs[0]!.articleTokensTotal).toBe(123);

    const record = store.map.get(1001)!;
    expect(record.summary).toBe('summary v1');
    expect(record.articleHash).toBe(hashArticle(articleBody));
    expect(record.firstSeenAt).toBe(now);
    expect(record.lastChangedAt).toBe(now);
    expect(record.lastCheckedAt).toBe(now);
  });

  it('rolls articleTokensTotal across multiple stories and tags each log with urlHost, even on skipped_interval', async () => {
    // Two stories: one is fresh (will be fetched from Jina and bill
    // tokens), the other has an existing record inside the fresh
    // interval (skipped_interval — no Jina call, no billed tokens this
    // tick). Both should carry `urlHost` so per-publisher grep works
    // on every log line; only the fresh one contributes to the run's
    // `articleTokensTotal`.
    const freshUrl = 'https://fresh.example.com/a';
    const skipUrl = 'https://stable.example.org/b';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${freshUrl}`]: { body: jinaBody('fresh body', 250) },
    });
    const fetchItem = fetchItemFor({
      3001: { id: 3001, type: 'story', url: freshUrl, score: 10 },
      3002: { id: 3002, type: 'story', url: skipUrl, score: 10 },
    });
    const store = createTestStore();
    const now = 1_700_000_000_000;
    // Prepopulated record inside the fresh interval → skipped_interval.
    store.map.set(3002, {
      summary: 'old',
      articleHash: 'old-hash',
      firstSeenAt: now - 5 * MINUTES,
      summaryGeneratedAt: now - 5 * MINUTES,
      lastCheckedAt: now - 5 * MINUTES,
      lastChangedAt: now - 5 * MINUTES,
    });
    const client = createFakeClient([{ text: 'fresh summary' }]);
    const { logger, stories, runs } = captureLogger();

    const res = await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [3001, 3002],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => now,
    });
    expect(res.status).toBe(200);

    const articles = stories.filter((s) => s.track === 'article');
    const fresh = articles.find((s) => s.storyId === 3001)!;
    const skipped = articles.find((s) => s.storyId === 3002)!;
    expect(fresh.outcome).toBe('first_seen');
    expect(fresh.tokens).toBe(250);
    expect(fresh.urlHost).toBe('fresh.example.com');
    expect(skipped.outcome).toBe('skipped_interval');
    expect(skipped.tokens).toBeUndefined();
    expect(skipped.urlHost).toBe('stable.example.org');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.articleTokensTotal).toBe(250);
  });

  it('logs skipped_unreachable (and no tokens) when Jina returns a malformed JSON envelope', async () => {
    // Regression guard for the JSON-response migration: if Jina's
    // envelope shape drifts (or we hit an edge that returns HTML /
    // non-JSON / missing `data.content`), the handler must treat it
    // as unreachable rather than throwing or logging garbage tokens.
    const articleUrl = 'https://example.com/bad-envelope';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: {
        body: JSON.stringify({ code: 200, status: 20000, data: {} }),
      },
    });
    const fetchItem = fetchItemFor({
      4001: { id: 4001, type: 'story', url: articleUrl, score: 10 },
    });
    const store = createTestStore();
    const client = createFakeClient([]);
    const { logger, stories, runs } = captureLogger();

    const res = await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [4001],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => 1_700_000_000_000,
    });
    expect(res.status).toBe(200);
    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('skipped_unreachable');
    expect(article.tokens).toBeUndefined();
    expect(article.urlHost).toBe('example.com');
    expect(runs[0]!.articleTokensTotal).toBe(0);
  });

  it('warms a self-post article summary from story.text without calling Jina', async () => {
    // Self-posts (Ask HN / Show HN / text-only) have no external URL but
    // do carry a body in `text`. The warmer must summarize them directly
    // instead of logging `skipped_no_content`, matching the on-demand
    // /api/summary behaviour.
    const fetchItem = fetchItemFor({
      2001: {
        id: 2001,
        type: 'story',
        title: 'Ask HN: self-post warm',
        text: '<p>Body of the self-post.</p>',
        score: 42,
      },
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error('Jina must not be called for self-posts');
    });
    const store = createTestStore();
    const client = createFakeClient([{ text: 'self-post summary' }]);
    const { logger, stories } = captureLogger();
    const now = 1_700_000_000_000;

    const res = await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [2001],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => now,
    });

    expect(res.status).toBe(200);
    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('first_seen');
    expect(fetchImpl).not.toHaveBeenCalled();
    const record = store.map.get(2001)!;
    expect(record.summary).toBe('self-post summary');
    // Hash is computed on the stripped plain-text body, not the raw HTML.
    expect(record.articleHash).toBe(hashArticle('Body of the self-post.'));
  });

  it('unchanged: bumps lastCheckedAt but does not call Gemini', async () => {
    const articleUrl = 'https://example.com/same';
    const body = 'stable body';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(body) },
    });
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
    const oldBody = 'before';
    const newBody = 'after the update';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(newBody) },
    });
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
      contentBytes: Buffer.byteLength(oldBody, 'utf8'),
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
    // deltaBytes = |newBody - oldBody| in utf8 bytes. The analyst-
    // facing field for "is this a real edit or in-body timestamp noise".
    expect(article.deltaBytes).toBe(
      Math.abs(
        Buffer.byteLength(newBody, 'utf8') -
          Buffer.byteLength(oldBody, 'utf8'),
      ),
    );
    const updated = store.map.get(1003)!;
    expect(updated.summary).toBe('new summary');
    expect(updated.articleHash).toBe(hashArticle(newBody));
    expect(updated.firstSeenAt).toBe(firstSeenAt);
    expect(updated.lastChangedAt).toBe(now);
    expect(updated.summaryGeneratedAt).toBe(now);
    // contentBytes is now persisted so the next `changed` tick can
    // compute deltaBytes in turn.
    expect(updated.contentBytes).toBe(Buffer.byteLength(newBody, 'utf8'));
  });

  it('changed: deltaBytes is omitted when the prior record predates contentBytes persistence', async () => {
    // Records written by summary.ts before the deltaBytes instrumentation
    // land without `contentBytes`. The warm-summaries cron must tolerate
    // that — the log line should omit `deltaBytes` and the record write
    // backfills `contentBytes` so the next changed tick carries it.
    const articleUrl = 'https://example.com/legacy';
    const newBody = 'new content';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(newBody) },
    });
    const fetchItem = fetchItemFor({
      1503: { id: 1503, type: 'story', url: articleUrl, score: 10 },
    });
    const store = createTestStore();
    const firstSeenAt = 1_000_000_000_000;
    // Legacy record: no contentBytes field.
    store.map.set(1503, {
      summary: 'old',
      articleHash: hashArticle('different'),
      firstSeenAt,
      summaryGeneratedAt: firstSeenAt,
      lastCheckedAt: firstSeenAt,
      lastChangedAt: firstSeenAt,
    });
    const client = createFakeClient([{ text: 'fresh' }]);
    const { logger, stories } = captureLogger();
    const now = firstSeenAt + 45 * MINUTES;
    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [1503],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => now,
    });
    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('changed');
    expect(article.deltaBytes).toBeUndefined();
    // New record carries contentBytes so the next tick can compute it.
    expect(store.map.get(1503)!.contentBytes).toBe(
      Buffer.byteLength(newBody, 'utf8'),
    );
  });

  it('skipped_payment_required: Jina 402 maps to its own outcome, not generic unreachable', async () => {
    // Regression guard for the deploy-time Jina quota bug: when the
    // article-fetch quota runs out, every story in the tick was being
    // logged as skipped_unreachable, which hid the real operator signal.
    const articleUrl = 'https://example.com/quota';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: {
        status: 402,
        body: 'Payment Required',
      },
    });
    const fetchItem = fetchItemFor({
      1099: { id: 1099, type: 'story', url: articleUrl, score: 10 },
    });
    const store = createTestStore();
    const client = createFakeClient([]); // must never be called
    const { logger, stories, runs } = captureLogger();
    const now = 1_700_000_000_000;

    const res = await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [1099],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => now,
    });

    expect(res.status).toBe(200);
    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('skipped_payment_required');
    expect(runs[0]!.outcomes.article.skipped_payment_required).toBe(1);
    expect(runs[0]!.outcomes.article.skipped_unreachable).toBe(0);
    expect(client.models.generateContent).not.toHaveBeenCalled();
    // No record is written: we don't want stale/empty entries poisoning
    // the cache when the whole fetch path is down for billing reasons.
    expect(store.map.has(1099)).toBe(false);
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
    // 33 h later — past the 32 h default.
    const now = firstSeenAt + 33 * HOURS;

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
      'https://r.jina.ai/https://example.com/1': { body: jinaBody('1') },
      'https://r.jina.ai/https://example.com/2': { body: jinaBody('2') },
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
      'https://r.jina.ai/https://example.com/a': { body: jinaBody('A') },
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
      // Drop the min-kids gate for this focused test — it's covered
      // in its own test below.
      knobs: { commentsMinKids: 1 },
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
    const oldTranscript = '[#1]\nOld body';
    const newTranscript = '[#1]\nNew body';
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
      transcriptHash: hashTranscript(oldTranscript),
      firstSeenAt,
      summaryGeneratedAt: firstSeenAt,
      lastCheckedAt: firstSeenAt,
      lastChangedAt: firstSeenAt,
      transcriptBytes: Buffer.byteLength(oldTranscript, 'utf8'),
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
    // deltaBytes comes from the transcript byte delta.
    expect(comments.deltaBytes).toBe(
      Math.abs(
        Buffer.byteLength(newTranscript, 'utf8') -
          Buffer.byteLength(oldTranscript, 'utf8'),
      ),
    );
    const updated = commentsStore.map.get(2020)!;
    expect(updated.insights).toEqual(['new a', 'new b']);
    expect(updated.transcriptHash).toBe(hashTranscript(newTranscript));
    expect(updated.firstSeenAt).toBe(firstSeenAt);
    expect(updated.lastChangedAt).toBe(now);
    expect(updated.transcriptBytes).toBe(
      Buffer.byteLength(newTranscript, 'utf8'),
    );
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
      'https://r.jina.ai/https://example.com/x': { body: jinaBody('article') },
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
      knobs: { commentsMinKids: 1 },
      now: () => now,
    });

    const article = stories.find((s) => s.track === 'article')!;
    const comments = stories.find((s) => s.track === 'comments')!;
    expect(article.outcome).toBe('skipped_interval');
    expect(comments.outcome).toBe('first_seen');
    // Article was skipped by backoff, so Jina must not have been called.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('comments skipped_low_volume: cron refuses to create a first_seen record for thin threads', async () => {
    const fetchItem = fetchItemFor({
      4001: {
        id: 4001,
        type: 'story',
        title: 't',
        score: 10,
        kids: [4002, 4003], // fewer than min (5)
      },
      4002: { id: 4002, type: 'comment', text: 'hi', time: 1 },
      4003: { id: 4003, type: 'comment', text: 'ok', time: 2 },
    });
    const commentsStore = createCommentsTestStore();
    const client = createFakeClient([]); // must not be called
    const { logger, stories } = captureLogger();
    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchItem,
      fetchFeedIds: async () => [4001],
      createClient: () => client,
      store: createTestStore(),
      commentsStore,
      logger,
      now: () => 1_700_000_000_000,
    });
    const comments = stories.find((s) => s.track === 'comments')!;
    expect(comments.outcome).toBe('skipped_low_volume');
    expect(comments.commentCount).toBe(2);
    expect(commentsStore.map.get(4001)).toBeUndefined(); // no record written
    expect(client.models.generateContent).not.toHaveBeenCalled();
  });

  it('comments skipped_low_volume only gates first_seen — existing records still regenerate on change', async () => {
    // A thread that was healthy (N >= 5) and then had comments deleted
    // down to 2 should still re-run when the transcript hash flips —
    // stale is worse than thin.
    const fetchItem = fetchItemFor({
      4010: {
        id: 4010,
        type: 'story',
        title: 't',
        score: 10,
        kids: [4011, 4012], // only 2 usable now
      },
      4011: { id: 4011, type: 'comment', text: 'remaining one', time: 1 },
      4012: { id: 4012, type: 'comment', text: 'remaining two', time: 2 },
    });
    const commentsStore = createCommentsTestStore();
    const firstSeenAt = 1_000_000_000_000;
    commentsStore.map.set(4010, {
      insights: ['old insight'],
      transcriptHash: 'stale-hash',
      firstSeenAt,
      summaryGeneratedAt: firstSeenAt,
      lastCheckedAt: firstSeenAt,
      lastChangedAt: firstSeenAt,
    });
    const client = createFakeClient([{ text: 'fresh a\nfresh b' }]);
    const { logger, stories } = captureLogger();
    const now = firstSeenAt + 45 * MINUTES;
    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchItem,
      fetchFeedIds: async () => [4010],
      createClient: () => client,
      store: createTestStore(),
      commentsStore,
      logger,
      now: () => now,
    });
    const comments = stories.find((s) => s.track === 'comments')!;
    expect(comments.outcome).toBe('changed');
    expect(commentsStore.map.get(4010)!.insights).toEqual(['fresh a', 'fresh b']);
  });

  it('comments tier 1 (≤ 1 h): a 30-min-old thread re-checks at the 15-min interval', async () => {
    const now = 1_700_000_000_000;
    // Submitted 30 min ago → tier 1 (0-1h), 15 min poll interval.
    const storyTime = Math.floor((now - 30 * MINUTES) / 1000);
    const fetchItem = fetchItemFor({
      5001: {
        id: 5001,
        type: 'story',
        title: 't',
        score: 10,
        time: storyTime,
        kids: [5002],
      },
      5002: { id: 5002, type: 'comment', text: 'a', time: 1 },
    });
    const commentsStore = createCommentsTestStore();
    // Last checked 15 min ago: hits tier-1's 15 min interval exactly.
    commentsStore.map.set(5001, {
      insights: ['x'],
      transcriptHash: hashTranscript('[#1]\na'),
      firstSeenAt: now - 20 * MINUTES,
      summaryGeneratedAt: now - 20 * MINUTES,
      lastCheckedAt: now - 15 * MINUTES,
      lastChangedAt: now - 20 * MINUTES,
    });
    const client = createFakeClient([]); // hash stable → no Gemini call
    const { logger, stories } = captureLogger();
    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchItem,
      fetchFeedIds: async () => [5001],
      createClient: () => client,
      store: createTestStore(),
      commentsStore,
      logger,
      now: () => now,
    });
    const comments = stories.find((s) => s.track === 'comments')!;
    // Tier-1 interval let the recheck through; hash was unchanged so
    // the outcome is 'unchanged', no Gemini call.
    expect(comments.outcome).toBe('unchanged');
    // The analytics fields we'll read in APL tomorrow.
    expect(comments.ageBand).toBe('0-1h');
    expect(comments.storyAgeMinutes).toBe(30);
  });

  it('comments tier 3 (2-4 h): a 3-h-old thread skips because 15 min < 60 min interval', async () => {
    const now = 1_700_000_000_000;
    // Submitted 3 h ago → tier 3 (2-4h), 60 min poll interval.
    const storyTime = Math.floor((now - 3 * HOURS) / 1000);
    const fetchItem = fetchItemFor({
      5010: {
        id: 5010,
        type: 'story',
        title: 't',
        score: 10,
        time: storyTime,
        kids: [5011],
      },
      5011: { id: 5011, type: 'comment', text: 'a', time: 1 },
    });
    const commentsStore = createCommentsTestStore();
    // Last checked 15 min ago: under tier 3's 60 min interval.
    commentsStore.map.set(5010, {
      insights: ['x'],
      transcriptHash: hashTranscript('[#1]\na'),
      firstSeenAt: now - 3 * HOURS,
      summaryGeneratedAt: now - 3 * HOURS,
      lastCheckedAt: now - 15 * MINUTES,
      lastChangedAt: now - 3 * HOURS,
    });
    const client = createFakeClient([]);
    const { logger, stories } = captureLogger();
    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchItem,
      fetchFeedIds: async () => [5010],
      createClient: () => client,
      store: createTestStore(),
      commentsStore,
      logger,
      now: () => now,
    });
    const comments = stories.find((s) => s.track === 'comments')!;
    expect(comments.outcome).toBe('skipped_interval');
    expect(comments.ageBand).toBe('2-4h');
    expect(comments.storyAgeMinutes).toBe(180);
  });

  it('comments past commentsMaxStoryAgeSeconds (32h): skipped_age', async () => {
    const now = 1_700_000_000_000;
    // Submitted 33 h ago → past the 32 h cutoff.
    const storyTime = Math.floor((now - 33 * HOURS) / 1000);
    const fetchItem = fetchItemFor({
      5020: {
        id: 5020,
        type: 'story',
        title: 't',
        score: 10,
        time: storyTime,
        kids: [5021],
      },
      5021: { id: 5021, type: 'comment', text: 'a', time: 1 },
    });
    const commentsStore = createCommentsTestStore();
    commentsStore.map.set(5020, {
      insights: ['x'],
      transcriptHash: hashTranscript('[#1]\na'),
      firstSeenAt: now - 33 * HOURS,
      summaryGeneratedAt: now - 33 * HOURS,
      lastCheckedAt: now - 10 * HOURS,
      lastChangedAt: now - 33 * HOURS,
    });
    const client = createFakeClient([]); // never called
    const { logger, stories } = captureLogger();
    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchItem,
      fetchFeedIds: async () => [5020],
      createClient: () => client,
      store: createTestStore(),
      commentsStore,
      logger,
      now: () => now,
    });
    const comments = stories.find((s) => s.track === 'comments')!;
    expect(comments.outcome).toBe('skipped_age');
    expect(comments.ageBand).toBe('32h+');
  });

  it('articles carry storyAgeMinutes + ageBand on first_seen', async () => {
    // Regression guard for the analytics: every article entry with a
    // known HN story.time must carry storyAgeMinutes + ageBand so the
    // "changed per ageBand" histogram is queryable without joining
    // back to the HN item table.
    const now = 1_700_000_000_000;
    const storyTime = Math.floor((now - 45 * MINUTES) / 1000);
    const articleUrl = 'https://example.com/analytics';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody('body') },
    });
    const fetchItem = fetchItemFor({
      6001: { id: 6001, type: 'story', url: articleUrl, score: 10, time: storyTime },
    });
    const store = createTestStore();
    const client = createFakeClient([{ text: 's' }]);
    const { logger, stories } = captureLogger();
    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [6001],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => now,
    });
    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('first_seen');
    expect(article.storyAgeMinutes).toBe(45);
    expect(article.ageBand).toBe('0-1h');
  });
});
