import { Redis } from '@upstash/redis';

// Self-hosted joint-distribution collector for summary-card layout telemetry.
// Vercel Web Analytics only exposes marginal breakdowns per custom-event
// property (and only at Pro-tier or above), so it can't answer "what's the
// delta_h distribution on phone-width cards for article summaries?" — which
// is the question we actually need to answer when tuning the skeleton
// reservation constants in Thread.tsx. This endpoint receives the same
// payload the Vercel `track()` call already builds, and increments a
// single Redis hash field per joint bucket. The reader script
// `scripts/analyze-summary-layout.mjs` aggregates the hash offline.
//
// Inlined from api/summary.ts: the referer allowlist, the env-var pair
// resolution, and the lazy store bootstrap. See AGENTS.md § "Vercel
// `api/` gotchas" and api/imports.test.ts for why helpers must stay
// inlined even when duplicated.

const COUNTS_KEY = 'newshacker:summary_layout:counts';
const FIELD_DELIM = '|';

const ALLOWED_KINDS = ['article', 'comments'] as const;
type Kind = (typeof ALLOWED_KINDS)[number];

// Clamp on any incoming numeric value. A client can't explode the hash
// cardinality (HLEN grows by one per unique field) beyond what our own
// bucket20() client-side rounding would naturally produce. 100k px / chars
// is far beyond any real viewport or summary length.
const MAX_ABS_NUMERIC = 100_000;
// Insight counts above this are implausible (the prompt caps at 5). Anything
// higher is bad input, not a bucket we care about.
const MAX_INSIGHT_COUNT = 50;
// Server-side bucketing. The client already rounds to the nearest 20 (see
// bucket20 in src/lib/analytics.ts), but a non-browser caller could send
// arbitrary fractional values in the accepted magnitude range and inflate
// the hash field count until Redis cost becomes a concern. Re-bucketing
// here makes the bucket grid a handler invariant instead of a client
// convention.
const BUCKET = 20;
function toBucket(n: number): number {
  return Math.round(n / BUCKET) * BUCKET;
}

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

export interface TelemetryPayload {
  kind: Kind;
  card_w: number;
  summary_chars: number;
  reserved_h: number;
  rendered_h: number;
  delta_h: number;
  insight_count?: number;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function validatePayload(raw: unknown): TelemetryPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!ALLOWED_KINDS.includes(r.kind as Kind)) return null;
  // card_w, summary_chars, and the two content heights are measurements
  // of real UI state and cannot be negative. delta_h = rendered - reserved
  // is the one legitimately-signed field.
  const nonNegFields = [
    'card_w',
    'summary_chars',
    'reserved_h',
    'rendered_h',
  ] as const;
  const out: Partial<TelemetryPayload> & { kind: Kind } = { kind: r.kind as Kind };
  for (const f of nonNegFields) {
    const v = r[f];
    if (!isFiniteNumber(v) || v < 0 || v > MAX_ABS_NUMERIC) return null;
    out[f] = toBucket(v);
  }
  const delta = r.delta_h;
  if (!isFiniteNumber(delta) || Math.abs(delta) > MAX_ABS_NUMERIC) return null;
  out.delta_h = toBucket(delta);
  if (r.insight_count !== undefined) {
    const v = r.insight_count;
    if (
      !isFiniteNumber(v) ||
      !Number.isInteger(v) ||
      v < 0 ||
      v > MAX_INSIGHT_COUNT
    ) {
      return null;
    }
    out.insight_count = v;
  }
  return out as TelemetryPayload;
}

// Field encoding is order-sensitive; the analyzer script parses these
// positionally. Empty trailing slot when insight_count is absent keeps
// article- and comments-kind fields split by kind in the hash.
export function fieldFor(p: TelemetryPayload): string {
  return [
    p.kind,
    p.card_w,
    p.summary_chars,
    p.reserved_h,
    p.rendered_h,
    p.delta_h,
    p.insight_count ?? '',
  ].join(FIELD_DELIM);
}

export interface TelemetryStore {
  incr(field: string): Promise<void>;
}

let defaultStore: TelemetryStore | null | undefined;

function createDefaultStore(): TelemetryStore | null {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const redis = new Redis({ url, token });
  return {
    async incr(field) {
      try {
        await redis.hincrby(COUNTS_KEY, field, 1);
      } catch {
        // Fail-open: a missed counter increment is no worse than the
        // event having never fired. The endpoint still 204s.
      }
    },
  };
}

function getDefaultStore(): TelemetryStore | null {
  if (defaultStore === undefined) defaultStore = createDefaultStore();
  return defaultStore;
}

// Test hook — resets the memoized lazy store so env-var changes in one
// test don't leak into the next.
export function _resetDefaultStoreForTests(): void {
  defaultStore = undefined;
}

export interface TelemetryDeps {
  // `null` = explicitly disable the store for this request;
  // `undefined` = use the default (lazy-initialised) Upstash store.
  store?: TelemetryStore | null;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
    },
  });
}

export async function handleTelemetryRequest(
  request: Request,
  deps: TelemetryDeps = {},
): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  if (!isAllowedReferer(request.headers.get('referer'))) {
    return json({ error: 'Forbidden' }, 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const payload = validatePayload(body);
  if (!payload) {
    return json({ error: 'Invalid payload' }, 400);
  }

  const store = deps.store === undefined ? getDefaultStore() : deps.store;
  if (store) {
    try {
      await store.incr(fieldFor(payload));
    } catch {
      // Fail-open at the handler too; the inner store implementation
      // already catches, but a future store might not.
    }
  }
  return new Response(null, {
    status: 204,
    headers: { 'cache-control': 'private, no-store' },
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleTelemetryRequest(request);
}
