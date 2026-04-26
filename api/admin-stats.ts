// GET /api/admin-stats — operator-only analytics rollup over the
// structured `summary-outcome`, `comments-summary-outcome`, and
// `warm-run` log lines that Vercel forwards into Axiom. Every card
// fires its own APL query in parallel, with a hard per-card timeout,
// and degrades to `{ ok: false, reason }` independently — one
// missing/broken card never blocks the rest of the dashboard.
//
// Cost / reliability (per AGENTS.md rule 11):
//   - Cost: Axiom's free Vercel-integration tier covers ~500 GB/month
//     ingest and the query API. We issue ~5 small aggregation queries
//     per /admin page load; the operator hits /admin a few times a
//     day. Effectively $0/month.
//   - Reliability: adds Axiom as a runtime dep of /admin. Mitigation
//     is per-card graceful degrade — service-health, Jina balance,
//     and identity all keep painting if Axiom is unreachable.
//
// Threat model (per AGENTS.md rules 12 + 13):
//   - Same gate as /api/admin: prefix-check, then HN round-trip on
//     the cookie. Devtools-forged cookies can pass the prefix but
//     not the HN check.
//   - The AXIOM_API_TOKEN value never leaves the server. The
//     response only ever reports `configured: boolean` for the
//     token + dataset.
//
// Per AGENTS.md *Vercel api/ gotchas*, the cookie + HN-verify helpers
// are copy-pasted from `api/admin.ts` rather than imported. The
// `api/imports.test.ts` regression test enforces this.

import { parse as parseHtml } from 'node-html-parser';

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'hn_session';
const HN_USERNAME_RE = /^[a-zA-Z0-9_-]{2,32}$/;
const HN_FRONT_URL = 'https://news.ycombinator.com/';
const HN_VERIFY_TIMEOUT_MS = 8_000;
const HN_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// Axiom's APL query endpoint. Documented at
// https://axiom.co/docs/restapi/endpoints/queryApl. The dataset name
// is interpolated into the APL body itself (e.g. `['vercel'] | …`),
// not the URL path. We only ever use it server-side with an operator-
// supplied env var, so APL string-building is safe.
const AXIOM_APL_URL = 'https://api.axiom.co/v1/datasets/_apl?format=tabular';
// Per-card hard timeout — Axiom's p99 query latency is well under a
// second on this volume, so anything over ~5 s is "the upstream is
// degraded; show degrade UI". Total page latency is bounded by the
// slowest card, since they all fire in parallel.
const AXIOM_QUERY_TIMEOUT_MS = 5_000;

function adminUsername(): string {
  return process.env.ADMIN_USERNAME ?? 'mikelward';
}

// The Vercel ↔ Axiom integration ships logs from *every* accessible
// Vercel project into the same dataset, so a query that doesn't pin
// `vercel.projectName` will mix unrelated projects' lines into our
// rollups (and potentially surface their operational data on /admin).
// CRON.md's APL templates already filter on `['vercel.projectName']
// == "newshacker"` for the same reason — match that. The default is
// hard-coded to keep the in-app dashboard and the CRON.md queries
// answering the same question; the env var is the escape hatch for
// forks / renamed Vercel projects.
function axiomProjectName(): string {
  return process.env.AXIOM_PROJECT_NAME ?? 'newshacker';
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

// Mirrors api/admin.ts. The `<a id="me" href="user?id=NAME">` marker
// is HN's unambiguous "this viewer is logged in as NAME" signal —
// signed-out viewers get a `login?goto=…` link in the same slot.
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
      return {
        ok: false,
        reason: `hn_status_${res.status}`,
        httpStatus: res.status,
      };
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

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
    },
  });
}

// Axiom returns aggregation results in a column-oriented "tabular"
// shape: `{ tables: [{ fields: [{name, ...}], columns: [[v0_row0,
// v0_row1, …], [v1_row0, …]] }] }`. This helper transposes that into
// the row-oriented `[{name: value, …}, …]` form the parsers want.
//
// Exported for tests — the tabular wire format is what we'd most
// like to catch a regression on.
export interface AxiomTabularTable {
  fields?: { name?: string }[];
  columns?: unknown[][];
}

export function rowsFromAxiomTable(
  table: AxiomTabularTable | undefined,
): Record<string, unknown>[] {
  if (!table || !Array.isArray(table.fields) || !Array.isArray(table.columns)) {
    return [];
  }
  const fields = table.fields;
  const columns = table.columns;
  const rowCount = columns.reduce<number>(
    (acc, col) => Math.max(acc, Array.isArray(col) ? col.length : 0),
    0,
  );
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < rowCount; i++) {
    const row: Record<string, unknown> = {};
    for (let f = 0; f < fields.length; f++) {
      const name = fields[f]?.name;
      if (!name) continue;
      const col = columns[f];
      row[name] = Array.isArray(col) ? col[i] : undefined;
    }
    rows.push(row);
  }
  return rows;
}

interface AxiomQueryConfig {
  apl: string;
  fetchImpl: typeof fetch;
  token: string;
  signal?: AbortSignal;
}

async function runAplQuery(
  cfg: AxiomQueryConfig,
): Promise<Record<string, unknown>[]> {
  const res = await cfg.fetchImpl(AXIOM_APL_URL, {
    method: 'POST',
    signal: cfg.signal,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ apl: cfg.apl }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`axiom_http_${res.status}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { tables?: AxiomTabularTable[] };
  return rowsFromAxiomTable(body.tables?.[0]);
}

// Wraps a per-card query in (a) a hard timeout and (b) a try/catch
// that converts any failure into a typed `{ ok: false, reason }`
// payload. The reason is a short machine-readable string the UI can
// use to render a tasteful error state — we don't surface stack
// traces or upstream HTTP bodies, since the operator can always
// open Axiom directly to debug.
async function tryCard<T>(
  fetchImpl: typeof fetch,
  token: string,
  apl: string,
  parser: (rows: Record<string, unknown>[]) => T,
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AXIOM_QUERY_TIMEOUT_MS);
  try {
    const rows = await runAplQuery({
      apl,
      fetchImpl,
      token,
      signal: controller.signal,
    });
    return { ok: true, value: parser(rows) };
  } catch (err) {
    if (isAbortError(err)) return { ok: false, reason: 'timeout' };
    if (err instanceof Error && err.message.startsWith('axiom_http_')) {
      // Surface the upstream HTTP code so the operator can tell
      // 401 (token revoked / wrong scope) from 5xx (Axiom degraded).
      return { ok: false, reason: err.message.split(':', 1)[0] };
    }
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

// Both helpers below interpolate operator-set env-var values into
// APL. The values never come from a user request, so this is not a
// query-injection surface. We still strip non-safe characters as a
// defence in depth — a typo'd value can't accidentally produce
// malformed APL.
function quoteDataset(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_.-]/g, '');
  return `['${safe}']`;
}

function quoteAplString(value: string): string {
  // APL string literals use double quotes. Strip anything that
  // could break the literal or smuggle a closing quote.
  const safe = value.replace(/[^a-zA-Z0-9_.-]/g, '');
  return `"${safe}"`;
}

// Column-name conventions match the queries already in CRON.md so a
// query that works in the Axiom console works here verbatim. Vercel's
// Axiom integration namespaces metadata as `vercel.source`,
// `vercel.projectName`, etc. — APL escapes the dot via `['name']`.
//
// The `vercel.projectName` filter is load-bearing: the integration
// ships every accessible Vercel project's logs into the same dataset,
// so without it a multi-project Axiom would mix unrelated lines into
// these rollups (and potentially surface unrelated operational data
// on /admin). Mirrors the templates in CRON.md.
function projectFilter(): string {
  return `| where ['vercel.projectName'] == ${quoteAplString(axiomProjectName())}`;
}

function summaryLineFilter(): string {
  return [
    projectFilter(),
    "| where ['vercel.source'] == \"lambda\"",
    '| where message contains "summary-outcome" or message contains "comments-summary-outcome"',
    '| extend e = parse_json(message)',
  ].join(' ');
}

function warmLineFilter(): string {
  return [
    projectFilter(),
    "| where ['vercel.source'] == \"lambda\"",
    '| where message contains "warm-run"',
    '| extend e = parse_json(message)',
  ].join(' ');
}

interface CacheHitsValue {
  windowSeconds: number;
  byOutcome: Record<string, number>;
}

interface TokensValue {
  windowSeconds: number;
  // Sums of the per-call token counts from `summary-outcome` /
  // `comments-summary-outcome` log lines. Split into prompt + output
  // so the UI can multiply each by the right Gemini rate (input vs
  // output pricing differs by ~4× on Flash-Lite). Jina has no
  // input/output split — its `usage.tokens` is a single number.
  geminiPromptTokens: number;
  geminiOutputTokens: number;
  jinaTokens: number;
}

interface FailuresValue {
  windowSeconds: number;
  byReason: { reason: string; count: number }[];
}

interface RateLimitValue {
  windowSeconds: number;
  count: number;
}

interface WarmCronValue {
  windowSeconds: number;
  lastRun: {
    tISO: string;
    durationMs: number | null;
    processed: number | null;
    storyCount: number | null;
  } | null;
}

export interface StatsCards {
  cacheHits:
    | { ok: true; value: CacheHitsValue }
    | { ok: false; reason: string };
  tokens: { ok: true; value: TokensValue } | { ok: false; reason: string };
  failures:
    | { ok: true; value: FailuresValue }
    | { ok: false; reason: string };
  rateLimit:
    | { ok: true; value: RateLimitValue }
    | { ok: false; reason: string };
  warmCron:
    | { ok: true; value: WarmCronValue }
    | { ok: false; reason: string };
}

export interface StatsResponse {
  // `false` means AXIOM_API_TOKEN / AXIOM_DATASET aren't both set;
  // the page should render an "Analytics not configured" card and
  // skip the data fetches entirely. `true` means we attempted the
  // queries — individual cards may still come back `{ ok: false }`.
  configured: boolean;
  // Raw env-var presence for the operator's "is the token wired?"
  // glance, mirroring the `services` block in /api/admin. Token
  // *value* is never returned (per AGENTS.md rule 12).
  axiom: { tokenConfigured: boolean; dataset: string | null };
  cards: StatsCards | null;
}

function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

function toIntOrZero(v: unknown): number {
  return toInt(v) ?? 0;
}

function toStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

// === Card-specific APL builders + parsers. Each one is small enough
// that inlining the parse here keeps the card's contract in one
// place. ===

const CACHE_HITS_WINDOW_SECONDS = 60 * 60;
function cacheHitsApl(dataset: string): string {
  return [
    quoteDataset(dataset),
    '| where _time > ago(1h)',
    summaryLineFilter(),
    '| summarize count() by outcome = tostring(e.outcome)',
  ].join(' ');
}
function parseCacheHits(rows: Record<string, unknown>[]): CacheHitsValue {
  const byOutcome: Record<string, number> = {};
  for (const r of rows) {
    const k = toStr(r.outcome) ?? 'unknown';
    byOutcome[k] = toIntOrZero(r.count_);
  }
  return { windowSeconds: CACHE_HITS_WINDOW_SECONDS, byOutcome };
}

const TOKENS_WINDOW_SECONDS = 60 * 60 * 24;
// Token spend has two emission paths:
//   - User path: `summary-outcome` / `comments-summary-outcome` lines
//     carry `geminiPromptTokens` / `geminiOutputTokens` (both
//     endpoints) and `jinaTokens` (URL-post summaries only).
//   - Warm cron: `warm-story` lines carry the same Gemini fields on
//     `first_seen` / `changed` outcomes, and the Jina-billed count
//     under the field name `tokens` (article track only — comments
//     track doesn't hit Jina).
// The query unions all three line types and sums the token fields by
// name. `jinaTokens` (user) and `tokens` (cron) are *different* field
// names, so summing each independently then adding them avoids the
// fragility of a coalesce.
function tokensApl(dataset: string): string {
  return [
    quoteDataset(dataset),
    '| where _time > ago(24h)',
    projectFilter(),
    "| where ['vercel.source'] == \"lambda\"",
    '| where message contains "summary-outcome" or message contains "comments-summary-outcome" or message contains "warm-story"',
    '| extend e = parse_json(message)',
    '| summarize',
    'geminiPromptTokens = sum(toint(e.geminiPromptTokens)),',
    'geminiOutputTokens = sum(toint(e.geminiOutputTokens)),',
    'jinaUserTokens = sum(toint(e.jinaTokens)),',
    'jinaWarmTokens = sum(toint(e.tokens))',
    '| extend jinaTokens = jinaUserTokens + jinaWarmTokens',
    '| project geminiPromptTokens, geminiOutputTokens, jinaTokens',
  ].join(' ');
}
function parseTokens(rows: Record<string, unknown>[]): TokensValue {
  const r = rows[0] ?? {};
  return {
    windowSeconds: TOKENS_WINDOW_SECONDS,
    geminiPromptTokens: toIntOrZero(r.geminiPromptTokens),
    geminiOutputTokens: toIntOrZero(r.geminiOutputTokens),
    jinaTokens: toIntOrZero(r.jinaTokens),
  };
}

const FAILURES_WINDOW_SECONDS = 60 * 60 * 24;
const FAILURES_TOP_N = 5;
function failuresApl(dataset: string): string {
  return [
    quoteDataset(dataset),
    '| where _time > ago(24h)',
    summaryLineFilter(),
    '| where tostring(e.outcome) == "error"',
    '| summarize count() by reason = tostring(e.reason)',
    `| top ${FAILURES_TOP_N} by count_`,
  ].join(' ');
}
function parseFailures(rows: Record<string, unknown>[]): FailuresValue {
  const byReason: { reason: string; count: number }[] = [];
  for (const r of rows) {
    byReason.push({
      reason: toStr(r.reason) ?? 'unknown',
      count: toIntOrZero(r.count_),
    });
  }
  return { windowSeconds: FAILURES_WINDOW_SECONDS, byReason };
}

const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
function rateLimitApl(dataset: string): string {
  return [
    quoteDataset(dataset),
    '| where _time > ago(1h)',
    summaryLineFilter(),
    '| where tostring(e.outcome) == "rate_limited"',
    '| summarize count()',
  ].join(' ');
}
function parseRateLimit(rows: Record<string, unknown>[]): RateLimitValue {
  return {
    windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
    count: toIntOrZero(rows[0]?.count_),
  };
}

const WARM_CRON_WINDOW_SECONDS = 60 * 60 * 6;
function warmCronApl(dataset: string): string {
  return [
    quoteDataset(dataset),
    '| where _time > ago(6h)',
    warmLineFilter(),
    '| project _time, durationMs = toint(e.durationMs), processed = toint(e.processed), storyCount = toint(e.storyCount)',
    '| top 1 by _time desc',
  ].join(' ');
}
function parseWarmCron(rows: Record<string, unknown>[]): WarmCronValue {
  const r = rows[0];
  if (!r) {
    return { windowSeconds: WARM_CRON_WINDOW_SECONDS, lastRun: null };
  }
  const t = r._time;
  const tISO = toStr(t) ?? (typeof t === 'number' ? new Date(t).toISOString() : '');
  return {
    windowSeconds: WARM_CRON_WINDOW_SECONDS,
    lastRun: {
      tISO,
      durationMs: toInt(r.durationMs),
      processed: toInt(r.processed),
      storyCount: toInt(r.storyCount),
    },
  };
}

export interface AdminStatsDeps {
  fetchImpl?: typeof fetch;
  verifyHn?: (sessionValue: string) => Promise<HnVerifyResult>;
}

export async function handleAdminStatsRequest(
  request: Request,
  deps: AdminStatsDeps = {},
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
      {
        error: 'Forbidden',
        reason: verified.reason,
        hnStatus: verified.httpStatus,
      },
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

  const token = process.env.AXIOM_API_TOKEN;
  const dataset = process.env.AXIOM_DATASET;
  if (!token || !dataset) {
    const body: StatsResponse = {
      configured: false,
      axiom: {
        tokenConfigured: Boolean(token),
        dataset: dataset ?? null,
      },
      cards: null,
    };
    return json(body, 200);
  }

  const fetchImpl = deps.fetchImpl ?? fetch;

  // All five cards in parallel. `tryCard` already swallows per-query
  // failures, so `Promise.all` here is enough — there's no `reject`
  // path to `allSettled` against.
  const [cacheHits, tokens, failures, rateLimit, warmCron] = await Promise.all([
    tryCard(fetchImpl, token, cacheHitsApl(dataset), parseCacheHits),
    tryCard(fetchImpl, token, tokensApl(dataset), parseTokens),
    tryCard(fetchImpl, token, failuresApl(dataset), parseFailures),
    tryCard(fetchImpl, token, rateLimitApl(dataset), parseRateLimit),
    tryCard(fetchImpl, token, warmCronApl(dataset), parseWarmCron),
  ]);

  const body: StatsResponse = {
    configured: true,
    axiom: { tokenConfigured: true, dataset },
    cards: { cacheHits, tokens, failures, rateLimit, warmCron },
  };
  return json(body, 200);
}

export async function GET(request: Request): Promise<Response> {
  return handleAdminStatsRequest(request);
}
