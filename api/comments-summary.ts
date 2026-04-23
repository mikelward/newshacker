import { GoogleGenAI } from '@google/genai';
import { Redis } from '@upstash/redis';
import { createHash } from 'node:crypto';

const MODEL = 'gemini-2.5-flash-lite';

// Inlined from api/summary.ts (same helper). Kept duplicated across
// handlers on purpose — Vercel's per-file function bundler has been
// flaky about tracing shared modules outside `api/`, and the helper is
// 20 LOC, not an abstraction worth its own file.
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

// Inlined from api/items.ts for the same reason as the referer helper.
interface HNItem {
  id?: number;
  type?: string;
  by?: string;
  time?: number;
  title?: string;
  url?: string;
  text?: string;
  score?: number;
  descendants?: number;
  dead?: boolean;
  deleted?: boolean;
  kids?: number[];
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

// Cap the number of top-level comments we feed the model. Matches the
// first-page prefetch size in src/components/Thread.tsx so the summary
// describes the same batch the reader sees without scrolling. Going
// higher would raise per-call token spend and latency without much
// improvement in signal — the loudest voices sit at the top.
export const TOP_LEVEL_SAMPLE_SIZE = 20;

// Cron owns freshness (see SPEC.md § "Scheduled warming and change
// analytics"): records live 30 days in Upstash and the warm cron
// re-hashes the top-20 transcript on ticks when the tiered backoff
// says a check is due, regenerating insights only when the hash
// changes. The old freshness-aware TTL (30 min young / 1 h older)
// is gone; user-facing /api/comments-summary now returns any present
// record unconditionally.
const RECORD_TTL_SECONDS = 60 * 60 * 24 * 30;

// Cache-Control on success. Same rationale as api/summary.ts: the shared
// cache lives in KV (Upstash), not the edge CDN, because the CDN is
// regional and a popular cross-region story would still pay one Gemini
// call per region. `private, no-store` keeps the function in the request
// path so KV is consulted; the service worker still caches per its own
// runtime rule (see vite.config.ts).
const NO_STORE_HEADER = 'private, no-store';

// === Rate limiting (inlined — shared bucket with api/summary.ts) ===
// See the matching block in api/summary.ts for the full rationale. Both
// handlers use the same key prefix so one thread view (article + comments)
// is 2 units against a single per-IP bucket. Cache misses only.
// Kept duplicated per AGENTS.md § "Vercel api/ gotchas".
export const RATE_LIMIT_KEY_PREFIX = 'newshacker:ratelimit:aisummary:';
const RATE_LIMIT_BURST_LIMIT_DEFAULT = 20;
const RATE_LIMIT_BURST_WINDOW_SECONDS = 600; // 10 min
const RATE_LIMIT_DAILY_LIMIT_DEFAULT = 200;
const RATE_LIMIT_DAILY_WINDOW_SECONDS = 86_400; // 24 h

export interface RateLimitStore {
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
  if (trimmed === '0' || trimmed === 'off') return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

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

// IPv6 /64 normalization — see api/summary.ts for why we key on /64.
export function normalizeIpForRateLimit(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(trimmed)) return trimmed;
  if (!trimmed.includes(':')) return trimmed;
  const addr = trimmed.split('%')[0]!;
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
      if (count === 1) {
        try {
          await redis.expire(key, windowSeconds);
        } catch {
          // Best-effort — see api/summary.ts for the full rationale.
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

export function _resetRateLimitStoreForTests(): void {
  defaultRateLimitStore = undefined;
}

// Max per-comment plaintext length fed into the prompt. Long comments
// are truncated to keep total prompt size bounded and predictable.
export const MAX_COMMENT_CHARS = 2000;

// Shared backend cache: see api/summary.ts for the rationale on Upstash
// over Vercel edge CDN, on the env-var fallback chain, and on why the
// per-instance Map was removed in favor of a single shared store.
//
// NOTE: the record shape is shared with api/warm-summaries.ts. Any
// schema change needs to land in both files in the same commit. Vercel's
// bundler doesn't reliably share modules between sibling `api/*.ts`
// handlers (see AGENTS.md § "Vercel api/ gotchas").
export const KV_KEY_PREFIX = 'newshacker:summary:comments:';

export interface CommentsSummaryRecord {
  insights: string[];
  // SHA-256 of the transcript fed to Gemini. See buildTranscript below.
  transcriptHash: string;
  firstSeenAt: number;
  summaryGeneratedAt: number;
  lastCheckedAt: number;
  lastChangedAt: number;
}

export interface CommentsSummaryStore {
  get(storyId: number): Promise<CommentsSummaryRecord | null>;
  set(
    storyId: number,
    record: CommentsSummaryRecord,
    ttlSeconds: number,
  ): Promise<void>;
}

let defaultStore: CommentsSummaryStore | null | undefined;

function createDefaultStore(): CommentsSummaryStore | null {
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
        return parseCommentsRecord(raw);
      } catch {
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

function getDefaultStore(): CommentsSummaryStore | null {
  if (defaultStore === undefined) defaultStore = createDefaultStore();
  return defaultStore;
}

// Pre-schema entries stored a bare `string[]`. Treat them as absent so
// the next cache-miss write overwrites with a full record. Also guards
// against schema drift and partial writes.
export function parseCommentsRecord(
  raw: unknown,
): CommentsSummaryRecord | null {
  if (raw == null) return null;
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
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const r = obj as Partial<CommentsSummaryRecord>;
  if (
    !Array.isArray(r.insights) ||
    !r.insights.every((s) => typeof s === 'string') ||
    typeof r.transcriptHash !== 'string' ||
    typeof r.firstSeenAt !== 'number' ||
    typeof r.summaryGeneratedAt !== 'number' ||
    typeof r.lastCheckedAt !== 'number' ||
    typeof r.lastChangedAt !== 'number'
  ) {
    return null;
  }
  return {
    insights: r.insights,
    transcriptHash: r.transcriptHash,
    firstSeenAt: r.firstSeenAt,
    summaryGeneratedAt: r.summaryGeneratedAt,
    lastCheckedAt: r.lastCheckedAt,
    lastChangedAt: r.lastChangedAt,
  };
}

export function hashTranscript(transcript: string): string {
  return createHash('sha256').update(transcript).digest('hex');
}

function parseStoryId(raw: string | null): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

// Minimal HTML-to-plaintext. HN comment bodies use a constrained subset
// (<p>, <i>, <b>, <a>, <pre>, <code>, <br>), so a tag strip + entity
// decode is enough to feed a language model — we don't need DOMPurify
// server-side.
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

// The exact string fed to Gemini. Exported so the warm cron can hash
// the same input and detect meaningful changes (top-20 reorderings,
// edits, deletions, newly-ranked comments).
export function buildTranscript(comments: HNItem[]): string {
  return comments
    .map((comment, index) => {
      const body = htmlToPlainText(comment.text).slice(0, MAX_COMMENT_CHARS);
      return `[#${index + 1}]\n${body}`;
    })
    .join('\n\n');
}

function buildPrompt(title: string | undefined, transcript: string): string {
  const header = title ? `Article title: ${title}\n\n` : '';
  return (
    `${header}Below are the top comments from a Hacker News discussion. ` +
    `Extract up to 5 of the most useful insights from the conversation — points ` +
    `of agreement, notable dissents, corrections, or interesting additions. ` +
    `Combine related points into a single insight rather than listing them ` +
    `separately. Only include genuinely useful points; if the discussion is ` +
    `thin, return fewer insights rather than padding with filler — returning ` +
    `3 or 4 is fine and preferable to inventing a fifth. Return no more than ` +
    `5 insights — do not exceed 5.\n\n` +
    `Each insight must state a specific claim about the subject matter. ` +
    `State it directly, as an assertion — not a meta-description of what the ` +
    `article or commenters are doing. Do not use phrases like "the article ` +
    `suggests", "is framed as", "commenters think", "the manifesto ` +
    `reflects", or "the comment highlights". Make the claim itself.\n\n` +
    `State each insight in the strongest form actually argued in the ` +
    `comments, not a diluted or hedged version. If commenters disagreed, ` +
    `the strongest version of each side is a valid insight.\n\n` +
    `When there are two equivalent ways to say something, prefer the ` +
    `simpler and more direct one: "is" over "functions as", "part of" over ` +
    `"a component of", "uses" over "utilizes", "helps" over "facilitates". ` +
    `Keep technical terms only where they are the precise word.\n\n` +
    `Use active voice with a concrete subject. Prefer "Phones with X are ` +
    `exempt" over "The regulation exempts phones with X"; "X drives Y" ` +
    `over "Y is driven by X".\n\n` +
    `Return one insight per line, each a single short sentence under 13 words. ` +
    `Do not include usernames, quotes, numbering, bullet markers, or markdown.\n\n` +
    `--- BEGIN COMMENTS ---\n${transcript}\n--- END COMMENTS ---`
  );
}

// Split the model's plain-text response into insight lines, stripping any
// stray bullet/number markers the model added despite instructions.
function parseInsights(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter((line) => line.length > 0);
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

async function applyRateLimit(
  request: Request,
  deps: CommentsSummaryDeps,
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

// Structured per-request telemetry. Paired with `summary-outcome` in
// api/summary.ts; same taxonomy (cached / generated / rate_limited /
// error) so a single monitor can aggregate across both endpoints.
// Kept inlined rather than imported per AGENTS.md § "Vercel api/
// gotchas" — helper is short and the events are a shared contract
// documented in OBSERVABILITY.md, not a shared module.
export type CommentsSummaryOutcome =
  | 'cached'
  | 'generated'
  | 'rate_limited'
  | 'error';

export interface CommentsSummaryOutcomeExtras {
  // Sum of characters across all emitted insights (so "total content
  // surfaced to the user" is a single metric, regardless of how many
  // insights the model returned).
  chars?: number;
  insightCount?: number;
  geminiPromptTokens?: number;
  geminiOutputTokens?: number;
  geminiTotalTokens?: number;
}

export function emitCommentsSummaryOutcome(
  outcome: CommentsSummaryOutcome,
  storyId: number | null,
  reason: string | undefined,
  extras: CommentsSummaryOutcomeExtras = {},
): void {
  const line: Record<string, unknown> = {
    type: 'comments-summary-outcome',
    endpoint: 'comments-summary',
    outcome,
  };
  if (storyId !== null) line.storyId = storyId;
  if (reason !== undefined) line.reason = reason;
  if (extras.chars !== undefined) line.chars = extras.chars;
  if (extras.insightCount !== undefined) {
    line.insightCount = extras.insightCount;
  }
  if (extras.geminiPromptTokens !== undefined) {
    line.geminiPromptTokens = extras.geminiPromptTokens;
  }
  if (extras.geminiOutputTokens !== undefined) {
    line.geminiOutputTokens = extras.geminiOutputTokens;
  }
  if (extras.geminiTotalTokens !== undefined) {
    line.geminiTotalTokens = extras.geminiTotalTokens;
  }
  console.log(JSON.stringify(line));
}

interface GenerateRequest {
  model: string;
  contents: string;
  config?: {
    thinkingConfig?: { thinkingBudget?: number };
  };
}

interface GenerateResponse {
  text?: string | null;
  // See note in api/summary.ts: Gemini returns authoritative billed-
  // token counts on every response, and we surface them on the
  // per-request telemetry so spend dashboards don't depend on GCP
  // billing as the sole source of truth.
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

export interface CommentsSummaryDeps {
  createClient?: (apiKey: string) => SummaryClient;
  fetchItem?: (id: number, signal?: AbortSignal) => Promise<HNItem | null>;
  now?: () => number;
  // `null` = explicitly disable the shared cache for this request;
  // `undefined` = use the default (lazy-initialised) Upstash store.
  store?: CommentsSummaryStore | null;
  // `null` = disable rate limiting for this request (test-only);
  // `undefined` = use the default Upstash-backed store.
  rateLimitStore?: RateLimitStore | null;
  rateLimitTiers?: RateLimitTier[];
}

export async function handleCommentsSummaryRequest(
  request: Request,
  deps: CommentsSummaryDeps = {},
): Promise<Response> {
  if (!isAllowedReferer(request.headers.get('referer'))) {
    emitCommentsSummaryOutcome('error', null, 'forbidden');
    return json({ error: 'Forbidden' }, 403);
  }

  const { searchParams } = new URL(request.url);
  const storyId = parseStoryId(searchParams.get('id'));
  if (storyId === null) {
    emitCommentsSummaryOutcome('error', null, 'invalid_id');
    return json({ error: 'Invalid id parameter' }, 400);
  }

  const now = deps.now ?? Date.now;
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
      if (cached && cached.insights.length > 0) {
        const chars = cached.insights.reduce((sum, s) => sum + s.length, 0);
        emitCommentsSummaryOutcome('cached', storyId, undefined, {
          chars,
          insightCount: cached.insights.length,
        });
        return json({ insights: cached.insights, cached: true });
      }
    } catch {
      // fall through to live generation
    }
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    emitCommentsSummaryOutcome('error', storyId, 'not_configured');
    return json({ error: 'Summary is not configured' }, 503);
  }

  const fetchItem = deps.fetchItem ?? defaultFetchItem;
  let story: HNItem | null;
  try {
    story = await fetchItem(storyId, request.signal);
  } catch {
    emitCommentsSummaryOutcome('error', storyId, 'story_unreachable');
    return json({ error: 'Could not load story' }, 502);
  }
  if (!story || story.deleted || story.dead) {
    emitCommentsSummaryOutcome('error', storyId, 'story_not_available');
    return json({ error: 'Story not available' }, 404);
  }
  // Anti-abuse floor — see the matching comment in api/summary.ts for
  // the rationale. `> 1` means at least one organic upvote beyond the
  // submitter's implicit self-vote.
  if (!(typeof story.score === 'number' && story.score > 1)) {
    emitCommentsSummaryOutcome('error', storyId, 'low_score');
    return json(
      { error: 'Story is not eligible for summary', reason: 'low_score' },
      400,
    );
  }

  const kidIds = (story.kids ?? []).slice(0, TOP_LEVEL_SAMPLE_SIZE);
  if (kidIds.length === 0) {
    emitCommentsSummaryOutcome('error', storyId, 'no_comments');
    return json({ error: 'No comments to summarize' }, 404);
  }

  const rawComments = await Promise.all(
    kidIds.map(async (id) => {
      try {
        return await fetchItem(id, request.signal);
      } catch {
        return null;
      }
    }),
  );
  const usableComments = rawComments.filter(
    (c): c is HNItem =>
      !!c && !c.deleted && !c.dead && typeof c.text === 'string',
  );

  if (usableComments.length === 0) {
    emitCommentsSummaryOutcome('error', storyId, 'no_comments');
    return json({ error: 'No comments to summarize' }, 404);
  }

  // Rate limit gate — placed after every free validation branch (story
  // eligibility, kids exist, usable comments exist) and after the API
  // key check so only requests that would actually pay Gemini consume
  // quota. See api/summary.ts for the shared-bucket rationale.
  const rateLimitResult = await applyRateLimit(request, deps);
  if (rateLimitResult && !rateLimitResult.ok) {
    emitCommentsSummaryOutcome('rate_limited', storyId, undefined);
    return rateLimited(rateLimitResult.retryAfterSeconds ?? 60);
  }

  const transcript = buildTranscript(usableComments);

  const client: SummaryClient = deps.createClient
    ? deps.createClient(apiKey)
    : (new GoogleGenAI({ apiKey }) as unknown as SummaryClient);

  let rawResponse = '';
  let geminiPromptTokens: number | undefined;
  let geminiOutputTokens: number | undefined;
  let geminiTotalTokens: number | undefined;
  try {
    const response = await client.models.generateContent({
      model: MODEL,
      contents: buildPrompt(story.title, transcript),
      config: {
        // Gemini 2.5 runs hidden "thinking" tokens by default; for this
        // extractive task they dominate latency without improving output
        // quality. Disable.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    rawResponse = (response.text ?? '').trim();
    geminiPromptTokens = response.usageMetadata?.promptTokenCount;
    geminiOutputTokens = response.usageMetadata?.candidatesTokenCount;
    geminiTotalTokens = response.usageMetadata?.totalTokenCount;
  } catch {
    emitCommentsSummaryOutcome('error', storyId, 'summarization_failed', {
      geminiPromptTokens,
      geminiOutputTokens,
      geminiTotalTokens,
    });
    return json({ error: 'Summarization failed' }, 502);
  }

  const insights = parseInsights(rawResponse);
  if (insights.length === 0) {
    emitCommentsSummaryOutcome('error', storyId, 'summarization_failed', {
      geminiPromptTokens,
      geminiOutputTokens,
      geminiTotalTokens,
    });
    return json({ error: 'Summarization failed' }, 502);
  }

  if (store) {
    const nowMs = now();
    const record: CommentsSummaryRecord = {
      insights,
      transcriptHash: hashTranscript(transcript),
      firstSeenAt: nowMs,
      summaryGeneratedAt: nowMs,
      lastCheckedAt: nowMs,
      lastChangedAt: nowMs,
    };
    try {
      await store.set(storyId, record, RECORD_TTL_SECONDS);
    } catch {
      // best-effort write
    }
  }
  const chars = insights.reduce((sum, s) => sum + s.length, 0);
  emitCommentsSummaryOutcome('generated', storyId, undefined, {
    chars,
    insightCount: insights.length,
    geminiPromptTokens,
    geminiOutputTokens,
    geminiTotalTokens,
  });
  return json({ insights });
}

export async function GET(request: Request): Promise<Response> {
  return handleCommentsSummaryRequest(request);
}
