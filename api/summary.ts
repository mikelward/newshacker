import { GoogleGenAI } from '@google/genai';
import { Redis } from '@upstash/redis';
import { createHash } from 'node:crypto';

const MODEL = 'gemini-2.5-flash-lite';
// Upstash records live 30 days. The cron (/api/warm-summaries) owns
// freshness for top-30 stories; anything that ages out of the cron's
// MAX_STORY_AGE window is served from whatever is in the cache until
// Upstash itself evicts it.
const RECORD_TTL_SECONDS = 60 * 60 * 24 * 30;
// Paywalled records get a much shorter TTL — paywall detection is a
// live-state signal, not a stable property of the URL. Publishers
// flip A/B paywall buckets, metered counters reset, and Jina
// rotates its upstream fetch strategies, all on timescales under a
// day. A 1 h TTL forces the next reader to re-evaluate, which
// self-heals false positives (transient Jina flakes that produced
// a short body) and picks up wall flips without waiting for Upstash
// to evict 30 days later. Non-paywalled records keep the long TTL
// because the cron owns freshness there. Mirrored in
// api/warm-summaries.ts per AGENTS.md § "Vercel api/ gotchas".
const PAYWALLED_RECORD_TTL_SECONDS = 60 * 60;
const MAX_URL_LEN = 2048;
const MAX_CONTENT_CHARS = 200_000;

// Cache-Control on success. We deliberately do NOT use the edge CDN as
// the shared cache — Vercel's CDN is regional, so popular stories
// would still pay one Gemini call per region. The shared cache lives in
// KV (see SummaryStore below); the edge would just hide stale-by-region
// data behind it. `private, no-store` keeps the function in the request
// path so KV is always consulted; the service worker still caches per
// its own runtime rule (see vite.config.ts).
const NO_STORE_HEADER = 'private, no-store';

// === Rate limiting (inlined — shared bucket with api/comments-summary.ts) ===
// Both AI-summary endpoints share a single counter per client IP so one
// thread view (article + comments) counts as 2 units against one bucket,
// matching the cost model (each cache miss is one Gemini call). The
// bucket gates cache misses only; cached reads skip it entirely, so the
// happy path stays free.
//
// Keys look like `newshacker:ratelimit:aisummary:<tier>:<ip>:<win>`.
// The `:<ip>:` slot is the normalized IP (IPv4 as-is, IPv6 reduced to its
// /64 prefix so a single subscriber can't trivially cycle source
// addresses within their /64).
//
// Kept duplicated with api/comments-summary.ts per AGENTS.md § "Vercel
// api/ gotchas" — both files run the same check against the same prefix.
export const RATE_LIMIT_KEY_PREFIX = 'newshacker:ratelimit:aisummary:';
const RATE_LIMIT_BURST_LIMIT_DEFAULT = 20;
const RATE_LIMIT_BURST_WINDOW_SECONDS = 600; // 10 min
const RATE_LIMIT_DAILY_LIMIT_DEFAULT = 200;
const RATE_LIMIT_DAILY_WINDOW_SECONDS = 86_400; // 24 h

export interface RateLimitStore {
  // Atomically INCR `key`; if the result is 1 (i.e. the counter just
  // came into existence for this window), also set the TTL to
  // `windowSeconds`. Returns the post-increment count.
  incrementWithExpiry(key: string, windowSeconds: number): Promise<number>;
}

export interface RateLimitTier {
  name: 'burst' | 'daily';
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  ok: boolean;
  retryAfterSeconds?: number;
  exceededTier?: string;
}

export function defaultRateLimitTiers(): RateLimitTier[] {
  const burst = parsePositiveIntEnv(
    'SUMMARY_RATE_LIMIT_BURST',
    RATE_LIMIT_BURST_LIMIT_DEFAULT,
  );
  const daily = parsePositiveIntEnv(
    'SUMMARY_RATE_LIMIT_DAILY',
    RATE_LIMIT_DAILY_LIMIT_DEFAULT,
  );
  const tiers: RateLimitTier[] = [];
  if (burst !== null) {
    tiers.push({
      name: 'burst',
      limit: burst,
      windowSeconds: RATE_LIMIT_BURST_WINDOW_SECONDS,
    });
  }
  if (daily !== null) {
    tiers.push({
      name: 'daily',
      limit: daily,
      windowSeconds: RATE_LIMIT_DAILY_WINDOW_SECONDS,
    });
  }
  return tiers;
}

function parsePositiveIntEnv(name: string, fallback: number): number | null {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '') return fallback;
  // Explicit operator opt-out — set `0` or `off` to disable this tier.
  if (trimmed === '0' || trimmed === 'off') return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

// Prefer `x-forwarded-for`'s leftmost entry (the original client on
// Vercel's proxy chain); fall back to `x-real-ip`. Returns null if
// neither header is present or usable — the caller then skips the
// check (fail-open on missing provenance).
export function extractClientIp(headers: Headers): string | null {
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const xri = headers.get('x-real-ip');
  if (xri) {
    const trimmed = xri.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

// Normalize to a stable bucket key:
// - IPv4: dotted quad, pass through
// - IPv6: expand `::`, strip zone identifier, take the first 4 hex
//   groups (that's the /64 — ISPs typically hand out an entire /64 to
//   a single subscriber, so a per-/64 key is the right granularity).
// - Anything else (opaque proxy string, etc.): return trimmed raw so
//   the caller still gets a stable bucket per value.
export function normalizeIpForRateLimit(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(trimmed)) return trimmed;
  if (!trimmed.includes(':')) return trimmed;
  const addr = trimmed.split('%')[0]!; // strip zone id (e.g. fe80::1%eth0)
  const groups = addr.includes('::')
    ? expandIPv6Shorthand(addr)
    : addr.split(':');
  const first4 = groups.slice(0, 4).map((g) => g.toLowerCase() || '0');
  while (first4.length < 4) first4.push('0');
  return first4.join(':');
}

function expandIPv6Shorthand(addr: string): string[] {
  const idx = addr.indexOf('::');
  const leftStr = addr.slice(0, idx);
  const rightStr = addr.slice(idx + 2);
  const leftGroups = leftStr === '' ? [] : leftStr.split(':');
  const rightGroups = rightStr === '' ? [] : rightStr.split(':');
  const missing = Math.max(0, 8 - leftGroups.length - rightGroups.length);
  return [...leftGroups, ...Array(missing).fill('0'), ...rightGroups];
}

export async function checkRateLimit(
  store: RateLimitStore,
  normalizedIp: string,
  tiers: RateLimitTier[],
  nowMs: number,
): Promise<RateLimitResult> {
  for (const tier of tiers) {
    const windowIndex = Math.floor(nowMs / (tier.windowSeconds * 1000));
    const key = `${RATE_LIMIT_KEY_PREFIX}${tier.name}:${normalizedIp}:${windowIndex}`;
    let count: number;
    try {
      count = await store.incrementWithExpiry(key, tier.windowSeconds);
    } catch {
      // Fail-open per tier: if Redis is flaky for this hop, don't block
      // the request. Any successfully-incremented earlier tier is still
      // authoritative, so a full Redis outage never blocks.
      continue;
    }
    if (count > tier.limit) {
      const resetAtMs = (windowIndex + 1) * tier.windowSeconds * 1000;
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000)),
        exceededTier: tier.name,
      };
    }
  }
  return { ok: true };
}

let defaultRateLimitStore: RateLimitStore | null | undefined;

function createDefaultRateLimitStore(): RateLimitStore | null {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const redis = new Redis({ url, token });
  return {
    async incrementWithExpiry(key: string, windowSeconds: number) {
      const count = await redis.incr(key);
      // Only the first caller in a window needs to set TTL; subsequent
      // INCRs preserve the existing expiry. This is the standard
      // fixed-window counter pattern and trades ~1 in-flight race
      // (two clients racing INCR=1) for one fewer round trip in the
      // steady state. The race just means two EXPIREs in the same
      // second, which is harmless.
      if (count === 1) {
        try {
          await redis.expire(key, windowSeconds);
        } catch {
          // Best-effort: a missed EXPIRE means the key persists
          // without an expiry, so the counter may outlive the
          // intended window. The next INCR won't come back as 1, so
          // we also won't re-attempt the EXPIRE — but Upstash's own
          // memory eviction will drop the key eventually, and the
          // worst-case is one user getting slightly more lenient
          // bucketing than intended. Not worth failing the request.
        }
      }
      return count;
    },
  };
}

function getDefaultRateLimitStore(): RateLimitStore | null {
  if (defaultRateLimitStore === undefined) {
    defaultRateLimitStore = createDefaultRateLimitStore();
  }
  return defaultRateLimitStore;
}

// Test-only: reset the lazy-initialised default stores so env-var
// changes between tests take effect. Not part of the public handler API.
export function _resetRateLimitStoreForTests(): void {
  defaultRateLimitStore = undefined;
}

const JINA_ENDPOINT = 'https://r.jina.ai/';
const JINA_TIMEOUT_MS = 15_000;
// The server-side raw-HTML fallback was deliberately removed. See
// TODO.md § "Article-fetch fallback" for the rationale — mainly that it
// spoofed a Chrome UA to get past anti-bot heuristics, which is poor
// hygiene and invites well-earned blocks. If we bring it back it
// should be gated to a curated domain allowlist with an honest,
// identifiable User-Agent. Jina is now a hard dependency for this
// endpoint; deployments without JINA_API_KEY return 503
// `not_configured`.

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

// Checks the Referer header against an allowlist. This is a lightweight
// first-line defense — Referer can be spoofed by any non-browser client, so
// treat it as "keeps honest browsers honest" rather than real authz.
// Future: gate /api/summary on a logged-in session (see IMPLEMENTATION_PLAN.md).
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

// Inlined from api/items.ts. Vercel's per-file function bundler has been
// flaky about tracing shared modules outside `api/`, and this helper is
// short enough not to be worth its own file.
interface HNItem {
  id?: number;
  type?: string;
  title?: string;
  url?: string;
  text?: string;
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

function parseStoryId(raw: string | null): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

// Shared backend cache: an Upstash Redis key per story id. Writes go to
// the primary region; reads are served from the nearest read replica
// (typically single-digit ms). Both Vercel KV (Marketplace) and a direct
// Upstash database expose the same REST shape — we accept either env
// var pair so the same code works regardless of how the store was
// provisioned. If neither is set, we degrade silently to no shared
// cache.
//
// Cache key is the HN story id, not the article URL. Two HN posts
// pointing at the same external URL pay independently — accepted trade
// for not letting any caller pin arbitrary cache keys (and burn
// Gemini/Jina spend) via a `?url=` of their choosing.
//
// NOTE: the cache record shape (SummaryRecord) is shared with
// api/warm-summaries.ts. Any schema change needs to land in both files
// in the same commit. Vercel's bundler doesn't reliably share modules
// between sibling `api/*.ts` handlers (see AGENTS.md § "Vercel api/
// gotchas"), which is why the two copies exist.
export const KV_KEY_PREFIX = 'newshacker:summary:article:';

export interface SummaryRecord {
  summary: string;
  articleHash: string;
  // Epoch ms. `firstSeenAt` is set once and never changes.
  firstSeenAt: number;
  // Epoch ms of the most recent Gemini regeneration.
  summaryGeneratedAt: number;
  // Epoch ms of the most recent article re-fetch (changed or not).
  lastCheckedAt: number;
  // Epoch ms of the most recent article hash change; initialised to
  // firstSeenAt on the very first record.
  lastChangedAt: number;
  // Byte length of the Jina-clean article body that produced
  // `articleHash`. Present on records written after the deltaBytes
  // instrumentation landed; optional so records written by older code
  // (or by the user-facing handler before its write path was updated)
  // still parse. The next hash-changed tick always populates it.
  contentBytes?: number;
  // Best-effort paywall detection on the Jina-clean body. `undefined`
  // on records written before the detector landed; `true` when Jina's
  // response looked like a paywall overlay / teaser, `false` when it
  // looked like real article content. The bit is advisory today —
  // wired only for telemetry — so the handler must not alter behavior
  // based on it. Kept on the record so cache hits preserve the same
  // decision the generation-time detector made, and so warm-summaries
  // `unchanged` logs can carry the field without recomputing.
  paywalled?: boolean;
}

export interface SummaryStore {
  get(storyId: number): Promise<SummaryRecord | null>;
  set(
    storyId: number,
    record: SummaryRecord,
    ttlSeconds: number,
  ): Promise<void>;
}

let defaultStore: SummaryStore | null | undefined;

function createDefaultStore(): SummaryStore | null {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const redis = new Redis({ url, token });
  return {
    async get(storyId) {
      try {
        const raw = await redis.get<unknown>(`${KV_KEY_PREFIX}${storyId}`);
        return parseRecord(raw);
      } catch {
        // Fail-open: KV unreachable falls through to live generation.
        return null;
      }
    },
    async set(storyId, record, ttlSeconds) {
      try {
        await redis.set(
          `${KV_KEY_PREFIX}${storyId}`,
          JSON.stringify(record),
          { ex: ttlSeconds },
        );
      } catch {
        // Best-effort write; a missed set is no worse than a cache miss.
      }
    },
  };
}

function getDefaultStore(): SummaryStore | null {
  if (defaultStore === undefined) defaultStore = createDefaultStore();
  return defaultStore;
}

// Pre-schema entries were plain strings. Treat them as absent so the
// next generation writes a fresh record. Also guards against partial
// writes and schema drift.
export function parseRecord(raw: unknown): SummaryRecord | null {
  if (raw == null) return null;
  // Upstash's JS client auto-decodes JSON; string callers can still arrive
  // from legacy entries.
  const obj =
    typeof raw === 'string'
      ? (() => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })()
      : raw;
  if (!obj || typeof obj !== 'object') return null;
  const r = obj as Partial<SummaryRecord>;
  if (
    typeof r.summary !== 'string' ||
    typeof r.articleHash !== 'string' ||
    typeof r.firstSeenAt !== 'number' ||
    typeof r.summaryGeneratedAt !== 'number' ||
    typeof r.lastCheckedAt !== 'number' ||
    typeof r.lastChangedAt !== 'number'
  ) {
    return null;
  }
  return {
    summary: r.summary,
    articleHash: r.articleHash,
    firstSeenAt: r.firstSeenAt,
    summaryGeneratedAt: r.summaryGeneratedAt,
    lastCheckedAt: r.lastCheckedAt,
    lastChangedAt: r.lastChangedAt,
    ...(typeof r.contentBytes === 'number' && Number.isFinite(r.contentBytes)
      ? { contentBytes: r.contentBytes }
      : {}),
    ...(typeof r.paywalled === 'boolean' ? { paywalled: r.paywalled } : {}),
  };
}

export function hashArticle(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function isValidHttpUrl(value: string): boolean {
  if (value.length > MAX_URL_LEN) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function buildPrompt(articleUrl: string, content: string): string {
  return (
    `Summarize the article below in a single, concise sentence without using bullet points or introductory text. ` +
    `Write the sentence as a direct assertion of the article's main point, in the voice of the author — ` +
    `as if the author (or someone speaking on their behalf) is stating the claim itself. ` +
    `Do not refer to "the article", "the author", "the piece", "the post", "this story", or similar. ` +
    `Do not begin with meta-framing such as "The article argues", "The author claims", "This piece explains", ` +
    `"The post describes", or any variant. Just state the point. ` +
    `The article was fetched from ${articleUrl}. Ignore navigation, boilerplate, and markup; focus on the main body.\n\n` +
    `--- BEGIN ARTICLE ---\n${content}\n--- END ARTICLE ---`
  );
}

// Self-post variant — Ask HN / Show HN / text-only submissions where the
// body of the story IS the content. No article URL to reference, so the
// prompt drops the "fetched from <url>" clause and acknowledges that the
// submitter's question is often the whole point (e.g. "Ask HN: how do I
// do X?" → the summary should state the question, not the meta).
function buildSelfPostPrompt(title: string, content: string): string {
  return (
    `Summarize the Hacker News self-post below in a single, concise sentence without using bullet points or introductory text. ` +
    `The title is "${title}". ` +
    `Write the sentence as a direct assertion of the post's main point or question, in the voice of the submitter — ` +
    `as if the submitter is stating the claim or asking the question themselves. ` +
    `Do not refer to "the article", "the author", "the submitter", "the piece", "the post", "this story", or similar. ` +
    `Do not begin with meta-framing such as "The post asks", "The submitter claims", "The author wonders", ` +
    `"This post describes", or any variant. Just state the point or the question directly. ` +
    `There is no external article — the body below is the full submission.\n\n` +
    `--- BEGIN POST ---\n${content}\n--- END POST ---`
  );
}

// HN self-post bodies contain a constrained HTML subset (<p>, <a>, <i>,
// <pre>, <code>, entities). Strip tags and decode entities so the model
// sees clean plain text. Mirror of the comment helper in
// api/warm-summaries.ts / api/comments-summary.ts.
export function htmlToPlainText(input: string | undefined): string {
  if (!input) return '';
  return input
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': NO_STORE_HEADER,
    },
  });
}

function rateLimited(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({
      error: 'Too many requests',
      reason: 'rate_limited',
      retryAfterSeconds,
    }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': NO_STORE_HEADER,
        'retry-after': String(retryAfterSeconds),
      },
    },
  );
}

// Structured per-request telemetry for monitors / dashboards.
// See OBSERVABILITY.md § "Log event taxonomy" for the contract —
// downstream monitors key off `type`, `outcome`, `reason`. Emitted
// exactly once per request (every return path in handleSummaryRequest
// calls this before `return json(...)` or `return rateLimited(...)`).
// Keep the field set tight; new fields are easy to add later, hard to
// remove once monitors depend on them.
export type SummaryOutcome =
  | 'cached'
  | 'generated'
  | 'rate_limited'
  | 'error';

export interface SummaryOutcomeExtras {
  chars?: number;
  // Gemini billed-token breakdown (all three are useful: prompt + output
  // price differently in Gemini's pricing, and total is handy for quick
  // "how much did this cost" dashboards).
  geminiPromptTokens?: number;
  geminiOutputTokens?: number;
  geminiTotalTokens?: number;
  // Jina billed-token count on URL-post summaries (self-posts don't
  // round-trip Jina, so absent there). Matches the `articleTokens` field
  // already logged by the warm cron — same unit, reconcilable.
  jinaTokens?: number;
  // Paywall-detector verdict on the Jina-clean body. Emitted as
  // `true` / `false` only on `cached` and `generated` outcomes (both
  // pull from a record that either carries the field or was just
  // computed). Deliberately absent on `error` and `rate_limited`
  // outcomes regardless of whether a verdict may have been known on
  // that path (e.g. `summarization_failed` / `source_captcha` both
  // fire after a successful Jina fetch), to keep the
  // prevalence-share query's numerator and denominator cleanly
  // scoped to "summaries we actually served". Absent on self-post
  // summaries (no Jina round-trip, no paywall to detect).
  paywalled?: boolean;
}

export function emitSummaryOutcome(
  outcome: SummaryOutcome,
  storyId: number | null,
  reason: string | undefined,
  extras: SummaryOutcomeExtras = {},
): void {
  const line: Record<string, unknown> = {
    type: 'summary-outcome',
    endpoint: 'summary',
    outcome,
  };
  if (storyId !== null) line.storyId = storyId;
  if (reason !== undefined) line.reason = reason;
  if (extras.chars !== undefined) line.chars = extras.chars;
  if (extras.geminiPromptTokens !== undefined) {
    line.geminiPromptTokens = extras.geminiPromptTokens;
  }
  if (extras.geminiOutputTokens !== undefined) {
    line.geminiOutputTokens = extras.geminiOutputTokens;
  }
  if (extras.geminiTotalTokens !== undefined) {
    line.geminiTotalTokens = extras.geminiTotalTokens;
  }
  if (extras.jinaTokens !== undefined) line.jinaTokens = extras.jinaTokens;
  if (extras.paywalled !== undefined) line.paywalled = extras.paywalled;
  console.log(JSON.stringify(line));
}

// Run the shared rate-limit check for this request. Returns `null` if
// the limiter is disabled (explicitly via deps or because no store is
// configured) or if we can't identify the caller (no IP header — which
// shouldn't happen in prod behind Vercel's proxy, but keeps tests and
// self-hosted setups fail-open rather than universally blocked).
async function applyRateLimit(
  request: Request,
  deps: SummaryDeps,
): Promise<RateLimitResult | null> {
  if (deps.rateLimitStore === null) return null;
  const rateLimitStore = deps.rateLimitStore ?? getDefaultRateLimitStore();
  if (!rateLimitStore) return null;
  const tiers = deps.rateLimitTiers ?? defaultRateLimitTiers();
  if (tiers.length === 0) return null;
  const rawIp = extractClientIp(request.headers);
  if (!rawIp) return null;
  const ip = normalizeIpForRateLimit(rawIp);
  if (!ip) return null;
  const nowMs = (deps.now ?? Date.now)();
  return checkRateLimit(rateLimitStore, ip, tiers, nowMs);
}

interface GenerateRequest {
  model: string;
  contents: string;
  config?: {
    tools?: unknown[];
    thinkingConfig?: { thinkingBudget?: number };
  };
}

interface GenerateResponse {
  text?: string | null;
  // Gemini exposes authoritative billed-token counts on every
  // `generateContent` response. Captured on the user-path handler so
  // the `summary-outcome` log line can carry per-request spend
  // telemetry — cron already logs Jina tokens; Gemini tokens were a
  // gap on both paths until this landed.
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

export interface SummaryClient {
  models: {
    generateContent(req: GenerateRequest): Promise<GenerateResponse>;
  };
}

export interface SummaryDeps {
  createClient?: (apiKey: string) => SummaryClient;
  fetchImpl?: typeof fetch;
  fetchItem?: (id: number, signal?: AbortSignal) => Promise<HNItem | null>;
  jinaApiKey?: string;
  // `null` = explicitly disable the shared cache for this request;
  // `undefined` = use the default (lazy-initialised) Upstash store.
  store?: SummaryStore | null;
  // Same semantics as `store`: `null` disables rate limiting for this
  // request (useful in tests that want to bypass the quota path),
  // `undefined` falls back to the default Upstash-backed store.
  rateLimitStore?: RateLimitStore | null;
  // Override the tier configuration for this request. Tests commonly
  // pass a single tiny tier to exercise the 429 branch without
  // generating hundreds of synthetic requests.
  rateLimitTiers?: RateLimitTier[];
  now?: () => number;
}

// Some sites (e.g. Cloudflare-gated news outlets) serve a CAPTCHA /
// bot-challenge page rather than the article when Jina fetches them.
// Jina returns the challenge markdown verbatim; Gemini then refuses with
// something like "I cannot summarize the article because the provided
// content is a CAPTCHA page …". The prompt forbids that kind of
// meta-framing for real summaries, so the combination of a first-person
// inability opener plus the word CAPTCHA is a reliable tell. We catch
// it here so the UI can render a short, specific error instead of
// storing the refusal as if it were the summary.
export function isCaptchaRefusal(summary: string): boolean {
  const normalized = summary.toLowerCase();
  if (!/\bcaptcha\b/.test(normalized)) return false;
  return /^(?:i cannot|i can'?t|i am unable|i'?m unable|unable to|cannot)\b/.test(
    normalized,
  );
}

// === Paywall detection (inlined — mirrored in api/warm-summaries.ts) ===
// Best-effort detector over the Jina-clean article body. Returns `true`
// when the response looks like a paywall overlay / teaser, `false` when
// it looks like real article content. Advisory only: today we attach
// the bit to telemetry so operators can see paywall prevalence per
// domain in the warm-summaries logs. The UI does NOT act on it yet —
// we want prevalence data before deciding whether the "honest empty
// state" follow-up is worth the UX work (see TODO.md § "Paywalled-
// article summary fallbacks"). Conservative on purpose: prefers
// false negatives over false positives, because a future UX path that
// hides a "real" summary on a false positive would be worse than
// today's status quo of showing a teaser.
//
// Kept duplicated with api/warm-summaries.ts per AGENTS.md § "Vercel
// api/ gotchas". Any edit here must be mirrored there — the parity
// test in api/warm-summaries.test.ts fails loudly if they drift.

// Phrases chosen to match paywall overlay copy, not incidental
// "subscribe to our newsletter" / "log in" mentions in the body of
// a full article. Case-insensitive. A single match on short content
// trips; two matches trip regardless of length (dynamic paywall
// pages with ads + subscribe forms can run ~3–5 KB).
const PAYWALL_MARKER_PATTERNS: readonly RegExp[] = [
  /\bsubscribe\s+to\s+(continue|read|keep\s+reading)\b/i,
  /\bsubscribers?[-\s]+only\b/i,
  /\bfor\s+subscribers?\s+only\b/i,
  /\b(sign|log)\s+in\s+to\s+(continue|read|keep\s+reading)\b/i,
  /\b(create|start)\s+(a\s+|your\s+)?(free\s+)?(account|trial)\s+to\s+(continue|read|keep\s+reading)\b/i,
  /\bregister\s+to\s+(continue|read|keep\s+reading)\b/i,
  /\byou[''`]?ve\s+read\s+\d+\s+of\s+\d+\s+free\b/i,
  /\byou\s+have\s+\d+\s+free\s+articles?\s+(remaining|left)\b/i,
  /\bthis\s+(article|content|story)\s+is\s+(for|available\s+to|exclusive\s+to)\s+(subscribers|members)\b/i,
  /\bbecome\s+a\s+(member|subscriber)\b/i,
  /\bstart\s+your\s+free\s+trial\b/i,
  /\bunlock\s+this\s+(article|story)\b/i,
  /\bcontinue\s+reading\s+with\s+a\s+subscription\b/i,
  /\bplease\s+(sign|log)\s+in\s+to\s+(continue|read|keep\s+reading)\b/i,
  /\bto\s+(continue|read|keep)\s+reading,?\s*(please\s+)?(sign|log)\s+in\b/i,
];

// schema.org `NewsArticle` publishes `isAccessibleForFree: false` so
// Google's structured-data crawler knows the body is paywalled. When
// Jina's fetched HTML (or ld+json block) preserves that field, it's
// a very strong signal — regardless of marker-phrase hits.
const JSON_LD_PAYWALL_MARKER = /"isAccessibleForFree"\s*:\s*false\b/i;

// Short-body threshold for the single-marker trip. Paywall overlays
// are typically ≤ ~2 KB of clean text; a 10 KB article that passively
// mentions "subscribe to continue" in a sidebar should not trip.
const PAYWALL_SHORT_BODY_CHARS = 2000;

export function detectPaywall(content: string): boolean {
  if (!content) return false;
  if (JSON_LD_PAYWALL_MARKER.test(content)) return true;
  let hits = 0;
  for (const pattern of PAYWALL_MARKER_PATTERNS) {
    if (pattern.test(content)) {
      hits += 1;
      if (hits >= 2) return true;
    }
  }
  return hits >= 1 && content.length <= PAYWALL_SHORT_BODY_CHARS;
}

function clampContent(body: string): string | null {
  const trimmed =
    body.length > MAX_CONTENT_CHARS ? body.slice(0, MAX_CONTENT_CHARS) : body;
  const clean = trimmed.trim();
  return clean || null;
}

type FetchFailure = 'timeout' | 'unreachable' | 'payment_required';
type FetchOutcome =
  | { ok: true; content: string; tokens?: number; paywalled: boolean }
  | { ok: false; failure: FetchFailure };

function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

// Jina's Reader API (r.jina.ai) handles JS-rendered pages, paywalls, and
// bot-blocked sites that our raw fetch can't reach. Returns clean markdown
// that we can feed to Gemini directly. Free tier via API key is generous.
//
// We request JSON so the response carries `usage.tokens` (authoritative
// billed-token count). The cron handler in api/warm-summaries.ts logs
// this; this handler doesn't surface it anywhere yet, but keeping the
// request shape identical means the two paths report the same billed
// tokens for the same URL and stay easy to reconcile. Kept duplicated
// with api/warm-summaries.ts per AGENTS.md § "Vercel api/ gotchas".
interface JinaReaderEnvelope {
  data?: {
    content?: unknown;
    usage?: { tokens?: unknown };
  };
}

async function fetchViaJina(
  articleUrl: string,
  jinaApiKey: string,
  deps: SummaryDeps,
): Promise<FetchOutcome> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JINA_TIMEOUT_MS);
  try {
    const res = await fetchFn(`${JINA_ENDPOINT}${articleUrl}`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${jinaApiKey}`,
        accept: 'application/json',
        'x-return-format': 'markdown',
      },
    });
    // 402 Payment Required / 429 Too Many Requests from Jina mean our
    // account has run out of paid credit or blown its rate-limit quota.
    // Surface this as its own failure mode so the handler can return a
    // distinct reason (operator-visible, client-visible) instead of
    // masquerading as "the article is unreachable".
    if (res.status === 402 || res.status === 429) {
      return { ok: false, failure: 'payment_required' };
    }
    if (!res.ok) return { ok: false, failure: 'unreachable' };
    let envelope: JinaReaderEnvelope;
    try {
      envelope = (await res.json()) as JinaReaderEnvelope;
    } catch {
      return { ok: false, failure: 'unreachable' };
    }
    const rawContent = envelope.data?.content;
    if (typeof rawContent !== 'string') {
      return { ok: false, failure: 'unreachable' };
    }
    const content = clampContent(rawContent);
    const rawTokens = envelope.data?.usage?.tokens;
    const tokens =
      typeof rawTokens === 'number' && Number.isFinite(rawTokens)
        ? rawTokens
        : undefined;
    if (!content) return { ok: false, failure: 'unreachable' };
    return { ok: true, content, tokens, paywalled: detectPaywall(content) };
  } catch (err) {
    return { ok: false, failure: isAbortError(err) ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

export async function handleSummaryRequest(
  request: Request,
  deps: SummaryDeps = {},
): Promise<Response> {
  if (!isAllowedReferer(request.headers.get('referer'))) {
    emitSummaryOutcome('error', null, 'forbidden');
    return json({ error: 'Forbidden' }, 403);
  }

  const { searchParams } = new URL(request.url);
  const storyId = parseStoryId(searchParams.get('id'));
  if (storyId === null) {
    emitSummaryOutcome('error', null, 'invalid_id');
    return json({ error: 'Invalid id parameter' }, 400);
  }

  const store =
    deps.store === undefined ? getDefaultStore() : deps.store;

  if (store) {
    // Fail-open at the handler layer too: if the store implementation
    // forgets to catch (the default Upstash one does, but tests and
    // future stores might not), KV trouble must not break the endpoint.
    // Any record present means "return it" — freshness is owned by the
    // cron, not by this read path.
    try {
      const cached = await store.get(storyId);
      if (cached) {
        emitSummaryOutcome('cached', storyId, undefined, {
          chars: cached.summary.length,
          ...(cached.paywalled !== undefined
            ? { paywalled: cached.paywalled }
            : {}),
        });
        return json({ summary: cached.summary, cached: true });
      }
    } catch {
      // fall through to live generation
    }
  }

  const fetchItem = deps.fetchItem ?? defaultFetchItem;
  let story: HNItem | null;
  try {
    story = await fetchItem(storyId, request.signal);
  } catch {
    emitSummaryOutcome('error', storyId, 'story_unreachable');
    return json(
      { error: 'Could not load story', reason: 'story_unreachable' },
      502,
    );
  }
  if (!story || story.deleted || story.dead) {
    emitSummaryOutcome('error', storyId, 'story_not_available');
    return json({ error: 'Story not available' }, 404);
  }
  // Anti-abuse floor. HN stories start at score 1 (the submitter's
  // implicit self-upvote), so `> 1` means "at least one organic
  // upvote beyond the submitter". Attackers can't just post a link and
  // have us fetch + summarize it via Jina / Gemini on demand — the
  // story has to earn a real upvote first. The feed itself hides
  // score ≤ 1 rows (see StoryList.tsx), so in normal usage this
  // endpoint will never even be invoked below the floor; the check is
  // a belt-and-braces defense for direct requests.
  if (!(typeof story.score === 'number' && story.score > 1)) {
    emitSummaryOutcome('error', storyId, 'low_score');
    return json(
      { error: 'Story is not eligible for summary', reason: 'low_score' },
      400,
    );
  }
  const hasArticleUrl = !!story.url && isValidHttpUrl(story.url);
  const selfPostBody = hasArticleUrl
    ? ''
    : clampContent(htmlToPlainText(story.text)) ?? '';
  if (!hasArticleUrl && !selfPostBody) {
    emitSummaryOutcome('error', storyId, 'no_article');
    return json(
      { error: 'Story has no article to summarize', reason: 'no_article' },
      400,
    );
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    emitSummaryOutcome('error', storyId, 'not_configured');
    return json(
      { error: 'Summary is not configured', reason: 'not_configured' },
      503,
    );
  }

  // Rate limit gate. Deliberately placed after every free validation
  // branch (story eligibility, self-post body, API-key presence) so
  // only requests that would actually pay Gemini / Jina consume quota;
  // 400s and 503s don't. Fail-open on missing client IP or Redis
  // trouble — see comments on applyRateLimit / checkRateLimit.
  const rateLimitResult = await applyRateLimit(request, deps);
  if (rateLimitResult && !rateLimitResult.ok) {
    emitSummaryOutcome('rate_limited', storyId, undefined);
    return rateLimited(rateLimitResult.retryAfterSeconds ?? 60);
  }

  let content: string;
  let prompt: string;
  let jinaTokens: number | undefined;
  // URL-post summaries: populated from Jina's detector verdict. Left
  // undefined on self-posts (no Jina round-trip, no overlay to detect).
  let paywalled: boolean | undefined;
  if (hasArticleUrl) {
    const articleUrl = story.url!;
    const jinaApiKey = deps.jinaApiKey ?? process.env.JINA_API_KEY;
    if (!jinaApiKey) {
      emitSummaryOutcome('error', storyId, 'not_configured');
      return json(
        { error: 'Summary is not configured', reason: 'not_configured' },
        503,
      );
    }
    const jinaResult = await fetchViaJina(articleUrl, jinaApiKey, deps);
    if (!jinaResult.ok) {
      if (jinaResult.failure === 'timeout') {
        emitSummaryOutcome('error', storyId, 'source_timeout');
        return json(
          {
            error: "The article site didn't respond in time",
            reason: 'source_timeout',
          },
          504,
        );
      }
      if (jinaResult.failure === 'payment_required') {
        // Jina rejected the fetch with 402 / 429 — our paid quota is
        // exhausted. Log loudly so operators notice; the endpoint returns
        // 503 rather than crashing so clients can render a graceful
        // "summaries temporarily unavailable" message.
        console.error(
          JSON.stringify({
            type: 'summary-jina-payment-required',
            storyId,
            articleUrl,
          }),
        );
        emitSummaryOutcome('error', storyId, 'summary_budget_exhausted');
        return json(
          {
            error: 'Summaries are temporarily unavailable',
            reason: 'summary_budget_exhausted',
          },
          503,
        );
      }
      emitSummaryOutcome('error', storyId, 'source_unreachable');
      return json(
        {
          error: 'Could not access the article',
          reason: 'source_unreachable',
        },
        502,
      );
    }
    content = jinaResult.content;
    jinaTokens = jinaResult.tokens;
    paywalled = jinaResult.paywalled;
    prompt = buildPrompt(articleUrl, content);
  } else {
    // Self-post path: Ask HN / Show HN / text-only. The body is already
    // in-hand via the Firebase item, so there's no Jina round-trip — the
    // only spend is the Gemini call itself.
    content = selfPostBody;
    prompt = buildSelfPostPrompt(story.title ?? '', content);
  }

  const client: SummaryClient = deps.createClient
    ? deps.createClient(apiKey)
    : (new GoogleGenAI({ apiKey }) as unknown as SummaryClient);

  let summary = '';
  let geminiPromptTokens: number | undefined;
  let geminiOutputTokens: number | undefined;
  let geminiTotalTokens: number | undefined;
  try {
    const response = await client.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        // Gemini 2.5 Flash-Lite runs hidden "thinking" tokens by default;
        // the one-sentence summary task doesn't need them and they
        // dominate wall-clock latency.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    summary = (response.text ?? '').trim();
    geminiPromptTokens = response.usageMetadata?.promptTokenCount;
    geminiOutputTokens = response.usageMetadata?.candidatesTokenCount;
    geminiTotalTokens = response.usageMetadata?.totalTokenCount;
  } catch {
    // falls through to the 502 below
  }

  if (!summary) {
    emitSummaryOutcome('error', storyId, 'summarization_failed', {
      geminiPromptTokens,
      geminiOutputTokens,
      geminiTotalTokens,
      jinaTokens,
    });
    return json(
      { error: 'Summarization failed', reason: 'summarization_failed' },
      502,
    );
  }

  if (isCaptchaRefusal(summary)) {
    emitSummaryOutcome('error', storyId, 'source_captcha', {
      geminiPromptTokens,
      geminiOutputTokens,
      geminiTotalTokens,
      jinaTokens,
    });
    return json(
      {
        error: 'Could not generate a summary due to a CAPTCHA page',
        reason: 'source_captcha',
      },
      502,
    );
  }

  if (store) {
    const now = (deps.now ?? Date.now)();
    const record: SummaryRecord = {
      summary,
      articleHash: hashArticle(content),
      firstSeenAt: now,
      summaryGeneratedAt: now,
      lastCheckedAt: now,
      lastChangedAt: now,
      // Persist so the warm-summaries cron can compute deltaBytes on
      // the next hash-change tick, instead of having to skip the
      // first observation after a user-facing write.
      contentBytes: Buffer.byteLength(content, 'utf8'),
      ...(paywalled !== undefined ? { paywalled } : {}),
    };
    const ttlSeconds = record.paywalled
      ? PAYWALLED_RECORD_TTL_SECONDS
      : RECORD_TTL_SECONDS;
    try {
      await store.set(storyId, record, ttlSeconds);
    } catch {
      // best-effort write
    }
  }
  emitSummaryOutcome('generated', storyId, undefined, {
    chars: summary.length,
    geminiPromptTokens,
    geminiOutputTokens,
    geminiTotalTokens,
    jinaTokens,
    ...(paywalled !== undefined ? { paywalled } : {}),
  });
  return json({ summary });
}

export async function GET(request: Request): Promise<Response> {
  return handleSummaryRequest(request);
}
