// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ageBandFromMinutes,
  countCorrectionKeywords,
  countLinks,
  decideCommentsInterval,
  decideInterval,
  detectPaywall as detectPaywallWarm,
  handleWarmRequest,
  hashArticle,
  hashLede,
  hashTranscript,
  isAuthorizedCronRequest,
  normalizeLede,
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
import { detectPaywall as detectPaywallSummary } from './summary';

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

interface FakeGenerateResponse {
  text: string | null;
  // Optional Gemini usage metadata, mirroring the real SDK shape that
  // `processArticleTrack` / `processCommentsTrack` now read for
  // per-call token telemetry. Tests that don't care about token
  // counts can omit this and the cron simply omits the fields on
  // the resulting `warm-story` log line.
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

function createFakeClient(responses: Array<FakeGenerateResponse | Error>) {
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
  it('rejects Object.prototype keys', () => {
    // Regression: `raw in FEED_ENDPOINTS` walked the prototype chain,
    // so `?feed=toString` was accepted and a function got interpolated
    // into the Firebase URL.
    for (const key of [
      'toString',
      'valueOf',
      'constructor',
      '__proto__',
      'hasOwnProperty',
    ]) {
      expect(parseWarmFeed(key)).toBeNull();
    }
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
    expect(knobs.minDeltaBytes).toBe(256);
  });

  it('reads env overrides and rejects junk values', () => {
    const knobs = readKnobs({
      WARM_REFRESH_CHECK_INTERVAL_SECONDS: '600',
      WARM_TOP_N: '5',
      WARM_MAX_STORY_AGE_SECONDS: 'not-a-number',
      WARM_COMMENTS_MAX_AGE_SECONDS: '7200',
      WARM_MIN_DELTA_BYTES: '128',
    });
    expect(knobs.refreshCheckIntervalSeconds).toBe(600);
    expect(knobs.topN).toBe(5);
    expect(knobs.maxStoryAgeSeconds).toBe(32 * 60 * 60); // falls back
    expect(knobs.commentsMaxStoryAgeSeconds).toBe(7200);
    expect(knobs.minDeltaBytes).toBe(128);
  });

  it('WARM_MIN_DELTA_BYTES accepts 0 as "guard disabled" (unlike positive-only knobs)', () => {
    // Operator escape hatch: setting 0 turns off the delta guard so
    // every hash flip regenerates, matching pre-fix behaviour without
    // a redeploy. parsePositiveInt would have rejected 0 and fallen
    // back to the default — this knob uses parseNonNegativeInt for
    // exactly this reason.
    const knobs = readKnobs({ WARM_MIN_DELTA_BYTES: '0' });
    expect(knobs.minDeltaBytes).toBe(0);
  });

  it('parsePositiveInt rejects fractional inputs that would floor to 0', () => {
    // Regression guard: `'0.5'` used to pass the `n <= 0` check
    // (since 0.5 > 0) and then `Math.floor(n)` would silently return
    // 0 — turning a "positive int" knob into 0 and disabling whatever
    // interval/threshold consumed it. Validate after flooring so
    // anything that rounds below 1 falls back to the default. Driven
    // through WARM_TOP_N (a `parsePositiveInt` consumer); the same
    // helper backs every other interval/threshold knob.
    expect(readKnobs({ WARM_TOP_N: '0.5' }).topN).toBe(30);
    expect(readKnobs({ WARM_TOP_N: '0.999' }).topN).toBe(30);
    // `'5.5'` still truncates to 5 — the helper has always tolerated
    // loose input and there's no reason to break that for valid
    // round-down cases.
    expect(readKnobs({ WARM_TOP_N: '5.5' }).topN).toBe(5);
  });

  it('WARM_MIN_DELTA_BYTES rejects negatives and junk, falling back to the default', () => {
    expect(readKnobs({ WARM_MIN_DELTA_BYTES: '-1' }).minDeltaBytes).toBe(256);
    expect(readKnobs({ WARM_MIN_DELTA_BYTES: 'nope' }).minDeltaBytes).toBe(256);
  });

  it('WARM_MIN_DELTA_BYTES rejects whitespace and floats so the guard is never silently disabled', () => {
    // Regression guard: `Number(' ') === 0` and `Number('0.5') === 0.5`
    // (which Math.floor would round to 0) — both would silently turn
    // the guard off if the parser accepted them. Only strict integer
    // strings count.
    expect(readKnobs({ WARM_MIN_DELTA_BYTES: ' ' }).minDeltaBytes).toBe(256);
    expect(readKnobs({ WARM_MIN_DELTA_BYTES: '   ' }).minDeltaBytes).toBe(256);
    expect(readKnobs({ WARM_MIN_DELTA_BYTES: '0.5' }).minDeltaBytes).toBe(256);
    expect(readKnobs({ WARM_MIN_DELTA_BYTES: '128.0' }).minDeltaBytes).toBe(
      256,
    );
    // Surrounding whitespace on a valid integer is fine.
    expect(readKnobs({ WARM_MIN_DELTA_BYTES: ' 128 ' }).minDeltaBytes).toBe(
      128,
    );
  });

  it('WARM_MIN_DELTA_BYTES rejects values past Number.MAX_SAFE_INTEGER', () => {
    // A 20-digit digit string would clear the regex but lose precision
    // when coerced through `Number()` — non-deterministic behaviour for
    // a knob is worse than falling back to the default. Use an
    // explicit unsafe-integer constant just past 2^53.
    expect(
      readKnobs({ WARM_MIN_DELTA_BYTES: '9007199254740993' }).minDeltaBytes,
    ).toBe(256);
    // The boundary itself (2^53 - 1) is still a safe integer, so it
    // passes — though no real operator would set the knob this high.
    expect(
      readKnobs({ WARM_MIN_DELTA_BYTES: '9007199254740991' }).minDeltaBytes,
    ).toBe(Number.MAX_SAFE_INTEGER);
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
    minDeltaBytes: 256,
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
    minDeltaBytes: 256,
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

  it('logs Gemini token counts on first_seen for both tracks and rolls them up on the run log', async () => {
    // Closes the parity gap between the user-path summary endpoints
    // (which already log Gemini token counts on every
    // `summary-outcome` / `comments-summary-outcome` line) and the
    // warm cron, which used to silently spend Gemini tokens with no
    // visibility. The /admin Token-spend card and the OBSERVABILITY
    // alerts both depend on these fields being present.
    const articleUrl = 'https://example.com/with-gemini-usage';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody('article body') },
    });
    const fetchItem = fetchItemFor({
      9001: {
        id: 9001,
        type: 'story',
        url: articleUrl,
        score: 50,
        kids: [9101, 9102, 9103, 9104, 9105],
      },
      // Five top-level comments — past WARM_COMMENTS_MIN_KIDS so the
      // comments track regenerates rather than skipping_low_volume.
      ...Object.fromEntries(
        [9101, 9102, 9103, 9104, 9105].map((id) => [
          id,
          { id, type: 'comment', text: `comment-${id}` },
        ]),
      ),
    });
    const store = createTestStore();
    const commentsStore = createCommentsTestStore();
    // The two tracks run in parallel via Promise.all in
    // processStory, so a queue-ordered stub races against the
    // dispatch order. Dispatch by prompt-content marker instead —
    // article prompts carry "BEGIN ARTICLE", comments prompts
    // carry "BEGIN COMMENTS".
    const generateContent = vi.fn(
      async (req: { contents: string }) => {
        if (req.contents.includes('BEGIN ARTICLE')) {
          return {
            text: 'article summary',
            usageMetadata: {
              promptTokenCount: 4_000,
              candidatesTokenCount: 60,
              totalTokenCount: 4_060,
            },
          };
        }
        if (req.contents.includes('BEGIN COMMENTS')) {
          return {
            text: '- insight one\n- insight two',
            usageMetadata: {
              promptTokenCount: 2_500,
              candidatesTokenCount: 80,
              totalTokenCount: 2_580,
            },
          };
        }
        throw new Error(`unexpected prompt: ${req.contents.slice(0, 40)}`);
      },
    );
    const client = { models: { generateContent } };
    const { logger, stories, runs } = captureLogger();

    const res = await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [9001],
      createClient: () => client,
      store,
      commentsStore,
      logger,
      now: () => 1_700_000_000_000,
    });

    expect(res.status).toBe(200);
    const article = stories.find((s) => s.track === 'article')!;
    const comments = stories.find((s) => s.track === 'comments')!;
    expect(article.outcome).toBe('first_seen');
    expect(comments.outcome).toBe('first_seen');
    expect(article.geminiPromptTokens).toBe(4_000);
    expect(article.geminiOutputTokens).toBe(60);
    expect(article.geminiTotalTokens).toBe(4_060);
    expect(comments.geminiPromptTokens).toBe(2_500);
    expect(comments.geminiOutputTokens).toBe(80);
    expect(comments.geminiTotalTokens).toBe(2_580);
    // Run-level rollup combines both tracks so a single warm-run
    // line tells the operator the per-tick Gemini spend without
    // joining the per-story rows.
    expect(runs).toHaveLength(1);
    expect(runs[0]!.geminiPromptTokensTotal).toBe(4_000 + 2_500);
    expect(runs[0]!.geminiOutputTokensTotal).toBe(60 + 80);
  });

  it('omits Gemini token fields when the SDK response lacks usageMetadata', async () => {
    // Defensive: older SDK shapes (or future regressions) might emit
    // a response without `usageMetadata`. The cron must continue
    // working — and the missing tokens must be *omitted*, not
    // emitted as 0, so an analyst can't confuse "Gemini was called
    // but the SDK didn't tell us" with "Gemini was called and
    // billed nothing".
    const articleUrl = 'https://example.com/no-usage';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody('body') },
    });
    const fetchItem = fetchItemFor({
      9201: { id: 9201, type: 'story', url: articleUrl, score: 50 },
    });
    const store = createTestStore();
    const client = createFakeClient([{ text: 'summary, no usage metadata' }]);
    const { logger, stories, runs } = captureLogger();

    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [9201],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => 1_700_000_000_000,
    });

    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('first_seen');
    expect(article.geminiPromptTokens).toBeUndefined();
    expect(article.geminiOutputTokens).toBeUndefined();
    expect(article.geminiTotalTokens).toBeUndefined();
    // Run-level rollup stays at 0 when no per-story log contributes.
    expect(runs[0]!.geminiPromptTokensTotal).toBe(0);
    expect(runs[0]!.geminiOutputTokensTotal).toBe(0);
  });

  it('logs Gemini token counts on error outcomes that follow a billed Gemini call (article + comments tracks)', async () => {
    // The SDK can respond with usage metadata (= we were billed)
    // but a response we can't use — empty / whitespace `text` on
    // the article track, an unparsable bullet list on the comments
    // track. The error log line must still carry the gemini token
    // fields so spend telemetry is complete. Mirrors api/summary.ts
    // which logs gemini fields on its own error paths for the same
    // reason.
    const articleUrl = 'https://example.com/billed-but-empty';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody('article body') },
    });
    const fetchItem = fetchItemFor({
      9301: {
        id: 9301,
        type: 'story',
        url: articleUrl,
        score: 50,
        kids: [9311, 9312, 9313, 9314, 9315],
      },
      ...Object.fromEntries(
        [9311, 9312, 9313, 9314, 9315].map((id) => [
          id,
          { id, type: 'comment', text: `comment-${id}` },
        ]),
      ),
    });
    const store = createTestStore();
    const commentsStore = createCommentsTestStore();
    // Article track: text empty (' ' trims to ''), but tokens billed.
    // Comments track: text doesn't parse to any insights (no bullets),
    // and tokens billed. Both should emit `outcome: 'error'` carrying
    // the gemini fields.
    const generateContent = vi.fn(async (req: { contents: string }) => {
      if (req.contents.includes('BEGIN ARTICLE')) {
        return {
          text: '   ',
          usageMetadata: {
            promptTokenCount: 4_000,
            candidatesTokenCount: 5,
            totalTokenCount: 4_005,
          },
        };
      }
      if (req.contents.includes('BEGIN COMMENTS')) {
        // parseInsights is permissive — any non-empty line counts.
        // Empty string is the only response that always parses to
        // zero insights, mirroring "Gemini billed but produced
        // nothing usable".
        return {
          text: '',
          usageMetadata: {
            promptTokenCount: 2_500,
            candidatesTokenCount: 30,
            totalTokenCount: 2_530,
          },
        };
      }
      throw new Error(`unexpected prompt: ${req.contents.slice(0, 40)}`);
    });
    const client = { models: { generateContent } };
    const { logger, stories, runs } = captureLogger();

    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [9301],
      createClient: () => client,
      store,
      commentsStore,
      logger,
      now: () => 1_700_000_000_000,
    });

    const article = stories.find((s) => s.track === 'article')!;
    const comments = stories.find((s) => s.track === 'comments')!;
    expect(article.outcome).toBe('error');
    expect(article.geminiPromptTokens).toBe(4_000);
    expect(article.geminiOutputTokens).toBe(5);
    expect(article.geminiTotalTokens).toBe(4_005);
    expect(comments.outcome).toBe('error');
    expect(comments.geminiPromptTokens).toBe(2_500);
    expect(comments.geminiOutputTokens).toBe(30);
    expect(comments.geminiTotalTokens).toBe(2_530);
    // Run-level rollup includes the billed-but-erroring spend.
    expect(runs[0]!.geminiPromptTokensTotal).toBe(4_000 + 2_500);
    expect(runs[0]!.geminiOutputTokensTotal).toBe(5 + 30);
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

  it('self-post: small text edit still regenerates (delta guard is URL-only)', async () => {
    // The minor-delta guard exists to absorb Jina-render noise — in-body
    // timestamps, ad slots, related-article widgets — that flips the
    // hash without changing the article. Self-posts don't go through
    // Jina at all (the body comes from `story.text`) and tend to be
    // short enough that a small text edit is genuinely material to the
    // summary, so the guard must not apply on this path.
    const newText = '<p>Original self-post body, with a small fix.</p>';
    const fetchItem = fetchItemFor({
      2050: {
        id: 2050,
        type: 'story',
        title: 'Ask HN: edit',
        text: newText,
        score: 42,
      },
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error('Jina must not be called for self-posts');
    });
    const store = createTestStore();
    const firstSeenAt = 1_700_000_000_000;
    const oldPlain = 'Original self-post body.';
    store.map.set(2050, {
      summary: 'old summary',
      articleHash: hashArticle(oldPlain),
      firstSeenAt,
      summaryGeneratedAt: firstSeenAt,
      lastCheckedAt: firstSeenAt,
      lastChangedAt: firstSeenAt,
      contentBytes: Buffer.byteLength(oldPlain, 'utf8'),
    });
    const client = createFakeClient([{ text: 'new summary' }]);
    const { logger, stories } = captureLogger();
    const now = firstSeenAt + 45 * MINUTES;

    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [2050],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => now,
    });

    const article = stories.find((s) => s.track === 'article')!;
    // 25-byte delta — under the 256 B default — but this is a real edit
    // to a self-post, so it falls through to Gemini.
    expect(article.outcome).toBe('changed');
    expect(client.models.generateContent).toHaveBeenCalledTimes(1);
    expect(store.map.get(2050)!.summary).toBe('new summary');
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
    // Bodies sized so the delta clears the default WARM_MIN_DELTA_BYTES
    // (256) — otherwise the new article-track delta guard would catch
    // this as `skipped_minor_delta` instead of letting it through to
    // Gemini. A multi-paragraph real edit, which is what this test is
    // exercising, comfortably exceeds 256 B.
    const oldBody = 'a'.repeat(1000);
    const newBody = 'a'.repeat(2000);
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

  it('skipped_minor_delta: hash flips but |deltaBytes| < threshold → no Gemini call, record preserved', async () => {
    // The article-track delta guard. The Jina-clean body re-rendered to
    // a different hash (in-body timestamp, ad slot, related-articles
    // widget, etc.) but the byte length barely moved. We refresh
    // lastCheckedAt only and leave articleHash, contentBytes,
    // lastChangedAt, and summary pinned to the last real regen so
    // cumulative drift will still trip the threshold even if individual
    // ticks don't.
    const articleUrl = 'https://example.com/noisy';
    const oldBody = 'x'.repeat(1000); // 1000 bytes
    const newBody = 'x'.repeat(1100); // 1100 bytes — different hash, only 100 B delta
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(newBody) },
    });
    const fetchItem = fetchItemFor({
      1601: { id: 1601, type: 'story', url: articleUrl, score: 10 },
    });
    const store = createTestStore();
    const firstSeenAt = 1_000_000_000_000;
    const oldHash = hashArticle(oldBody);
    store.map.set(1601, {
      summary: 'old summary',
      articleHash: oldHash,
      firstSeenAt,
      summaryGeneratedAt: firstSeenAt,
      lastCheckedAt: firstSeenAt,
      lastChangedAt: firstSeenAt,
      contentBytes: Buffer.byteLength(oldBody, 'utf8'),
    });
    const client = createFakeClient([]); // must never be called
    const { logger, stories, runs } = captureLogger();
    const now = firstSeenAt + 45 * MINUTES;

    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [1601],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => now,
    });

    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('skipped_minor_delta');
    expect(client.models.generateContent).not.toHaveBeenCalled();
    expect(article.deltaBytes).toBe(100);
    expect(article.contentBytes).toBe(1100);
    // Jina was still called — the guard fires after the fetch — so the
    // tokens field is populated and the run-level rollup picks it up.
    expect(article.tokens).toBe(123);

    // Persisted record: lastCheckedAt advanced, everything else
    // pinned to the last real regen so deltas still accumulate
    // against the original baseline.
    const updated = store.map.get(1601)!;
    expect(updated.lastCheckedAt).toBe(now);
    expect(updated.summary).toBe('old summary');
    expect(updated.articleHash).toBe(oldHash);
    expect(updated.contentBytes).toBe(Buffer.byteLength(oldBody, 'utf8'));
    expect(updated.lastChangedAt).toBe(firstSeenAt);
    expect(updated.summaryGeneratedAt).toBe(firstSeenAt);

    // Run-level outcome tally: skipped_minor_delta is its own bucket.
    expect(runs[0].outcomes.article.skipped_minor_delta).toBe(1);
    expect(runs[0].outcomes.article.changed).toBe(0);
  });

  it('changed: |deltaBytes| ≥ threshold falls through the guard and regenerates', async () => {
    // Same shape as the previous test, but the new body is far enough
    // off the old size that the guard doesn't fire — Gemini is called
    // and we log `changed` as before.
    const articleUrl = 'https://example.com/real-edit';
    const oldBody = 'x'.repeat(1000); // 1000 bytes
    const newBody = 'x'.repeat(2000); // 2000 bytes — 1 KB delta, well over 256 B
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(newBody) },
    });
    const fetchItem = fetchItemFor({
      1602: { id: 1602, type: 'story', url: articleUrl, score: 10 },
    });
    const store = createTestStore();
    const firstSeenAt = 1_000_000_000_000;
    store.map.set(1602, {
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
      fetchFeedIds: async () => [1602],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => now,
    });

    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('changed');
    expect(article.deltaBytes).toBe(1000);
    expect(client.models.generateContent).toHaveBeenCalledTimes(1);
    const updated = store.map.get(1602)!;
    expect(updated.summary).toBe('new summary');
    expect(updated.articleHash).toBe(hashArticle(newBody));
    expect(updated.lastChangedAt).toBe(now);
  });

  it('changed: deltaBytes === 0 falls through the guard (same-length wording change is not noise)', async () => {
    // Backstop for the same-byte-length edge case: hash flips but
    // contentBytes is identical. Skipping in that case would pin the
    // baseline and produce `0 < threshold` forever, leaving a stale
    // summary in cache. Erring toward false-positive Gemini regen on
    // these is cheaper than indefinite false-negative staleness.
    // Two equal-length bodies — `'abc'` and `'xyz'`, each 3 bytes,
    // different hashes.
    const articleUrl = 'https://example.com/same-length';
    const oldBody = 'a'.repeat(500) + 'abc';
    const newBody = 'a'.repeat(500) + 'xyz';
    expect(Buffer.byteLength(newBody, 'utf8')).toBe(
      Buffer.byteLength(oldBody, 'utf8'),
    );
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(newBody) },
    });
    const fetchItem = fetchItemFor({
      1604: { id: 1604, type: 'story', url: articleUrl, score: 10 },
    });
    const store = createTestStore();
    const firstSeenAt = 1_000_000_000_000;
    store.map.set(1604, {
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
      fetchFeedIds: async () => [1604],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => now,
    });

    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('changed');
    expect(article.deltaBytes).toBe(0);
    expect(client.models.generateContent).toHaveBeenCalledTimes(1);
    expect(store.map.get(1604)!.summary).toBe('new summary');
  });

  it('changed: WARM_MIN_DELTA_BYTES=0 disables the guard so every flip regenerates', async () => {
    // Operator escape hatch: setting the knob to 0 turns the guard off
    // entirely, restoring pre-fix behaviour without a redeploy. A
    // 100 B flip that would normally be skipped now goes to Gemini.
    const articleUrl = 'https://example.com/guard-off';
    const oldBody = 'x'.repeat(1000);
    const newBody = 'x'.repeat(1100); // would be skipped under the default 256 B threshold
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(newBody) },
    });
    const fetchItem = fetchItemFor({
      1603: { id: 1603, type: 'story', url: articleUrl, score: 10 },
    });
    const store = createTestStore();
    const firstSeenAt = 1_000_000_000_000;
    store.map.set(1603, {
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
      fetchFeedIds: async () => [1603],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => now,
      knobs: { minDeltaBytes: 0 },
    });

    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('changed');
    expect(client.models.generateContent).toHaveBeenCalledTimes(1);
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

describe('detectPaywall parity between summary.ts and warm-summaries.ts', () => {
  // The two implementations are duplicated per AGENTS.md § "Vercel api/
  // gotchas". If they drift, prevalence numbers on the two endpoints
  // stop being comparable. Lock the fixtures here so any accidental
  // divergence fails CI loudly on the next push.
  const fixtures: Array<{ name: string; content: string; expected: boolean }> = [
    { name: 'empty', content: '', expected: false },
    {
      name: 'short paywall overlay',
      content: 'Subscribe to continue reading this article.',
      expected: true,
    },
    {
      name: 'isAccessibleForFree ld+json',
      content: '{"@type":"NewsArticle","isAccessibleForFree": false}',
      expected: true,
    },
    {
      name: 'long article with no markers',
      content: 'Weavers gathered in small workshops. '.repeat(100),
      expected: false,
    },
    {
      name: 'long article with a single passing marker (should not trip)',
      content:
        'The tram lines curved past the market square as the rain came on. '.repeat(60) +
        'Sign in to continue reading on our sister site.',
      expected: false,
    },
    {
      name: 'dynamic paywall (two marker hits, long body)',
      content:
        'Welcome to our site. '.repeat(100) +
        'This article is for subscribers only. Please sign in to continue reading.',
      expected: true,
    },
    {
      name: 'free-articles counter',
      content: 'You have 2 free articles remaining this month.',
      expected: true,
    },
  ];

  for (const { name, content, expected } of fixtures) {
    it(`${name} → ${expected}`, () => {
      expect(detectPaywallSummary(content)).toBe(expected);
      expect(detectPaywallWarm(content)).toBe(expected);
      // Direct parity — regardless of the expected value, both
      // implementations must agree byte-for-byte on the same input.
      expect(detectPaywallWarm(content)).toBe(detectPaywallSummary(content));
    });
  }
});

describe('warm-summaries — paywalled field propagation', () => {
  const PAYWALL_BODY =
    'Premium Story\n\nSubscribe to continue reading this article.';

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

  it('first_seen emits paywalled=true and writes it onto the new record', async () => {
    const articleUrl = 'https://paywalled.example.com/first';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(PAYWALL_BODY) },
    });
    const fetchItem = fetchItemFor({
      8001: { id: 8001, type: 'story', url: articleUrl, score: 10 },
    });
    const store = createTestStore();
    const client = createFakeClient([{ text: 'summary v1' }]);
    const { logger, stories } = captureLogger();
    const res = await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [8001],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
    });
    expect(res.status).toBe(200);
    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('first_seen');
    expect(article.paywalled).toBe(true);
    expect(store.map.get(8001)!.paywalled).toBe(true);
  });

  it('first_seen emits paywalled=false for real article content', async () => {
    const articleUrl = 'https://example.com/real';
    const realBody =
      'The tram lines curved past the market square as the rain came on. '.repeat(30);
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(realBody) },
    });
    const fetchItem = fetchItemFor({
      8002: { id: 8002, type: 'story', url: articleUrl, score: 10 },
    });
    const store = createTestStore();
    const { logger, stories } = captureLogger();
    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [8002],
      createClient: () => createFakeClient([{ text: 'summary' }]),
      store,
      commentsStore: createCommentsTestStore(),
      logger,
    });
    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('first_seen');
    expect(article.paywalled).toBe(false);
    expect(store.map.get(8002)!.paywalled).toBe(false);
  });

  it('unchanged emits paywalled from the fresh detection (authoritative) and writes it onto the record', async () => {
    const articleUrl = 'https://paywalled.example.com/stable';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(PAYWALL_BODY) },
    });
    const fetchItem = fetchItemFor({
      8003: { id: 8003, type: 'story', url: articleUrl, score: 10 },
    });
    const store = createTestStore();
    const priorNow = 1_700_000_000_000 - 60 * 60 * 1000;
    // Pre-seed a record with the same hash and no paywalled bit (as a
    // legacy record would look). The unchanged branch must detect
    // freshly and backfill `paywalled` onto both the log and the
    // stored record.
    store.map.set(8003, {
      summary: 'old summary',
      articleHash: hashArticle(PAYWALL_BODY),
      firstSeenAt: priorNow,
      summaryGeneratedAt: priorNow,
      lastCheckedAt: priorNow,
      lastChangedAt: priorNow,
    });
    const { logger, stories } = captureLogger();
    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [8003],
      createClient: () => createFakeClient([]),
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => 1_700_000_000_000,
    });
    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('unchanged');
    expect(article.paywalled).toBe(true);
    expect(store.map.get(8003)!.paywalled).toBe(true);
  });

  it('changed emits paywalled from the fresh detection and writes it onto the new record', async () => {
    const articleUrl = 'https://paywalled.example.com/flipped';
    const newBody = PAYWALL_BODY; // Fresh body looks like a paywall.
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(newBody) },
    });
    const fetchItem = fetchItemFor({
      8004: { id: 8004, type: 'story', url: articleUrl, score: 10 },
    });
    const store = createTestStore();
    const priorNow = 1_700_000_000_000 - 60 * 60 * 1000;
    // Pre-seed a record with a *different* hash (was a real article
    // before, now it's a paywall — e.g. the publisher flipped the
    // wall). The changed branch should run the detector fresh and
    // write true onto the new record.
    store.map.set(8004, {
      summary: 'old summary',
      articleHash: 'different-hash',
      firstSeenAt: priorNow,
      summaryGeneratedAt: priorNow,
      lastCheckedAt: priorNow,
      lastChangedAt: priorNow,
      paywalled: false,
    });
    const { logger, stories } = captureLogger();
    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [8004],
      createClient: () => createFakeClient([{ text: 'new summary' }]),
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => 1_700_000_000_000,
    });
    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('changed');
    expect(article.paywalled).toBe(true);
    expect(store.map.get(8004)!.paywalled).toBe(true);
  });

  it('omits paywalled on skipped_unreachable (no Jina fetch happened)', async () => {
    const articleUrl = 'https://example.com/broken';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { status: 500 },
    });
    const fetchItem = fetchItemFor({
      8005: { id: 8005, type: 'story', url: articleUrl, score: 10 },
    });
    const store = createTestStore();
    const { logger, stories } = captureLogger();
    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [8005],
      createClient: () => createFakeClient([]),
      store,
      commentsStore: createCommentsTestStore(),
      logger,
    });
    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('skipped_unreachable');
    expect(article).not.toHaveProperty('paywalled');
  });
});

describe('correction-keyword + lede helpers (article-track hypothesis instrumentation)', () => {
  // Pure-function tests for the helpers that feed the hypothesis log
  // fields. These don't exercise the cron round-trip — that's the
  // next describe — they pin the helpers' behaviour so a regression
  // can't silently flatten the signal.

  it('normalizeLede caps at 500 chars and collapses whitespace', () => {
    const long = 'a '.repeat(400) + 'TAIL';
    const norm = normalizeLede(long);
    expect(norm.length).toBeLessThanOrEqual(500);
    // Internal whitespace runs are collapsed to a single space, so
    // "a a a …" survives; the doubled spacing in the input doesn't.
    expect(norm.startsWith('a a a')).toBe(true);
    // Leading/trailing whitespace is stripped before slicing.
    expect(normalizeLede('   hello\n\nworld   ')).toBe('hello world');
  });

  it('hashLede is deterministic and indifferent to whitespace-only churn', () => {
    // The whole point of normalizing before hashing — a markdown
    // re-render that doubles a newline must not bump the lede hash.
    expect(hashLede('Hello   world')).toBe(hashLede('Hello world'));
    expect(hashLede('Hello world\n')).toBe(hashLede(' Hello world '));
    // But a real prefix change does flip the hash.
    expect(hashLede('Hello world')).not.toBe(hashLede('Goodbye world'));
  });

  it('countCorrectionKeywords picks up each correction-shaped phrase, case-insensitively', () => {
    const body = [
      '# Headline',
      '',
      'UPDATE: this is a correction',
      "Editor's note: we got it wrong",
      'Editorial note: again',
      'Clarification: more',
      'We regret the error',
      'Update: again',
      'Updated: also',
      'Correction: x',
    ].join('\n');
    expect(countCorrectionKeywords(body)).toEqual({
      // "UPDATE:" + "Update:" + "Updated:" → 3 in the update bucket
      // (case-insensitive; "updated:" matches the word-bounded prefix).
      update: 3,
      // Only "Correction: x" — the prose-form "this is a correction"
      // is missing the colon prefix, so it must not count. Pinning
      // this guards against a future regex loosening that would
      // create false positives on every article that uses the word
      // in its body.
      correction: 1,
      // "We regret the error" maps into the retraction bucket.
      retraction: 1,
      editorsNote: 2,
      clarification: 1,
    });
  });

  it('countCorrectionKeywords does not match inside non-prefix words', () => {
    // "the team updates the page nightly" must NOT match the
    // update bucket — only a word-bounded `Update:` / `Updated:`
    // prefix counts.
    expect(
      countCorrectionKeywords('the team updates the page nightly'),
    ).toEqual({
      update: 0,
      correction: 0,
      retraction: 0,
      editorsNote: 0,
      clarification: 0,
    });
  });

  it('countLinks counts markdown links once each', () => {
    const body =
      'see [one](https://a.example) and [two](http://b.example) and a [non-http](mailto:x)';
    expect(countLinks(body)).toBe(2);
  });
});

describe('warm-summaries — hypothesis-testing instrumentation', () => {
  // These tests cover the cache-strategy report's "measure first"
  // commit: title cache, ledeHash, bodySample, correctionKeywordCounts,
  // linkCount on the record, plus the matching titleChanged /
  // ledeChanged / correctionKeywordDelta / bodyDiffSample fields on
  // the warm-story log line. None of this gates regen yet — it's
  // pure measurement so we can answer the hypothesis questions in
  // reports/2026-04-29-cache-strategy.md from a week of Axiom data.
  const origGoogle = process.env.GOOGLE_API_KEY;
  const origJina = process.env.JINA_API_KEY;

  beforeEach(() => {
    process.env.GOOGLE_API_KEY = 'test-key';
    process.env.JINA_API_KEY = 'test-jina-key';
    delete process.env.CRON_SECRET;
  });
  afterEach(() => {
    if (origGoogle === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = origGoogle;
    if (origJina === undefined) delete process.env.JINA_API_KEY;
    else process.env.JINA_API_KEY = origJina;
  });

  it('first_seen persists title / ledeHash / bodySample / correctionKeywordCounts / linkCount on the record and emits linkCount on the log', async () => {
    const articleUrl = 'https://example.com/instrumented';
    const articleBody =
      'Lead paragraph for the article. ' +
      'See [link one](https://a.example) and [link two](https://b.example).';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(articleBody) },
    });
    const fetchItem = fetchItemFor({
      7001: {
        id: 7001,
        type: 'story',
        url: articleUrl,
        title: 'Original headline',
        score: 50,
      },
    });
    const store = createTestStore();
    const client = createFakeClient([{ text: 'summary' }]);
    const { logger, stories } = captureLogger();

    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [7001],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => 1_700_000_000_000,
    });

    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('first_seen');
    // first_seen has no prior, so titleChanged / ledeChanged are
    // omitted; linkCount fires regardless because the prior-vs-now
    // comparison isn't required to emit the absolute count.
    expect(article).not.toHaveProperty('titleChanged');
    expect(article).not.toHaveProperty('ledeChanged');
    expect(article).not.toHaveProperty('correctionKeywordDelta');
    expect(article.linkCount).toBe(2);
    expect(article).not.toHaveProperty('linkCountDelta');

    const record = store.map.get(7001)!;
    expect(record.title).toBe('Original headline');
    expect(record.ledeHash).toBe(hashLede(articleBody));
    expect(record.bodySample).toBe(articleBody.slice(0, 1000));
    expect(record.correctionKeywordCounts).toEqual({
      update: 0,
      correction: 0,
      retraction: 0,
      editorsNote: 0,
      clarification: 0,
    });
    expect(record.linkCount).toBe(2);
  });

  it('unchanged: emits titleChanged when HN edited the title under a stable body (no raw title strings in logs)', async () => {
    // Title-only edits (HN mods clean up tags / case) leave the body
    // hash alone but flip story.title. We persist the new title in
    // Redis and emit a `titleChanged: true` boolean on the log so an
    // analyst can see how often this happens versus genuine
    // corrections — the raw title strings stay out of logs per
    // OBSERVABILITY.md.
    const articleUrl = 'https://example.com/title-edit';
    const body = 'stable body bytes';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(body) },
    });
    const fetchItem = fetchItemFor({
      7002: {
        id: 7002,
        type: 'story',
        url: articleUrl,
        title: 'New cleaned-up title',
        score: 10,
      },
    });
    const store = createTestStore();
    const firstSeenAt = 1_000_000_000_000;
    store.map.set(7002, {
      summary: 'old',
      articleHash: hashArticle(body),
      firstSeenAt,
      summaryGeneratedAt: firstSeenAt,
      lastCheckedAt: firstSeenAt,
      lastChangedAt: firstSeenAt,
      title: '[OLD] tag-prefixed title',
      ledeHash: hashLede(body),
      bodySample: body,
      correctionKeywordCounts: {
        update: 0,
        correction: 0,
        retraction: 0,
        editorsNote: 0,
        clarification: 0,
      },
      linkCount: 0,
    });
    const client = createFakeClient([]); // must NOT regen on a title-only change
    const { logger, stories } = captureLogger();
    const now = firstSeenAt + 45 * MINUTES;

    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [7002],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => now,
    });

    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('unchanged');
    expect(client.models.generateContent).not.toHaveBeenCalled();
    // Boolean signal only — the title strings themselves are
    // deliberately not surfaced to logs (see OBSERVABILITY.md
    // § *Deliberately not logged*). The previous / current titles
    // stay in the SummaryRecord cache for tick-over-tick comparison.
    expect(article.titleChanged).toBe(true);
    expect(article).not.toHaveProperty('previousTitle');
    expect(article).not.toHaveProperty('currentTitle');
    expect(article.ledeChanged).toBe(false);
    expect(article).not.toHaveProperty('correctionKeywordDelta');
    expect(article.linkCount).toBe(0);
    expect(article.linkCountDelta).toBe(0);
    // The new title is persisted in Redis so the next tick has
    // fresh truth — the cache is the only place the title strings
    // live.
    expect(store.map.get(7002)!.title).toBe('New cleaned-up title');
  });

  it('unchanged: omits titleChanged when prior had no title (legacy record), but still backfills the new fields', async () => {
    // Pre-instrumentation records lack `title` / `ledeHash` / etc.
    // The first post-deploy tick must NOT emit a spurious
    // titleChanged or ledeChanged signal — there's no prior to
    // compare against. The record write should backfill so the
    // next tick has data.
    const articleUrl = 'https://example.com/legacy';
    const body = 'legacy stable body';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(body) },
    });
    const fetchItem = fetchItemFor({
      7003: {
        id: 7003,
        type: 'story',
        url: articleUrl,
        title: 'Some title',
        score: 10,
      },
    });
    const store = createTestStore();
    const firstSeenAt = 1_000_000_000_000;
    store.map.set(7003, {
      summary: 'old',
      articleHash: hashArticle(body),
      firstSeenAt,
      summaryGeneratedAt: firstSeenAt,
      lastCheckedAt: firstSeenAt,
      lastChangedAt: firstSeenAt,
    });
    const client = createFakeClient([]);
    const { logger, stories } = captureLogger();

    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [7003],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => firstSeenAt + 45 * MINUTES,
    });

    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('unchanged');
    expect(article).not.toHaveProperty('titleChanged');
    expect(article).not.toHaveProperty('ledeChanged');
    expect(article).not.toHaveProperty('linkCountDelta');
    // Backfill: next tick will have a baseline.
    const updated = store.map.get(7003)!;
    expect(updated.title).toBe('Some title');
    expect(updated.ledeHash).toBe(hashLede(body));
    expect(updated.bodySample).toBe(body);
    expect(updated.linkCount).toBe(0);
  });

  it('legacy record with correction-shaped body does not emit a spurious correctionKeywordDelta on the first post-deploy tick', async () => {
    // Regression guard: a pre-instrumentation record has no
    // `correctionKeywordCounts`, so diffing against an implicit zero
    // baseline would report `update: 1` on every story whose body
    // already contained "Update:" before we deployed the
    // instrumentation — exactly the data we're trying to clean.
    // The fix: require the prior to have persisted counts before
    // emitting any delta.
    const articleUrl = 'https://example.com/legacy-correction-banner';
    const body = '# Headline\n\nUpdate: this banner was always here.';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(body) },
    });
    const fetchItem = fetchItemFor({
      7006: {
        id: 7006,
        type: 'story',
        url: articleUrl,
        title: 'Headline',
        score: 10,
      },
    });
    const store = createTestStore();
    const firstSeenAt = 1_000_000_000_000;
    // Legacy record: body hash matches but no instrumentation fields.
    store.map.set(7006, {
      summary: 'old',
      articleHash: hashArticle(body),
      firstSeenAt,
      summaryGeneratedAt: firstSeenAt,
      lastCheckedAt: firstSeenAt,
      lastChangedAt: firstSeenAt,
    });
    const client = createFakeClient([]);
    const { logger, stories } = captureLogger();

    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [7006],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => firstSeenAt + 45 * MINUTES,
    });

    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('unchanged');
    // The body has "Update:" → countCorrectionKeywords returns
    // { update: 1 }. But the prior had no counts to compare
    // against, so we must not emit a delta. The fresh counts get
    // backfilled onto the record for next tick.
    expect(article).not.toHaveProperty('correctionKeywordDelta');
    expect(store.map.get(7006)!.correctionKeywordCounts).toEqual({
      update: 1,
      correction: 0,
      retraction: 0,
      editorsNote: 0,
      clarification: 0,
    });
  });

  it('empty current title: does not emit titleChanged and preserves the prior persisted title', async () => {
    // Regression guard: HNItem.title is optional, and a story whose
    // title is briefly missing (or refetched as empty) should not
    // (a) emit titleChanged with currentTitle: "" — that would log
    // a "change" repeatedly because we don't overwrite the cached
    // title with empty — nor (b) erase the previously-stored title
    // on the persisted record.
    const articleUrl = 'https://example.com/empty-title-blip';
    const body = 'stable body';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(body) },
    });
    const fetchItem = fetchItemFor({
      7007: {
        id: 7007,
        type: 'story',
        url: articleUrl,
        // No title key at all — common shape from the HN API when
        // a story is in flight.
        score: 10,
      },
    });
    const store = createTestStore();
    const firstSeenAt = 1_000_000_000_000;
    store.map.set(7007, {
      summary: 'old',
      articleHash: hashArticle(body),
      firstSeenAt,
      summaryGeneratedAt: firstSeenAt,
      lastCheckedAt: firstSeenAt,
      lastChangedAt: firstSeenAt,
      title: 'Original cached title',
      ledeHash: hashLede(body),
      bodySample: body,
      correctionKeywordCounts: {
        update: 0,
        correction: 0,
        retraction: 0,
        editorsNote: 0,
        clarification: 0,
      },
      linkCount: 0,
    });
    const client = createFakeClient([]);
    const { logger, stories } = captureLogger();

    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [7007],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => firstSeenAt + 45 * MINUTES,
    });

    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('unchanged');
    expect(article).not.toHaveProperty('titleChanged');
    // The persisted title must survive the empty blip, so the next
    // tick (when HN returns the title again) doesn't see this as a
    // brand-new title.
    expect(store.map.get(7007)!.title).toBe('Original cached title');
  });

  it('changed: emits ledeChanged + correctionKeywordDelta on a small-delta correction edit (boolean / count signals only — no body samples in logs)', async () => {
    const articleUrl = 'https://example.com/correction';
    const oldBody = 'Original opening sentence. Body of the article.';
    const newBody =
      'Correction: the original was wrong. Body of the article.';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(newBody) },
    });
    const fetchItem = fetchItemFor({
      7004: {
        id: 7004,
        type: 'story',
        url: articleUrl,
        title: 'Headline',
        score: 10,
      },
    });
    const store = createTestStore();
    const firstSeenAt = 1_000_000_000_000;
    store.map.set(7004, {
      summary: 'old summary',
      articleHash: hashArticle(oldBody),
      firstSeenAt,
      summaryGeneratedAt: firstSeenAt,
      lastCheckedAt: firstSeenAt,
      lastChangedAt: firstSeenAt,
      contentBytes: Buffer.byteLength(oldBody, 'utf8'),
      title: 'Headline',
      ledeHash: hashLede(oldBody),
      bodySample: oldBody,
      correctionKeywordCounts: {
        update: 0,
        correction: 0,
        retraction: 0,
        editorsNote: 0,
        clarification: 0,
      },
      linkCount: 0,
    });
    const client = createFakeClient([{ text: 'corrected summary' }]);
    const { logger, stories } = captureLogger();
    const now = firstSeenAt + 45 * MINUTES;

    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [7004],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => now,
    });

    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('changed');
    expect(article.deltaBytes).toBeLessThan(256);
    expect(article.ledeChanged).toBe(true);
    expect(article.correctionKeywordDelta).toEqual({
      update: 0,
      correction: 1,
      retraction: 0,
      editorsNote: 0,
      clarification: 0,
    });
    expect(article.titleChanged).toBe(false);

    const updated = store.map.get(7004)!;
    expect(updated.correctionKeywordCounts).toEqual({
      update: 0,
      correction: 1,
      retraction: 0,
      editorsNote: 0,
      clarification: 0,
    });
    expect(updated.ledeHash).toBe(hashLede(newBody));
    // bodySample stays in Redis — it's the per-record cache, not
    // the log line. Logs deliberately don't carry article body
    // text (OBSERVABILITY.md § *Deliberately not logged*).
    expect(updated.bodySample).toBe(newBody);
  });

  it('warm-story log lines never carry verbatim article body text or title strings', async () => {
    // Lock the OBSERVABILITY.md § *Deliberately not logged* contract
    // for the article track: only boolean / hash / count signals
    // surface to logs, never raw title or body content. If a future
    // change adds a verbatim-content field to StoryLog, this test
    // catches it before the policy drift ships.
    const articleUrl = 'https://example.com/policy-guard';
    const oldBody = 'Some article opening line. Rest of the article.';
    const newBody = 'Update: Some article opening line. Rest of the article.';
    const fetchImpl = createFakeFetch({
      [`https://r.jina.ai/${articleUrl}`]: { body: jinaBody(newBody) },
    });
    const fetchItem = fetchItemFor({
      7008: {
        id: 7008,
        type: 'story',
        url: articleUrl,
        title: 'Updated headline',
        score: 10,
      },
    });
    const store = createTestStore();
    const firstSeenAt = 1_000_000_000_000;
    store.map.set(7008, {
      summary: 'old',
      articleHash: hashArticle(oldBody),
      firstSeenAt,
      summaryGeneratedAt: firstSeenAt,
      lastCheckedAt: firstSeenAt,
      lastChangedAt: firstSeenAt,
      contentBytes: Buffer.byteLength(oldBody, 'utf8'),
      title: 'Original headline',
      ledeHash: hashLede(oldBody),
      bodySample: oldBody,
      correctionKeywordCounts: {
        update: 0,
        correction: 0,
        retraction: 0,
        editorsNote: 0,
        clarification: 0,
      },
      linkCount: 0,
    });
    const client = createFakeClient([{ text: 'fresh summary' }]);
    const { logger, stories } = captureLogger();

    await handleWarmRequest(makeRequest({ secret: null }), {
      fetchImpl,
      fetchItem,
      fetchFeedIds: async () => [7008],
      createClient: () => client,
      store,
      commentsStore: createCommentsTestStore(),
      logger,
      now: () => firstSeenAt + 45 * MINUTES,
    });

    const article = stories.find((s) => s.track === 'article')!;
    expect(article.outcome).toBe('changed');
    expect(article.titleChanged).toBe(true);
    // The forbidden fields. Adding any of these to StoryLog without
    // updating OBSERVABILITY.md is a policy regression.
    expect(article).not.toHaveProperty('previousTitle');
    expect(article).not.toHaveProperty('currentTitle');
    expect(article).not.toHaveProperty('bodyDiffSample');
    expect(article).not.toHaveProperty('bodySample');
    // No log field should contain raw HN title text or article body
    // bytes either.
    const serialized = JSON.stringify(article);
    expect(serialized).not.toContain('Updated headline');
    expect(serialized).not.toContain('Original headline');
    expect(serialized).not.toContain('Some article opening line');
    expect(serialized).not.toContain('Update: Some article');
  });

  it('SummaryRecord parser round-trips the new fields and tolerates legacy records', async () => {
    // Indirect coverage of the parser: round-trip a record through
    // the redis-shaped `set` → `get` path the cron uses, asserting
    // the new fields survive intact AND that a record without them
    // still parses (legacy compatibility).
    const fullBody = 'Hello world. See [a](https://x.example).';
    const fullCounts = countCorrectionKeywords(fullBody);
    const full: SummaryRecord = {
      summary: 's',
      articleHash: hashArticle(fullBody),
      firstSeenAt: 1,
      summaryGeneratedAt: 1,
      lastCheckedAt: 1,
      lastChangedAt: 1,
      contentBytes: Buffer.byteLength(fullBody, 'utf8'),
      title: 'A title',
      ledeHash: hashLede(fullBody),
      bodySample: fullBody,
      correctionKeywordCounts: fullCounts,
      linkCount: countLinks(fullBody),
    };
    // Same shape Upstash hands us — JSON-parse round-trip via the
    // store's own contract.
    const store = createTestStore();
    await store.set(1, full, 60);
    const got = await store.get(1);
    expect(got).toEqual(full);

    // Legacy: drop every new field; parser must still accept.
    const legacy: SummaryRecord = {
      summary: 's',
      articleHash: 'h',
      firstSeenAt: 1,
      summaryGeneratedAt: 1,
      lastCheckedAt: 1,
      lastChangedAt: 1,
    };
    await store.set(2, legacy, 60);
    const back = await store.get(2);
    expect(back).toEqual(legacy);
  });
});
