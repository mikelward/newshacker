// GET /api/admin-telemetry-events — admin-only read of the
// threshold-tuning telemetry written by `/api/admin-telemetry-action`.
// Returns the per-user bucket for `ADMIN_USERNAME` (which contains
// events from any environment where that user was logged in — see
// the bucket-key comment in admin-telemetry-action.ts) and the
// preview anon bucket as separate arrays so the `/admin` view can
// tag each event with its source when plotting.
//
// This endpoint *does* HN-round-trip the cookie (unlike the POST
// sibling) because it returns operator data — the threat model is
// the same as `/api/admin`. Without the round-trip, anyone could
// set `hn_session=mikelward&anything` in devtools and read the
// telemetry buffer. Per AGENTS.md rule 13.
//
// Per AGENTS.md *Vercel api/ gotchas*, the cookie + HN-verify
// helpers are copy-pasted from `api/admin.ts` rather than
// imported. The `api/imports.test.ts` regression test enforces
// this.

import { Redis } from '@upstash/redis';
import { parse as parseHtml } from 'node-html-parser';

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'hn_session';
const HN_USERNAME_RE = /^[a-zA-Z0-9_-]{2,32}$/;
const HN_FRONT_URL = 'https://news.ycombinator.com/';
const HN_VERIFY_TIMEOUT_MS = 8_000;
const HN_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function adminUsername(): string {
  return process.env.ADMIN_USERNAME ?? 'mikelward';
}

function hnCookieName(): string {
  return process.env.HN_COOKIE_NAME ?? 'user';
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

interface HnVerifyResult {
  ok: boolean;
  username?: string;
  reason?: string;
  httpStatus?: number;
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'TimeoutError')
  );
}

// Find HN's "logged in as <user>" marker in the front-page HTML.
// HN renders this as `<a id="me" href="user?id=NAME">NAME</a>` for
// signed-in viewers; anonymous viewers get a `login?goto=…` link
// in the same slot, so the *href shape* is the unambiguous signal
// (the anchor text alone could be repurposed by a future HN
// layout). Mirrors api/admin.ts's parser-based implementation —
// kept inline rather than imported per AGENTS.md *Vercel api/
// gotchas* (handlers can't share modules).
function extractHnLoggedInUsername(html: string): string | null {
  const root = parseHtml(html);
  const me = root.querySelector('a#me');
  if (!me) return null;
  const href = me.getAttribute('href') ?? '';
  const match = /^user\?id=([a-zA-Z0-9_-]{2,32})$/.exec(href);
  return match ? match[1] : null;
}

async function verifyHnSession(sessionValue: string): Promise<HnVerifyResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HN_VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(HN_FRONT_URL, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        cookie: `${hnCookieName()}=${sessionValue}`,
        'user-agent': HN_USER_AGENT,
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) {
      return { ok: false, reason: `hn_status_${res.status}`, httpStatus: res.status };
    }
    const html = await res.text();
    const name = extractHnLoggedInUsername(html);
    if (!name) {
      return { ok: false, reason: 'not_logged_in', httpStatus: res.status };
    }
    return { ok: true, username: name, httpStatus: res.status };
  } catch (err) {
    return {
      ok: false,
      reason: isAbortError(err) ? 'timeout' : 'unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
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

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

interface RawEvent {
  action: 'pin' | 'hide';
  id: number;
  score: number;
  time: number;
  isHot: boolean;
  sourceFeed: string;
  eventTime: number;
  // Optional — older events stored before these were added still
  // parse cleanly because every check below is "missing OR
  // right type".
  descendants?: number;
  type?: string;
  articleOpened?: boolean;
  title?: string;
}

function tryParseEvent(raw: unknown): RawEvent | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Record<string, unknown>;
    if (p.action !== 'pin' && p.action !== 'hide') return null;
    if (typeof p.id !== 'number') return null;
    if (typeof p.score !== 'number') return null;
    if (typeof p.time !== 'number') return null;
    if (typeof p.isHot !== 'boolean') return null;
    if (typeof p.sourceFeed !== 'string') return null;
    if (typeof p.eventTime !== 'number') return null;
    if (p.descendants !== undefined && typeof p.descendants !== 'number') {
      return null;
    }
    if (p.type !== undefined && typeof p.type !== 'string') return null;
    if (
      p.articleOpened !== undefined &&
      typeof p.articleOpened !== 'boolean'
    ) {
      return null;
    }
    if (p.title !== undefined && typeof p.title !== 'string') return null;
    return parsed as RawEvent;
  } catch {
    return null;
  }
}

export interface TelemetryEventsDeps {
  verifyHn?: (sessionValue: string) => Promise<HnVerifyResult>;
  redis?: Redis;
}

export async function handleTelemetryEvents(
  request: Request,
  deps: TelemetryEventsDeps = {},
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const cookies = parseCookieHeader(request.headers.get('cookie'));
  const sessionValue = cookies[SESSION_COOKIE_NAME];
  const claimedUsername = usernameFromSessionValue(sessionValue);
  if (!sessionValue || !claimedUsername) {
    return json({ error: 'Not authenticated' }, 401);
  }
  if (claimedUsername !== adminUsername()) {
    // Fast-reject before burning the HN round-trip.
    return json(
      {
        error: 'Forbidden',
        reason: 'admin_user_mismatch',
        signedInAs: claimedUsername,
      },
      403,
    );
  }

  const verifyHn = deps.verifyHn ?? verifyHnSession;
  const verified = await verifyHn(sessionValue);
  if (!verified.ok) {
    return json(
      { error: 'Forbidden', reason: verified.reason, hnStatus: verified.httpStatus },
      verified.reason === 'timeout' || verified.reason === 'unreachable'
        ? 503
        : 403,
    );
  }
  if (verified.username !== adminUsername()) {
    return json(
      {
        error: 'Forbidden',
        reason: 'admin_user_mismatch',
        signedInAs: verified.username,
      },
      403,
    );
  }
  const username = verified.username;

  if (!hasRedisCredentials()) {
    // Empty payload, not an error — the operator may be hitting
    // the endpoint on a freshly-deployed environment that has no
    // events yet. Log nothing, return empty arrays, let the UI
    // show "no events yet".
    return json({ user: [], anon: [] }, 200);
  }

  const redis = deps.redis ?? getRedis();
  const userKey = `telemetry:user:${username}`;
  const anonKey = 'telemetry:preview:anon';

  let userRaw: unknown[] = [];
  let anonRaw: unknown[] = [];
  try {
    [userRaw, anonRaw] = await Promise.all([
      redis.lrange(userKey, 0, -1),
      redis.lrange(anonKey, 0, -1),
    ]);
  } catch (err) {
    return json(
      {
        error: 'Telemetry storage read failed',
        reason: err instanceof Error ? err.message : String(err),
      },
      503,
    );
  }

  const user = userRaw.map(tryParseEvent).filter((e): e is RawEvent => !!e);
  const anon = anonRaw.map(tryParseEvent).filter((e): e is RawEvent => !!e);
  return json({ user, anon }, 200);
}

export async function GET(request: Request): Promise<Response> {
  return handleTelemetryEvents(request);
}
