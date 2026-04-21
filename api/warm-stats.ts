import { Redis } from '@upstash/redis';

// Read-only snapshot of today's warm outcome counters. Intended for
// manual triage via curl — "is warming dropping a lot into error:gemini?",
// "are we hitting the budget cap?" — not for dashboards. Keep this tiny
// and un-opinionated; Vercel logs remain the primary channel for
// per-event detail.
//
// See SUMMARIES.md § "Server-side warming on visibility" for the error
// taxonomy.

const WARM_COUNTER_PREFIX = 'newshacker:warm:counter:';
const WARM_BUDGET_PREFIX = 'newshacker:warm:budget:';

// The set of outcomes warm-summaries emits, plus request-level
// counters. Kept here as a single source of truth for what this endpoint
// reads and returns; if a new outcome is added in warm-summaries, add it
// here too so it surfaces in the snapshot.
export const TRACKED_OUTCOMES = [
  'generated',
  'cached',
  'skip:dedup',
  'skip:no-url',
  'skip:low-score',
  'skip:dead',
  'skip:missing-item',
  'skip:budget',
  'error:firebase',
  'error:gemini',
  'ratelimit',
  'invalid',
] as const;

export type TrackedOutcome = (typeof TRACKED_OUTCOMES)[number];

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

function isAllowedReferer(referer: string | null): boolean {
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

export interface WarmStatsKv {
  get(key: string): Promise<string | null>;
}

let defaultKv: WarmStatsKv | null | undefined;

function createDefaultKv(): WarmStatsKv | null {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const redis = new Redis({ url, token });
  return {
    async get(key) {
      try {
        const value = await redis.get<string | number>(key);
        if (value === null || value === undefined) return null;
        return String(value);
      } catch {
        return null;
      }
    },
  };
}

function getDefaultKv(): WarmStatsKv | null {
  if (defaultKv === undefined) defaultKv = createDefaultKv();
  return defaultKv;
}

function dayKey(now: number): string {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
    },
  });
}

export interface WarmStatsDeps {
  kv?: WarmStatsKv | null;
  now?: () => number;
}

export async function handleWarmStatsRequest(
  request: Request,
  deps: WarmStatsDeps = {},
): Promise<Response> {
  if (!isAllowedReferer(request.headers.get('referer'))) {
    return json({ error: 'Forbidden' }, 403);
  }

  const kv = deps.kv === undefined ? getDefaultKv() : deps.kv;
  const now = deps.now ? deps.now() : Date.now();
  const day = dayKey(now);

  if (!kv) {
    return json({
      day,
      outcomes: {},
      budgetUsed: 0,
      redis: 'unavailable',
    });
  }

  const outcomeEntries = await Promise.all(
    TRACKED_OUTCOMES.map(async (outcome) => {
      const raw = await kv.get(`${WARM_COUNTER_PREFIX}${outcome}:${day}`);
      return [outcome, raw ? Number(raw) || 0 : 0] as const;
    }),
  );
  const outcomes: Record<string, number> = {};
  for (const [name, n] of outcomeEntries) {
    outcomes[name] = n;
  }

  const budgetRaw = await kv.get(`${WARM_BUDGET_PREFIX}${day}`);
  const budgetUsed = budgetRaw ? Number(budgetRaw) || 0 : 0;

  return json({
    day,
    outcomes,
    budgetUsed,
    redis: 'ok',
  });
}

export async function GET(request: Request): Promise<Response> {
  return handleWarmStatsRequest(request);
}
