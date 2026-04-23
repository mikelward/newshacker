// GET /api/admin — operator-only visibility endpoint. Reports
// configuration + HN-verified identity for the operator, a live
// Jina wallet balance (via Jina's dashboard backend), and Upstash
// reachability. Gemini we can only link out to, since Google has
// no public per-key quota endpoint.
//
// Access control is two-factor:
//   1. The caller must have our `hn_session` cookie, and its username
//      prefix must match `ADMIN_USERNAME` (defaults to `mikelward`).
//   2. We then round-trip to news.ycombinator.com with the full cookie
//      value and confirm HN itself reports the same user as logged in.
// The second step exists because `hn_session` is HttpOnly but not
// unforgeable — any visitor can set `hn_session=mikelward&anything` in
// devtools and pass step 1 alone. HN's own session hash is the only
// thing an attacker can't mint, so we defer to HN to validate it.
// /api/me deliberately skips this round-trip (it's hit on every boot);
// /admin is rare and human-only, so the extra HN fetch is fine.
//
// Cookie parsing and username extraction are copy-pasted from
// api/me.ts per AGENTS.md § "Vercel api/ gotchas" (Vercel's bundler
// does not reliably share modules between sibling api/*.ts handlers).

import { Redis } from '@upstash/redis';
import { parse as parseHtml } from 'node-html-parser';

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'hn_session';

// Read at request time (not module load) so deployments can rotate the
// admin account without a redeploy, and so tests can stub a single
// request without resetting module state.
function adminUsername(): string {
  return process.env.ADMIN_USERNAME ?? 'mikelward';
}

function hnCookieName(): string {
  return process.env.HN_COOKIE_NAME ?? 'user';
}

const HN_USERNAME_RE = /^[a-zA-Z0-9_-]{2,32}$/;

// HN verification: we fetch the front page with the caller's cookie
// and look for HN's logged-in pagetop (the `<a id="me"
// href="user?id=…">` marker). A spoofed cookie gets HN's signed-out
// pagetop instead.
const HN_FRONT_URL = 'https://news.ycombinator.com/';
const HN_VERIFY_TIMEOUT_MS = 8_000;
// Realistic UA — HN sometimes serves a stripped signed-out page to
// undici's default User-Agent. Mirrors api/login.ts for consistency.
const HN_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// Jina has no officially-documented account endpoint (see
// jina-ai/reader#64 — balance is only surfaced through the web
// dashboard). The dashboard itself hits
//   GET https://embeddings-dashboard-api.jina.ai/api/v1/api_key/fe_user?api_key=<KEY>
// which returns JSON with (at least) `metadata.threshold`,
// `wallet.regular_balance`, and `wallet.total_balance`. Undocumented
// and Jina can change it without notice, so we fail soft (echo the
// raw body back to the admin UI under `<details>` so the operator
// can adapt) rather than treating absence as catastrophic.
//
// The API key is passed as a query parameter rather than a Bearer
// header — that's what the dashboard does, and Bearer authentication
// returns "invalid endpoint" on this path. Server-side only, so the
// usual "keys in URLs" concerns (Referer leaks, browser history,
// shared URLs) don't apply.
const JINA_USER_ENDPOINT =
  'https://embeddings-dashboard-api.jina.ai/api/v1/api_key/fe_user';
const JINA_TIMEOUT_MS = 10_000;

export interface ServiceProbe {
  configured: boolean;
  reachable?: boolean;
  latencyMs?: number;
}

export interface JinaAccount {
  configured: boolean;
  // `reachable: true` → the dashboard endpoint returned 2xx JSON.
  // `reachable: false` → transport error, non-2xx status, or
  // malformed body. `httpStatus` distinguishes "auth failed"
  // (401/403) from "rate limit" (429) at a glance.
  reachable?: boolean;
  httpStatus?: number;
  // Best-effort extraction. `null` = missing or unparseable (the
  // response didn't have a number at the expected key — whether
  // because Jina omitted it for this account or because the schema
  // drifted under us). `undefined` = probe didn't run (e.g.
  // JINA_API_KEY not set, or upstream unreachable before we could
  // parse).
  regularBalance?: number | null;
  totalBalance?: number | null;
  // Alert threshold the operator has configured on the Jina
  // dashboard — shown so it's easy to spot "balance is close to
  // threshold" without flipping between tabs.
  threshold?: number | null;
  // Upstream body for the admin UI's "full response" panel — JSON
  // when Jina returned something parseable (2xx or not), string
  // when the response wasn't JSON. Lets the operator see error
  // payloads verbatim (which usually contain the actionable
  // message the dashboard would show).
  raw?: unknown;
}

export interface AdminResponse {
  username: string;
  region: string | null;
  build: string | null;
  services: {
    // Gemini: no public quota endpoint, admin page links to Google AI
    // Studio.
    gemini: ServiceProbe;
    // Jina: live wallet balance + threshold via Jina's dashboard
    // backend. Undocumented; fail-soft if the shape drifts.
    jina: JinaAccount;
    redis: ServiceProbe;
  };
}

export type HnVerifyResult =
  | { ok: true; username: string; httpStatus?: number }
  | {
      ok: false;
      reason: string;
      httpStatus?: number;
      // Short snippet of whatever HN returned, for operator
      // debugging. Only populated on failure paths. Not sensitive —
      // the caller already proved they have a cookie claiming to be
      // the admin; they're seeing HN's response to *their own*
      // cookie.
      pagetopSnippet?: string;
    };

export interface AdminDeps {
  fetchImpl?: typeof fetch;
  pingRedis?: () =>
    | Promise<{ ok: true; latencyMs: number } | { ok: false }>
    | { ok: true; latencyMs: number }
    | { ok: false };
  now?: () => number;
  // Injection point for the "ask HN if this cookie is really logged
  // in" step. Tests override this so they don't need to construct
  // plausible HN HTML responses; production calls
  // `verifyHnSessionDefault`.
  verifyHn?: (sessionValue: string) => Promise<HnVerifyResult>;
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

export function parseCookieHeader(
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

export function usernameFromSessionValue(
  value: string | undefined,
): string | null {
  if (!value) return null;
  const amp = value.indexOf('&');
  const candidate = amp === -1 ? value : value.slice(0, amp);
  return HN_USERNAME_RE.test(candidate) ? candidate : null;
}

function hasRedisCredentials(): boolean {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return Boolean(url && token);
}

async function defaultPingRedis(
  now: () => number,
): Promise<{ ok: true; latencyMs: number } | { ok: false }> {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { ok: false };
  try {
    const redis = new Redis({ url, token });
    const start = now();
    await redis.ping();
    return { ok: true, latencyMs: now() - start };
  } catch {
    return { ok: false };
  }
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

// Read a body as JSON first, fall back to raw text so the operator
// still sees something when the endpoint returns HTML (Cloudflare
// challenge, 502 page, etc.) or malformed JSON.
async function readBody(res: Response): Promise<
  { kind: 'json'; value: unknown } | { kind: 'text'; value: string }
> {
  const text = await res.text();
  try {
    return { kind: 'json', value: JSON.parse(text) };
  } catch {
    return { kind: 'text', value: text };
  }
}

function pluckNumber(obj: unknown, keys: string[]): number | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

// Pulls balance + threshold fields from Jina's fe_user response.
// The observed live shape (mikelward's account, April 2026) nests
// balance under `wallet` and threshold under `metadata`; we probe
// a handful of neighbouring names too so a Jina schema drift
// doesn't silently zero out the numbers.
export function extractJinaFields(body: unknown): {
  regularBalance: number | null;
  totalBalance: number | null;
  threshold: number | null;
} {
  if (!body || typeof body !== 'object') {
    return { regularBalance: null, totalBalance: null, threshold: null };
  }
  const root = body as Record<string, unknown>;
  const wallet =
    typeof root.wallet === 'object' && root.wallet !== null
      ? (root.wallet as Record<string, unknown>)
      : {};
  const metadata =
    typeof root.metadata === 'object' && root.metadata !== null
      ? (root.metadata as Record<string, unknown>)
      : {};
  const regularBalance = pluckNumber(wallet, [
    'regular_balance',
    'regularBalance',
  ]);
  const totalBalance = pluckNumber(wallet, [
    'total_balance',
    'totalBalance',
    'balance',
  ]);
  const threshold = pluckNumber(metadata, [
    'threshold',
    'alert_threshold',
    'alertThreshold',
    'low_balance_threshold',
  ]);
  return { regularBalance, totalBalance, threshold };
}

export async function probeJinaAccount(
  fetchImpl: typeof fetch = fetch,
): Promise<JinaAccount> {
  const apiKey = process.env.JINA_API_KEY;
  if (!apiKey) return { configured: false };
  const url = `${JINA_USER_ENDPOINT}?api_key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JINA_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    const parsed = await readBody(res);
    if (!res.ok) {
      return {
        configured: true,
        reachable: false,
        httpStatus: res.status,
        raw: parsed.value,
      };
    }
    if (parsed.kind !== 'json') {
      // 2xx but non-JSON — Jina has changed the response format under
      // us. Treat as unreachable but still surface the body so the
      // operator can update the schema.
      return {
        configured: true,
        reachable: false,
        httpStatus: res.status,
        raw: parsed.value,
      };
    }
    const { regularBalance, totalBalance, threshold } = extractJinaFields(
      parsed.value,
    );
    return {
      configured: true,
      reachable: true,
      httpStatus: res.status,
      regularBalance,
      totalBalance,
      threshold,
      raw: parsed.value,
    };
  } catch (err) {
    return {
      configured: true,
      reachable: false,
      httpStatus: isAbortError(err) ? 504 : undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

// HN marks the logged-in viewer's own pagetop profile link with
// `id="me"`:
//   <a id="me" href="user?id=<name>"><name></a>
// Signed-out pages never emit that id attribute — the same slot is
// replaced with a `login?goto=…` link. So the presence of an
// `a#me[href^="user?id="]` element is an unambiguous "this viewer
// is logged in as <name>" signal, stable against every HTML
// layout variation we've seen (quote style, `&nbsp;` separators,
// wrapper elements, id attributes on sibling links, etc.).
//
// We use a real HTML parser rather than a regex because HN's
// pagetop has shifted enough that hand-rolled regex matches kept
// missing it — every subtle HTML change (mixed quotes, attribute
// order, whitespace) silently turned "logged in" into "not logged
// in" without us noticing until a deploy.
export function extractHnLoggedInUsername(html: string): string | null {
  const root = parseHtml(html);
  const me = root.querySelector('a#me');
  if (!me) return null;
  const href = me.getAttribute('href') ?? '';
  const match = /^user\?id=([a-zA-Z0-9_-]{2,32})$/.exec(href);
  return match ? match[1] : null;
}

// Pulls out just the top-bar region (from the last `class="pagetop"`
// backwards through the end of the enclosing `</span>`, capped at
// ~600 chars) so we don't dump the entire HN frontpage into the
// admin response. Enough context to see whether HN served the
// signed-out or logged-in pagetop.
export function extractPagetopSnippet(html: string): string {
  const lastPagetop = html.lastIndexOf('pagetop');
  if (lastPagetop === -1) {
    // No pagetop at all → show the first 300 chars so operators can
    // see whether HN served something unexpected (Cloudflare
    // challenge, maintenance page, etc.).
    return html.slice(0, 300);
  }
  const start = Math.max(0, lastPagetop - 40);
  const end = Math.min(html.length, lastPagetop + 600);
  return html.slice(start, end);
}

async function readPagetopSnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return extractPagetopSnippet(text);
  } catch {
    return '';
  }
}

export async function verifyHnSessionDefault(
  sessionValue: string,
): Promise<HnVerifyResult> {
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
      // Default `redirect: 'follow'`. The earlier draft set
      // `redirect: 'manual'` by analogy with api/login.ts — that's only
      // needed there to preserve HN's Set-Cookie across the POST →
      // redirect hop. Here we're doing a plain GET and want to land on
      // whichever URL HN actually serves the logged-in frontpage at.
    });
    if (!res.ok) {
      const snippet = await readPagetopSnippet(res);
      return {
        ok: false,
        reason: `hn_status_${res.status}`,
        httpStatus: res.status,
        pagetopSnippet: snippet,
      };
    }
    const html = await res.text();
    const name = extractHnLoggedInUsername(html);
    if (!name) {
      return {
        ok: false,
        reason: 'not_logged_in',
        httpStatus: res.status,
        pagetopSnippet: extractPagetopSnippet(html),
      };
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

export async function handleAdminRequest(
  request: Request,
  deps: AdminDeps = {},
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
    // Fast-reject non-admin prefixes without burning an HN round-trip.
    // The cookie can only ever *lose* us authority (HN disagrees with
    // the prefix), never gain any — so a cookie claiming a non-admin
    // user is safe to reject outright. We echo the claimed username
    // back so the admin UI can tell the user "you're signed in as X,
    // not Y" instead of an opaque Forbidden.
    return json(
      {
        error: 'Forbidden',
        reason: 'admin_user_mismatch',
        signedInAs: claimedUsername,
      },
      403,
    );
  }

  // Defence against a forged `hn_session` cookie: HN has to agree the
  // session is real and belongs to the claimed admin. Without this,
  // anyone typing `hn_session=mikelward&anything` into devtools on our
  // origin would pass the prefix check above.
  const verifyHn = deps.verifyHn ?? verifyHnSessionDefault;
  const verified = await verifyHn(sessionValue);
  if (!verified.ok) {
    return json(
      {
        error: 'Forbidden',
        reason: verified.reason,
        hnStatus: verified.httpStatus,
        hnSnippet: verified.pagetopSnippet,
      },
      verified.reason === 'timeout' || verified.reason === 'unreachable'
        ? 503
        : 403,
    );
  }
  if (verified.username !== adminUsername()) {
    // HN confirmed the session is real, but it belongs to somebody
    // else (e.g. the prefix was legitimately the admin name but the
    // cookie is for a different account). Surface the HN-verified
    // identity so the operator can see what went wrong.
    return json(
      {
        error: 'Forbidden',
        reason: 'admin_user_mismatch',
        signedInAs: verified.username,
      },
      403,
    );
  }
  // From here on, `verified.username` is HN's authoritative answer.
  const username = verified.username;

  const now = deps.now ?? Date.now;

  let redis: ServiceProbe;
  if (!hasRedisCredentials()) {
    redis = { configured: false };
  } else {
    const pingFn = deps.pingRedis ?? (() => defaultPingRedis(now));
    try {
      const result = await pingFn();
      redis = result.ok
        ? { configured: true, reachable: true, latencyMs: result.latencyMs }
        : { configured: true, reachable: false };
    } catch {
      redis = { configured: true, reachable: false };
    }
  }

  const gemini: ServiceProbe = {
    configured: Boolean(process.env.GOOGLE_API_KEY),
  };

  const jina = await probeJinaAccount(deps.fetchImpl);

  const body: AdminResponse = {
    username,
    region: process.env.VERCEL_REGION ?? null,
    build: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    services: { gemini, jina, redis },
  };

  return json(body);
}

export async function GET(request: Request): Promise<Response> {
  return handleAdminRequest(request);
}
