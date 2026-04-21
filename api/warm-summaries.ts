import { Redis } from '@upstash/redis';
import { handleSummaryRequest, type SummaryDeps } from './summary';

// Warm the shared /api/summary cache for a batch of story ids. The client
// fires one of these per batch of stories that scrolled into (or near) the
// viewport. Because summaries live in a shared Redis store, the first
// viewer of a given story pays the Gemini cost and every subsequent viewer
// gets a cheap Redis hit — making this the right layer to warm from.
//
// This endpoint does NOT return summaries. It only returns per-id outcome
// codes so the work is observable in tests, logs, and a manual curl
// during triage. In production the client fires-and-forgets.
//
// See SUMMARIES.md § "Server-side warming on visibility" for the cost and
// reliability rationale (rule 11).

const MAX_IDS_PER_REQUEST = 30;

// How long a per-id "we recently attempted to warm this" marker lives.
// 5 min: short enough that stories entering the hot lists get warmed
// reasonably quickly by the next viewer, long enough that it absorbs a
// stampede from multiple fast-scrolling users and a stampede from
// IntersectionObserver firing repeatedly for the same row. Also acts as
// the negative cache for errors — /api/summary doesn't cache failures,
// so without this a broken article URL would retry-storm on every scroll.
const WARM_DEDUP_TTL_SECONDS = 5 * 60;

// Per-minute cap on warm requests from a single IP address. 60/min is
// well above a realistic scroll-generated rate (even an extremely fast
// scroller triggers at most a handful of batches per minute) but low
// enough that a scripted abuser can't use us as a free Gemini endpoint.
const RATE_LIMIT_REQUESTS_PER_MIN = 60;
const RATE_LIMIT_WINDOW_SECONDS = 90; // fixed-window, TTL'd slightly beyond 60s

// Daily ceiling on Gemini-invoking warm outcomes. A few thousand Flash-Lite
// calls sits comfortably inside normal hobby spend while giving a generous
// runway for hot feeds. Override via WARM_DAILY_BUDGET env var.
const DEFAULT_DAILY_BUDGET = 3000;
const BUDGET_TTL_SECONDS = 2 * 24 * 60 * 60;

const WARM_DEDUP_PREFIX = 'newshacker:warm:dedup:';
const WARM_RATELIMIT_PREFIX = 'newshacker:warm:ratelimit:';
const WARM_BUDGET_PREFIX = 'newshacker:warm:budget:';
const WARM_COUNTER_PREFIX = 'newshacker:warm:counter:';
const COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60;

const DEFAULT_ALLOWED_HOSTS = ['newshacker.app', 'hnews.app'];

function getAllowedHosts(): string[] {
  const fromEnv = process.env.SUMMARY_REFERER_ALLOWLIST;
  if (!fromEnv) return DEFAULT_ALLOWED_HOSTS;
  const parsed = fromEnv
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_ALLOWED_HOSTS;
}

export function isAllowedReferer(referer: string | null): boolean {
  if (!referer) return false;
  let host: string;
  try {
    host = new URL(referer).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '127.0.0.1') return true;
  if (host.endsWith('.vercel.app')) return true;
  return getAllowedHosts().some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

interface HNItem {
  id?: number;
  type?: string;
  title?: string;
  url?: string;
  score?: number;
  dead?: boolean;
  deleted?: boolean;
}

const HN_ITEM_URL = (id: number) =>
  `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

async function defaultFetchItem(
  id: number,
  signal?: AbortSignal,
): Promise<HNItem | null> {
  const res = await fetch(HN_ITEM_URL(id), { signal });
  if (!res.ok) return null;
  return (await res.json()) as HNItem | null;
}

export type WarmOutcome =
  | 'generated'
  | 'cached'
  | 'skip:dedup'
  | 'skip:no-url'
  | 'skip:low-score'
  | 'skip:dead'
  | 'skip:missing-item'
  | 'skip:budget'
  | 'error:firebase'
  | 'error:gemini';

// The Redis calls we make are narrow and specific — define a minimal
// interface so tests can supply an in-memory fake without constructing a
// real Upstash client. Matches the subset of the Upstash REST API we use.
export interface WarmKv {
  get(key: string): Promise<string | null>;
  // NX semantics: only set if the key does not exist. Returns true iff set.
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  // Atomic increment; returns the post-increment value. Sets TTL on first
  // increment only.
  incrWithTtl(key: string, ttlSeconds: number): Promise<number>;
}

let defaultKv: WarmKv | null | undefined;

function createDefaultKv(): WarmKv | null {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const redis = new Redis({ url, token });
  return {
    async get(key) {
      try {
        const value = await redis.get<string>(key);
        return value ?? null;
      } catch {
        return null;
      }
    },
    async setIfAbsent(key, value, ttlSeconds) {
      try {
        // Upstash `set` with `nx: true` returns 'OK' on success, null on
        // miss. The SDK types this as a union; coerce to boolean.
        const result = await redis.set(key, value, {
          nx: true,
          ex: ttlSeconds,
        });
        return result === 'OK';
      } catch {
        return false;
      }
    },
    async incrWithTtl(key, ttlSeconds) {
      try {
        const next = await redis.incr(key);
        if (next === 1) {
          // Best-effort TTL; if it fails the key will just live its
          // default lifetime (Upstash persists by default, so we'd get
          // an unbounded counter — accepted risk, the counter values
          // themselves aren't sensitive).
          await redis.expire(key, ttlSeconds);
        }
        return next;
      } catch {
        return 0;
      }
    },
  };
}

function getDefaultKv(): WarmKv | null {
  if (defaultKv === undefined) defaultKv = createDefaultKv();
  return defaultKv;
}

export interface WarmDeps {
  kv?: WarmKv | null;
  fetchItem?: (id: number, signal?: AbortSignal) => Promise<HNItem | null>;
  // Exposed so tests can assert against the downstream summary handler
  // without mocking Google/Jina. In production we call the real
  // handleSummaryRequest.
  invokeSummary?: (
    request: Request,
    deps: SummaryDeps,
  ) => Promise<Response>;
  now?: () => number;
  // Override via tests; in production comes from env.
  dailyBudget?: number;
}

function dayKey(now: number): string {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function minuteKey(now: number): string {
  return String(Math.floor(now / 60_000));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Warm responses are per-request work summaries — never cache them.
      'cache-control': 'private, no-store',
    },
  });
}

function parseIdsBody(value: unknown): number[] | null {
  if (!value || typeof value !== 'object') return null;
  const raw = (value as { ids?: unknown }).ids;
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0 || raw.length > MAX_IDS_PER_REQUEST) return null;
  const seen = new Set<number>();
  const out: number[] = [];
  for (const v of raw) {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
      return null;
    }
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function clientIp(request: Request): string {
  // Vercel puts the client IP in x-forwarded-for (comma-separated when
  // behind multiple proxies; the first entry is the real client).
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get('x-real-ip');
  if (real) return real.trim();
  // Last-resort bucket. Shared across all "unknown IP" callers, which is
  // fine — worst case they share one rate-limit allowance.
  return 'unknown';
}

async function recordOutcome(
  kv: WarmKv | null,
  outcome: string,
  now: number,
): Promise<void> {
  if (!kv) return;
  const key = `${WARM_COUNTER_PREFIX}${outcome}:${dayKey(now)}`;
  await kv.incrWithTtl(key, COUNTER_TTL_SECONDS);
}

async function checkRateLimit(
  kv: WarmKv | null,
  ip: string,
  now: number,
): Promise<boolean> {
  if (!kv) return true; // fail-open when Redis unavailable
  const key = `${WARM_RATELIMIT_PREFIX}${ip}:${minuteKey(now)}`;
  const next = await kv.incrWithTtl(key, RATE_LIMIT_WINDOW_SECONDS);
  return next <= RATE_LIMIT_REQUESTS_PER_MIN;
}

async function isBudgetExceeded(
  kv: WarmKv | null,
  now: number,
  limit: number,
): Promise<boolean> {
  if (!kv) return false;
  const key = `${WARM_BUDGET_PREFIX}${dayKey(now)}`;
  const current = await kv.get(key);
  if (!current) return false;
  const n = Number(current);
  return Number.isFinite(n) && n >= limit;
}

async function chargeBudget(
  kv: WarmKv | null,
  now: number,
): Promise<void> {
  if (!kv) return;
  const key = `${WARM_BUDGET_PREFIX}${dayKey(now)}`;
  await kv.incrWithTtl(key, BUDGET_TTL_SECONDS);
}

// Claim the dedup slot for this id. Returns true iff we are the first
// caller within the 5-min window — the caller that gets `true` is the one
// that actually performs the warm.
async function claimDedup(
  kv: WarmKv | null,
  id: number,
): Promise<boolean> {
  if (!kv) return true; // no Redis = no dedup, just proceed
  const key = `${WARM_DEDUP_PREFIX}${id}`;
  return kv.setIfAbsent(key, '1', WARM_DEDUP_TTL_SECONDS);
}

interface ItemFilter {
  outcome: WarmOutcome | null;
}

function filterItem(item: HNItem | null): ItemFilter {
  if (!item) return { outcome: 'skip:missing-item' };
  if (item.dead || item.deleted) return { outcome: 'skip:dead' };
  if (!item.url) return { outcome: 'skip:no-url' };
  if ((item.score ?? 0) <= 0) return { outcome: 'skip:low-score' };
  return { outcome: null };
}

async function warmOne(
  id: number,
  request: Request,
  deps: WarmDeps,
  kv: WarmKv | null,
  now: number,
  dailyBudget: number,
): Promise<WarmOutcome> {
  // Order matters:
  // 1. Dedup first — cheapest check, absorbs IO-observer storms before any
  //    HN or Gemini cost.
  // 2. HN item fetch — needed to apply score/url filters.
  // 3. Filter — cheap, decides whether we ever call Gemini.
  // 4. Budget check — only gate on budget once we know the request would
  //    actually invoke Gemini; over-budget requests for already-cached
  //    summaries would be a false negative.
  // 5. Delegate to /api/summary logic, which handles its own Redis cache
  //    lookup before touching Gemini.

  const claimed = await claimDedup(kv, id);
  if (!claimed) return 'skip:dedup';

  const fetchItem = deps.fetchItem ?? defaultFetchItem;
  let item: HNItem | null;
  try {
    item = await fetchItem(id, request.signal);
  } catch {
    return 'error:firebase';
  }

  const filter = filterItem(item);
  if (filter.outcome) return filter.outcome;

  if (await isBudgetExceeded(kv, now, dailyBudget)) {
    return 'skip:budget';
  }

  const referer = request.headers.get('referer') ?? '';
  const syntheticUrl = `https://newshacker.app/api/summary?id=${id}`;
  const headers = new Headers();
  if (referer) headers.set('referer', referer);
  const syntheticRequest = new Request(syntheticUrl, { headers });

  // Reuse the already-fetched item — handleSummaryRequest would otherwise
  // hit Firebase a second time for this id.
  const summaryDeps: SummaryDeps = {
    fetchItem: async (needId) => (needId === id ? item : null),
  };

  const invoke = deps.invokeSummary ?? handleSummaryRequest;
  let response: Response;
  try {
    response = await invoke(syntheticRequest, summaryDeps);
  } catch {
    return 'error:gemini';
  }

  if (response.status !== 200) {
    // Dedup marker is already set, so the failed id won't retry-storm
    // until the 5-min window expires — our negative cache.
    return 'error:gemini';
  }

  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return 'error:gemini';
  }

  const wasCached = !!(body && (body as { cached?: unknown }).cached);
  if (!wasCached) {
    // Charge the budget only when Gemini actually ran. Cache hits don't
    // cost anything so there's no reason to debit them.
    await chargeBudget(kv, now);
    return 'generated';
  }
  return 'cached';
}

export async function handleWarmSummariesRequest(
  request: Request,
  deps: WarmDeps = {},
): Promise<Response> {
  const now = deps.now ? deps.now() : Date.now();

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  if (!isAllowedReferer(request.headers.get('referer'))) {
    return json({ error: 'Forbidden' }, 403);
  }

  const kv = deps.kv === undefined ? getDefaultKv() : deps.kv;
  const dailyBudget =
    deps.dailyBudget ??
    Number(process.env.WARM_DAILY_BUDGET ?? DEFAULT_DAILY_BUDGET);

  const ip = clientIp(request);
  const withinRate = await checkRateLimit(kv, ip, now);
  if (!withinRate) {
    await recordOutcome(kv, 'ratelimit', now);
    return json({ error: 'Rate limit exceeded' }, 429);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    await recordOutcome(kv, 'invalid', now);
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const ids = parseIdsBody(payload);
  if (!ids) {
    await recordOutcome(kv, 'invalid', now);
    return json({ error: 'Invalid ids in request body' }, 400);
  }

  // Warm ids in parallel. Each warmOne already awaits its own work, so
  // Promise.all bounds total wall-clock by the slowest Gemini call —
  // usually well under 3s for ~10 ids, comfortably inside Vercel's
  // default 10s function timeout. If we ever hit the ceiling, either cap
  // MAX_IDS_PER_REQUEST lower or switch to Edge runtime with waitUntil.
  const outcomes = await Promise.all(
    ids.map(async (id) => {
      const outcome = await warmOne(id, request, deps, kv, now, dailyBudget);
      await recordOutcome(kv, outcome, now);
      return [id, outcome] as const;
    }),
  );

  const results: Record<string, WarmOutcome> = {};
  for (const [id, outcome] of outcomes) {
    results[String(id)] = outcome;
  }
  return json({ results });
}

export async function POST(request: Request): Promise<Response> {
  return handleWarmSummariesRequest(request);
}
