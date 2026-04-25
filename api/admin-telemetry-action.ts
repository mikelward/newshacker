// POST /api/admin-telemetry-action — operator-only telemetry sink
// for "what score and age was this story when I first pinned or
// hid it?", used to tune the `isHotStory` thresholds in
// `src/lib/format.ts`. See SPEC.md *Hot threshold tuning* and
// TODO.md *Threshold tuning telemetry*.
//
// Auth model is deliberately env-dependent:
//   - production: requires the `hn_session` cookie. The username is
//     read straight off the cookie's `username&hash` prefix — no HN
//     round-trip on this hot path. The `/api/admin` round-trip
//     pattern exists to defend sensitive *reads* (Jina balances,
//     etc.) against a forged cookie; for an append-only telemetry
//     write, the worst case of accepting a forged cookie is "noise
//     in the operator's own dataset" — bad but not catastrophic,
//     and not worth doubling HN traffic over. The matching read
//     endpoint (`/api/admin-telemetry-events`) does still
//     round-trip because that one returns data.
//   - preview: accept anonymous events too. The Vercel preview URL
//     is the operator's own staging area, so collecting from any
//     visitor is fine and helps top up sparse datasets. Anonymous
//     events bucket together under the `preview:anon` key so they
//     can't pollute the production-keyed records.
//   - development / test: 503 — no telemetry path during local
//     dev or unit tests, so a forgotten flag can't pile up junk
//     events into a dev's local Redis if they're sharing one.
//
// Storage shape is one Redis list per bucket:
//   `telemetry:user:<username>` (any logged-in user, in any env)
//   `telemetry:preview:anon`    (preview only, anon visitors)
//
// Per-user buckets are *not* env-prefixed: they follow the same
// pattern as `api/sync.ts`'s `newshacker:sync:<username>`, which
// shares pinned/favorite/hidden lists across prod and preview
// already. So a logged-in user pinning from a preview deploy
// contributes to their same per-user bucket — preview is just
// "the same app, different URL", not a separate identity. The
// `preview:anon` bucket is the dumping ground for anonymous
// visitors that only the preview env accepts at all.
//
// Each entry is a JSON-encoded `TelemetryEvent`. We `LPUSH` at the
// head, then `LTRIM` to a hard cap so a runaway client can't
// fill the database. The `/admin` reader pulls newest-first via
// `LRANGE 0 -1`.
//
// Cost (rule 11): a single `LPUSH` + `LTRIM` per pin or hide that
// the client decides to emit (post-dedup). At ~50 actions/day for
// a heavy user that's ~100 Redis ops, well under the Upstash free
// tier's 500k/day limit. Reliability: failures are 5xx; the client
// is fire-and-forget and never blocks a pin or hide on the
// telemetry round-trip.
//
// Per AGENTS.md *Vercel api/ gotchas* — these helpers are
// copy-pasted from `api/admin.ts` rather than imported, because
// Vercel's bundler drops cross-file imports inside `api/`. The
// `api/imports.test.ts` regression test enforces this. Keep the
// two copies in sync; if you find the duplication painful, you
// have a worse problem (it's been tried twice and broken in
// production both times).

import { Redis } from '@upstash/redis';

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'hn_session';
const HN_USERNAME_RE = /^[a-zA-Z0-9_-]{2,32}$/;

// Cap each Redis list at the most recent 10k events. At 50/day
// that's 200 days of history; the tuning question doesn't need
// more. Trimming on every write keeps the cap honest even if a
// run-away client emits faster than it should.
const MAX_EVENTS_PER_BUCKET = 10_000;

// Reasonable upper bounds on the body fields. Every other rejection
// returns 400 so the client knows to drop the event rather than
// retry forever, which a 5xx would imply.
const MAX_SOURCE_FEED_LEN = 32;
const VALID_ACTIONS = new Set(['pin', 'hide'] as const);
type Action = 'pin' | 'hide';

interface TelemetryEvent {
  action: Action;
  id: number;
  score: number;
  // Story `time` (epoch seconds) at the moment of action — paired
  // with `eventTime` (epoch ms) the reader can recompute the
  // story's age at action time as `eventTime/1000 - time`.
  time: number;
  isHot: boolean;
  sourceFeed: string;
  eventTime: number;
  // Optional fields — accepted on input, persisted as-is. Older
  // events recorded before these were added still parse cleanly
  // because every check below is "missing OR right type".
  descendants?: number;
  type?: string;
  articleOpened?: boolean;
  title?: string;
}

function parseCookieHeader(
  header: string | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const raw of header.split(';')) {
    const part = raw.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function usernameFromSessionValue(value: string | undefined): string | null {
  if (!value) return null;
  const amp = value.indexOf('&');
  const candidate = amp === -1 ? value : value.slice(0, amp);
  return HN_USERNAME_RE.test(candidate) ? candidate : null;
}

function deployEnv(): string {
  return process.env.VERCEL_ENV ?? 'development';
}

function hasRedisCredentials(): boolean {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return !!url && !!token;
}

function getRedis(): Redis {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('Redis credentials not configured');
  }
  return new Redis({ url, token });
}

function bucketKeyFor(env: string, username: string | null): string | null {
  // Per-user bucket follows `api/sync.ts`'s pattern — username-
  // keyed only, no env prefix — so a logged-in user contributes
  // to their own bucket whether they're on prod or a preview URL.
  if (username) return `telemetry:user:${username}`;
  // Anonymous events are accepted only on preview, where they
  // dump into a single shared bucket. Production rejects unauth'd
  // events at the caller above; dev/test rejects in `handle...`.
  if (env === 'preview') return 'telemetry:preview:anon';
  return null;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // Telemetry writes never want to be cached or revalidated.
      'cache-control': 'no-store',
    },
  });
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

// Validate the request body against the `TelemetryEvent` shape.
// Returns the parsed event on success, or a string error reason
// the handler echoes back as a 400 so the client knows to give up
// rather than retry.
function parseEvent(body: unknown): TelemetryEvent | string {
  if (!body || typeof body !== 'object') return 'body_not_object';
  const b = body as Record<string, unknown>;
  if (!VALID_ACTIONS.has(b.action as Action)) return 'invalid_action';
  if (!isFiniteNumber(b.id) || b.id <= 0) return 'invalid_id';
  // Range checks on top of finiteness so a malformed client can't
  // pollute Redis with negative scores or epoch-zero stories.
  if (!isFiniteNumber(b.score) || b.score < 0) return 'invalid_score';
  if (!isFiniteNumber(b.time) || b.time <= 0) return 'invalid_time';
  if (typeof b.isHot !== 'boolean') return 'invalid_isHot';
  if (typeof b.sourceFeed !== 'string') return 'invalid_sourceFeed';
  if (b.sourceFeed.length === 0 || b.sourceFeed.length > MAX_SOURCE_FEED_LEN) {
    return 'invalid_sourceFeed';
  }
  if (!isFiniteNumber(b.eventTime) || b.eventTime <= 0) {
    return 'invalid_eventTime';
  }
  // Optional fields: present + right-typed = accept; absent =
  // accept; present + wrong type = reject (a buggy client should
  // hear about it via 400 rather than have its field silently
  // dropped).
  if (b.descendants !== undefined) {
    if (!isFiniteNumber(b.descendants) || b.descendants < 0) {
      return 'invalid_descendants';
    }
  }
  if (b.type !== undefined) {
    if (typeof b.type !== 'string') return 'invalid_type';
    if (b.type.length === 0 || b.type.length > 16) return 'invalid_type';
  }
  if (b.articleOpened !== undefined && typeof b.articleOpened !== 'boolean') {
    return 'invalid_articleOpened';
  }
  if (b.title !== undefined) {
    if (typeof b.title !== 'string') return 'invalid_title';
    // Mirror the client cap so a buggy emitter can't push 1 MB
    // titles into the bucket.
    if (b.title.length > 256) return 'invalid_title';
  }
  return {
    action: b.action as Action,
    id: Math.trunc(b.id),
    score: b.score,
    time: b.time,
    isHot: b.isHot,
    sourceFeed: b.sourceFeed,
    eventTime: b.eventTime,
    descendants: b.descendants as number | undefined,
    type: b.type as string | undefined,
    articleOpened: b.articleOpened as boolean | undefined,
    title: b.title as string | undefined,
  };
}

export interface TelemetryActionDeps {
  env?: string;
  redis?: Redis;
}

export async function handleTelemetryAction(
  request: Request,
  deps: TelemetryActionDeps = {},
): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const env = deps.env ?? deployEnv();

  // Auth gate by env. Production requires the cookie (writes go to
  // the user bucket only); preview accepts anonymous writes too
  // (they bucket into `telemetry:preview:anon`) but still routes
  // logged-in preview writes into the user's own bucket — same
  // person, same data, regardless of which URL they happened to
  // hit. dev/test refuses to write at all.
  if (env !== 'production' && env !== 'preview') {
    return json(
      { error: 'Telemetry not enabled in this environment', env },
      503,
    );
  }
  const cookies = parseCookieHeader(request.headers.get('cookie'));
  const username = usernameFromSessionValue(cookies[SESSION_COOKIE_NAME]);
  if (env === 'production' && !username) {
    // Silently no-op — don't echo back "telemetry needs an auth
    // cookie" since the endpoint's existence is itself something
    // we'd rather not advertise to a casual prober. 204 reads as
    // "stored" from the client's perspective and the client
    // doesn't care either way (fire-and-forget).
    return new Response(null, { status: 204 });
  }
  const bucketKey = bucketKeyFor(env, username);

  if (!bucketKey) {
    return json({ error: 'No bucket for this request' }, 500);
  }

  if (!hasRedisCredentials()) {
    // Rare in deployed environments — Vercel auto-injects KV
    // creds — but a manually-deployed preview without the
    // Storage Marketplace integration could land here. Treat
    // like the dev-env case: return 503 so the client backs off.
    return json({ error: 'Telemetry storage not configured' }, 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = parseEvent(body);
  if (typeof parsed === 'string') {
    return json({ error: 'Bad request', reason: parsed }, 400);
  }

  const redis = deps.redis ?? getRedis();
  try {
    await redis.lpush(bucketKey, JSON.stringify(parsed));
    // Trim to keep only the most recent N. `0, N-1` keeps the head
    // (newest) and drops anything older than position N-1.
    await redis.ltrim(bucketKey, 0, MAX_EVENTS_PER_BUCKET - 1);
  } catch (err) {
    return json(
      {
        error: 'Telemetry storage write failed',
        reason: err instanceof Error ? err.message : String(err),
      },
      503,
    );
  }

  return new Response(null, { status: 204 });
}

export async function POST(request: Request): Promise<Response> {
  return handleTelemetryAction(request);
}
