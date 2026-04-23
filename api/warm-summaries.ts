// Scheduled cache warmer for /api/summary *and* /api/comments-summary.
//
// Runs on a Vercel cron (see vercel.json). Every tick:
//   1. fetches the requested HN feed (topstories by default),
//   2. takes the first N eligible ids,
//   3. for each, processes two independent tracks in parallel:
//        - article track: re-fetches the article (Jina first, raw HTML
//          fallback), SHA-256 hashes it, compares against the stored
//          articleHash, regenerates the one-sentence summary via Gemini
//          only on hash change.
//        - comments track: fetches the top-20 top-level comments, builds
//          the same transcript /api/comments-summary feeds to Gemini,
//          SHA-256 hashes it, compares against the stored transcriptHash,
//          regenerates the insights bullets only on hash change.
//      Each track has its own cache record (article key vs comments key)
//      and its own tiered backoff state, so a chatty thread and a stable
//      article don't block each other.
//
// Three jobs in one: keep the cache warm for the feed's hottest stories
// (faster user-facing loads for both summary cards), emit structured
// JSON logs we can later analyse to tune the backoff / TTL knobs, and
// avoid spending Gemini tokens on content that hasn't changed.
//
// See AGENTS.md § "Vercel api/ gotchas" for why this file duplicates
// helpers that also live in api/summary.ts and api/comments-summary.ts.

import { GoogleGenAI } from '@google/genai';
import { Redis } from '@upstash/redis';
import { createHash } from 'node:crypto';

const MODEL = 'gemini-2.5-flash-lite';
const RECORD_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

const MAX_URL_LEN = 2048;
const MAX_CONTENT_CHARS = 200_000;

const JINA_ENDPOINT = 'https://r.jina.ai/';
const JINA_TIMEOUT_MS = 15_000;
// The raw-HTML fallback (plain GET with a spoofed Chrome UA) was
// removed along with the matching path in api/summary.ts. See
// TODO.md § "Article-fetch fallback" for context. Jina is the only
// article-fetch path now.

const HN_ITEM_URL = (id: number) =>
  `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

// Feed slice → HN firebase endpoint path (without the .json suffix). Keep
// in sync with src/lib/feeds.ts; this handler duplicates the mapping rather
// than importing because Vercel's bundler isn't reliable about cross-dir
// imports (see AGENTS.md § "Vercel api/ gotchas").
const FEED_ENDPOINTS = {
  top: 'topstories',
  new: 'newstories',
  best: 'beststories',
  ask: 'askstories',
  show: 'showstories',
  jobs: 'jobstories',
} as const;
export type WarmFeed = keyof typeof FEED_ENDPOINTS;
const DEFAULT_FEED: WarmFeed = 'top';
// Per-request `?n=` hard ceiling. Stops a rogue request from kicking off
// a thousand Jina calls. The cron's typical slice is 30.
const MAX_N = 100;

// Kept in sync with api/summary.ts — any schema change needs to land
// in both files in the same commit.
const KV_KEY_PREFIX = 'newshacker:summary:article:';
// Matches api/comments-summary.ts.
const COMMENTS_KV_KEY_PREFIX = 'newshacker:summary:comments:';

// Comments track constants — mirror api/comments-summary.ts.
const TOP_LEVEL_SAMPLE_SIZE = 20;
const MAX_COMMENT_CHARS = 2000;

// Default knobs. All env-tunable so the backoff can be dialled without
// a redeploy. Units are seconds (except TOP_N / MIN_KIDS).
const DEFAULT_REFRESH_CHECK_INTERVAL = 60 * 30; // 30 min for fresh stories
const DEFAULT_STABLE_CHECK_INTERVAL = 60 * 60 * 2; // 2 h for stable stories
const DEFAULT_STABLE_THRESHOLD = 60 * 60 * 6; // "stable" = unchanged ≥ 6 h
const DEFAULT_MAX_STORY_AGE = 60 * 60 * 32; // give up after 32 h (article track)
const DEFAULT_TOP_N = 30;
// Comments-track tiered schedule: a doubling ladder keyed off HN
// story age (now − story.time). The first tier whose maxAge the
// story is still under decides the re-check interval. Past the
// last tier (and past commentsMaxStoryAgeSeconds), we stop
// checking entirely and log skipped_age. Bucket widths match the
// analytics buckets in `ageBand` (1h, 2h, 4h, 8h, 16h, 32h) so
// "changed per ageBand" and "polled per ageBand" share the same
// x-axis tomorrow. Intervals are ~bucket-width / 4, so each
// story gets roughly four polls per bucket before aging into the
// next.
export interface CommentsTier {
  maxAgeSeconds: number;
  intervalSeconds: number;
}
const COMMENTS_TIERS: CommentsTier[] = [
  { maxAgeSeconds: 60 * 60 * 1, intervalSeconds: 60 * 15 },
  { maxAgeSeconds: 60 * 60 * 2, intervalSeconds: 60 * 30 },
  { maxAgeSeconds: 60 * 60 * 4, intervalSeconds: 60 * 60 },
  { maxAgeSeconds: 60 * 60 * 8, intervalSeconds: 60 * 120 },
  { maxAgeSeconds: 60 * 60 * 16, intervalSeconds: 60 * 240 },
  { maxAgeSeconds: 60 * 60 * 32, intervalSeconds: 60 * 480 },
];
const DEFAULT_COMMENTS_MAX_AGE = 60 * 60 * 32; // give up after 32 h (comments track)
// Minimum usable top-level comments required before the *cron*
// creates a comments-summary record (first_seen). Stops the cron from
// burning Gemini on a 2-comment thread that will look completely
// different in 20 minutes. User-facing /api/comments-summary is not
// gated by this — a human who navigates to a thin thread still gets
// whatever summary is possible.
const DEFAULT_COMMENTS_MIN_KIDS = 5;

// Upper bound on how long a single cron tick may spend. Pro functions
// default to 60s; we leave headroom so the logger can flush.
const WALL_CLOCK_BUDGET_MS = 50_000;

// Concurrency for per-story processing. Jina's own per-article timeout
// is 15s; with 5-wide parallelism the 30-story budget fits comfortably.
const CONCURRENCY = 5;

export interface WarmKnobs {
  refreshCheckIntervalSeconds: number;
  stableCheckIntervalSeconds: number;
  stableThresholdSeconds: number;
  maxStoryAgeSeconds: number;
  topN: number;
  // Comments-track-specific tuning. The tier ladder itself is a
  // compile-time constant (COMMENTS_TIERS); only the stop-age is
  // env-tunable, so an operator can shorten or extend the
  // comments track without redeploying. Tuning the ladder shape
  // requires a code change, on purpose — the bucket widths double
  // by design and match the ageBand analytics axis.
  commentsMaxStoryAgeSeconds: number;
  commentsMinKids: number;
}

export function readKnobs(env: NodeJS.ProcessEnv = process.env): WarmKnobs {
  return {
    refreshCheckIntervalSeconds: parsePositiveInt(
      env.WARM_REFRESH_CHECK_INTERVAL_SECONDS,
      DEFAULT_REFRESH_CHECK_INTERVAL,
    ),
    stableCheckIntervalSeconds: parsePositiveInt(
      env.WARM_STABLE_CHECK_INTERVAL_SECONDS,
      DEFAULT_STABLE_CHECK_INTERVAL,
    ),
    stableThresholdSeconds: parsePositiveInt(
      env.WARM_STABLE_THRESHOLD_SECONDS,
      DEFAULT_STABLE_THRESHOLD,
    ),
    maxStoryAgeSeconds: parsePositiveInt(
      env.WARM_MAX_STORY_AGE_SECONDS,
      DEFAULT_MAX_STORY_AGE,
    ),
    topN: parsePositiveInt(env.WARM_TOP_N, DEFAULT_TOP_N),
    commentsMaxStoryAgeSeconds: parsePositiveInt(
      env.WARM_COMMENTS_MAX_AGE_SECONDS,
      DEFAULT_COMMENTS_MAX_AGE,
    ),
    commentsMinKids: parsePositiveInt(
      env.WARM_COMMENTS_MIN_KIDS,
      DEFAULT_COMMENTS_MIN_KIDS,
    ),
  };
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

// Matches api/summary.ts + api/comments-summary.ts — kept in lockstep.
// The comments-summary fields (`text`, `kids`, `title`, `time`) are
// needed by the comments track; the article track ignores them.
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

export interface SummaryRecord {
  summary: string;
  articleHash: string;
  firstSeenAt: number;
  summaryGeneratedAt: number;
  lastCheckedAt: number;
  lastChangedAt: number;
  // Byte length of the Jina-clean body that produced `articleHash`.
  // Optional — pre-instrumentation records lack it, so the first
  // observation after deploy emits no `deltaBytes` on `changed`.
  contentBytes?: number;
}

export interface SummaryStore {
  get(storyId: number): Promise<SummaryRecord | null>;
  set(
    storyId: number,
    record: SummaryRecord,
    ttlSeconds: number,
  ): Promise<void>;
}

function parseRecord(raw: unknown): SummaryRecord | null {
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
  };
}

export function hashArticle(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// Comments track: mirror of SummaryRecord / SummaryStore with
// insights[] and transcriptHash. Kept in lockstep with
// api/comments-summary.ts.
export interface CommentsSummaryRecord {
  insights: string[];
  transcriptHash: string;
  firstSeenAt: number;
  summaryGeneratedAt: number;
  lastCheckedAt: number;
  lastChangedAt: number;
  // Byte length of the transcript that produced `transcriptHash`.
  // Optional for the same reason as SummaryRecord.contentBytes.
  transcriptBytes?: number;
}

export interface CommentsSummaryStore {
  get(storyId: number): Promise<CommentsSummaryRecord | null>;
  set(
    storyId: number,
    record: CommentsSummaryRecord,
    ttlSeconds: number,
  ): Promise<void>;
}

function parseCommentsRecord(raw: unknown): CommentsSummaryRecord | null {
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
    ...(typeof r.transcriptBytes === 'number' &&
    Number.isFinite(r.transcriptBytes)
      ? { transcriptBytes: r.transcriptBytes }
      : {}),
  };
}

export function hashTranscript(transcript: string): string {
  return createHash('sha256').update(transcript).digest('hex');
}

// Mirrors api/comments-summary.ts — HN comment bodies use a constrained
// subset so a tag strip + entity decode is enough to feed a model.
function htmlToPlainText(input: string | undefined): string {
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

// Exact same transcript shape api/comments-summary.ts feeds to Gemini.
// Must stay in lockstep so the hashes match across both handlers.
function buildTranscript(comments: HNItem[]): string {
  return comments
    .map((comment, index) => {
      const body = htmlToPlainText(comment.text).slice(0, MAX_COMMENT_CHARS);
      return `[#${index + 1}]\n${body}`;
    })
    .join('\n\n');
}

// Same prompt as api/comments-summary.ts — kept in lockstep so a
// cron-warmed cache hit returns the same shape the user-facing handler
// would have produced.
function buildCommentsPrompt(
  title: string | undefined,
  transcript: string,
): string {
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

function parseInsights(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter((line) => line.length > 0);
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
        // best-effort write
      }
    },
  };
}

function getDefaultStore(): SummaryStore | null {
  if (defaultStore === undefined) defaultStore = createDefaultStore();
  return defaultStore;
}

let defaultCommentsStore: CommentsSummaryStore | null | undefined;

function createDefaultCommentsStore(): CommentsSummaryStore | null {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const redis = new Redis({ url, token });
  return {
    async get(storyId) {
      try {
        const raw = await redis.get<unknown>(
          `${COMMENTS_KV_KEY_PREFIX}${storyId}`,
        );
        return parseCommentsRecord(raw);
      } catch {
        return null;
      }
    },
    async set(storyId, record, ttlSeconds) {
      try {
        await redis.set(
          `${COMMENTS_KV_KEY_PREFIX}${storyId}`,
          JSON.stringify(record),
          { ex: ttlSeconds },
        );
      } catch {
        // best-effort
      }
    },
  };
}

function getDefaultCommentsStore(): CommentsSummaryStore | null {
  if (defaultCommentsStore === undefined)
    defaultCommentsStore = createDefaultCommentsStore();
  return defaultCommentsStore;
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

// Lowercased bare host, e.g. "example.com" — used as the `urlHost`
// field on article-track logs for per-publisher rollups.
function parseUrlHost(value: string | undefined): string | undefined {
  if (!value || typeof value !== 'string') return undefined;
  try {
    return new URL(value).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

function clampContent(body: string): string | null {
  const trimmed =
    body.length > MAX_CONTENT_CHARS ? body.slice(0, MAX_CONTENT_CHARS) : body;
  const clean = trimmed.trim();
  return clean || null;
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

type FetchFailure = 'timeout' | 'unreachable' | 'payment_required';
type FetchOutcome =
  | { ok: true; content: string; tokens?: number }
  | { ok: false; failure: FetchFailure };

// Jina's JSON envelope: { code, status, data: { content, usage: { tokens } } }.
// We ask for JSON (rather than plain text) so the response carries an
// authoritative `usage.tokens` count — cheaper and more accurate than
// estimating tokens from content length client-side. Mirrored in
// api/summary.ts; keep the two in sync.
interface JinaReaderEnvelope {
  data?: {
    content?: unknown;
    usage?: { tokens?: unknown };
  };
}

async function fetchViaJina(
  articleUrl: string,
  jinaApiKey: string,
  fetchFn: typeof fetch,
): Promise<FetchOutcome> {
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
    // Jina's 402 / 429 mean our paid quota is gone. Return a distinct
    // failure so the cron can log `skipped_payment_required` instead of
    // noisily reporting every story as "unreachable" and burning through
    // retries while the quota is empty. Mirrors api/summary.ts.
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
    if (!content) return { ok: false, failure: 'unreachable' };
    const rawTokens = envelope.data?.usage?.tokens;
    const tokens = typeof rawTokens === 'number' && Number.isFinite(rawTokens)
      ? rawTokens
      : undefined;
    return { ok: true, content, tokens };
  } catch (err) {
    return { ok: false, failure: isAbortError(err) ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
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

// Kept in lockstep with api/summary.ts — self-post variant used when a
// story has no external URL but does have `text`. See the comment there
// for rationale.
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
}

export interface SummaryClient {
  models: {
    generateContent(req: GenerateRequest): Promise<GenerateResponse>;
  };
}

// Auth for the cron endpoint. Vercel sends `Authorization: Bearer
// <CRON_SECRET>` when the env var is set; requests without a matching
// secret are rejected. If CRON_SECRET is missing, fail *closed* in
// production-like environments — a misconfigured deploy that dropped
// the env var should not expose this expensive warmer publicly. Only
// explicit dev / test modes (NODE_ENV=development|test or
// VERCEL_ENV=development) fall back to open access so local runs and
// `vercel dev` previews keep working without Vercel-Cron signing
// requests.
function isOpenCronAccessAllowed(): boolean {
  return (
    process.env.NODE_ENV === 'development' ||
    process.env.NODE_ENV === 'test' ||
    process.env.VERCEL_ENV === 'development'
  );
}

export function isAuthorizedCronRequest(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return isOpenCronAccessAllowed();
  const header = request.headers.get('authorization');
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return match[1].trim() === expected;
}

export type WarmTrack = 'article' | 'comments';

export type CheckOutcome =
  | 'skipped_age'
  | 'skipped_interval'
  | 'skipped_low_score'
  // Article-track only: the story has no external URL.
  // Comments-track only: the story has no kids[] at all.
  | 'skipped_no_content'
  // Comments-track only: the cron won't create a first_seen record
  // until there are at least WARM_COMMENTS_MIN_KIDS usable top-level
  // comments. Stops us from caching insights generated from 2 comments
  // that will be unrecognisable 20 minutes later.
  | 'skipped_low_volume'
  | 'skipped_unreachable'
  // Jina returned 402 / 429 — our paid article-fetch quota is exhausted.
  // Logged distinctly from skipped_unreachable so an operator can tell
  // "the whole cron is skipping because we're out of credit" from
  // "this particular article host is blocking Jina".
  | 'skipped_payment_required'
  | 'skipped_budget'
  | 'first_seen'
  | 'unchanged'
  | 'changed'
  | 'error';

export interface StoryLog {
  type: 'warm-story';
  track: WarmTrack;
  storyId: number;
  outcome: CheckOutcome;
  // All durations in minutes, rounded to 1 decimal. Missing when the
  // corresponding timestamp isn't known yet.
  ageMinutes?: number;
  // Story age since HN submission (`now − story.time`), in minutes.
  // Derived from the HN item — present on every log line where we
  // loaded the story and it carries a `time` field, regardless of
  // track or outcome. `ageMinutes` (above) is cache age, not story
  // age; they diverge for any record whose first_seen trailed the
  // HN submission. For the tiered comments schedule and the "how
  // often does an article change per age band" analytics, story
  // age is the right axis.
  storyAgeMinutes?: number;
  // Coarse band derived from storyAgeMinutes — grouping axis for
  // APL queries that want "changed-per-band" without bucketing
  // the raw number. Present whenever storyAgeMinutes is present.
  // On the comments track the ladder intervals are keyed off the
  // same bucket widths, so `ageBand` doubles as the tier label.
  ageBand?: AgeBand;
  stableForMinutes?: number;
  sinceLastCheckMinutes?: number;
  // Article track: whether the regenerated Gemini summary text differs
  // from the prior one (can differ even on an unchanged hash in theory
  // — we only regenerate on hash change, so this is effectively a
  // drift signal).
  summaryChanged?: boolean;
  // Comments track: whether the regenerated insights differ from prior.
  insightsChanged?: boolean;
  // Article track: post-clamp byte length of the clean markdown Jina
  // produced this tick. Cross-correlate successive lines for the same
  // storyId to distinguish "real edit" (multi-KB delta) from
  // "timestamp / cache-buster churn" (tiny delta, Jina's markdown
  // still flipped because the in-body timestamp moved). On `changed`
  // entries the `deltaBytes` field below does that cross-correlation
  // for you — one column instead of a self-join.
  contentBytes?: number;
  // On `changed` outcomes: `|contentBytes_now − contentBytes_prev|`
  // for articles, `|transcriptBytes_now − transcriptBytes_prev|` for
  // comments. Lets a single APL query separate noise (small delta
  // from an in-body timestamp flip) from real edits (multi-KB
  // delta). Absent on `changed` only when the prior record predates
  // the contentBytes / transcriptBytes persistence (legacy records);
  // the next `changed` tick populates it.
  deltaBytes?: number;
  // Article track: Jina Reader's billed token count for this fetch
  // (from the `usage.tokens` field of the JSON response). Missing when
  // we didn't call Jina this tick (skipped_*, self-posts) or when Jina
  // omitted the field. The run-level `articleTokensTotal` rolls these
  // up so operators can watch for budget drift without post-processing
  // the per-story lines.
  tokens?: number;
  // Article track: `story.url`'s lowercased hostname. Present on
  // every line where the HN item was loaded and the story has a
  // valid URL — first_seen / unchanged / changed and the in-function
  // skipped_* outcomes. Absent on the two pre-fetch fallbacks
  // (skipped_budget and the runPool error) which fire before the
  // story is fetched.
  urlHost?: string;
  // Comments track analogues:
  //   commentCount    = usable top-level comments fed to the model
  //                     (≤ TOP_LEVEL_SAMPLE_SIZE; less when some were
  //                     deleted / dead / text-less).
  //   transcriptBytes = byte length of the transcript we hashed.
  // Together these let an analyst distinguish "the same 20 comments
  // edited their wording" (transcriptBytes shifts a little) from "a
  // new comment rose into the top-20" (likely a larger shift, plus
  // commentCount stays at 20 when the thread is healthy).
  commentCount?: number;
  transcriptBytes?: number;
}

// Per-track outcome tallies on the run log so we can separate article
// churn from comments churn without post-processing the per-story logs.
export interface TrackOutcomes {
  article: Record<CheckOutcome, number>;
  comments: Record<CheckOutcome, number>;
}

export interface RunLog {
  type: 'warm-run';
  durationMs: number;
  // Number of (track, story) observations. Up to 2 × storyCount when
  // every story has both a URL and comments.
  processed: number;
  storyCount: number;
  outcomes: TrackOutcomes;
  topNRequested: number;
  feed: WarmFeed;
  knobs: WarmKnobs;
  // Sum of per-story article-track `tokens` values for this run — the
  // authoritative Jina-billed token count. Roll across runs to spot
  // budget drift before the 402 / 429 cliff hits.
  articleTokensTotal: number;
}

type Logger = (entry: StoryLog | RunLog) => void;

function defaultLogger(entry: StoryLog | RunLog): void {
  // Structured JSON lines — single `log` call so Vercel ingests them as
  // one record each. Easier to grep / pipe into analysis later.
  console.log(JSON.stringify(entry));
}

function emptyOutcomeCounts(): Record<CheckOutcome, number> {
  return {
    skipped_age: 0,
    skipped_interval: 0,
    skipped_low_score: 0,
    skipped_no_content: 0,
    skipped_low_volume: 0,
    skipped_unreachable: 0,
    skipped_payment_required: 0,
    skipped_budget: 0,
    first_seen: 0,
    unchanged: 0,
    changed: 0,
    error: 0,
  };
}

function emptyTrackOutcomes(): TrackOutcomes {
  return { article: emptyOutcomeCounts(), comments: emptyOutcomeCounts() };
}

// Minimal shape the backoff needs. Both SummaryRecord and
// CommentsSummaryRecord satisfy it — the decision logic doesn't care
// which track it's looking at.
interface BackoffState {
  lastChangedAt: number;
  lastCheckedAt: number;
}

// Article-track decision: flat fresh interval until the content has
// been unchanged ≥ stableThreshold, then the longer stable interval.
// No story-age tiering on the article track — articles don't grow
// after publication, and the coarse "fresh vs stable" split is what
// the analytics in ageBand/storyAgeMinutes are there to tune.
export function decideInterval(
  record: BackoffState,
  now: number,
  knobs: WarmKnobs,
): { shouldCheck: boolean; stableFor: number } {
  const stableFor = Math.max(0, now - record.lastChangedAt);
  const sinceLastCheck = Math.max(0, now - record.lastCheckedAt);
  const interval =
    stableFor >= knobs.stableThresholdSeconds * 1000
      ? knobs.stableCheckIntervalSeconds * 1000
      : knobs.refreshCheckIntervalSeconds * 1000;
  return { shouldCheck: sinceLastCheck >= interval, stableFor };
}

// Comments-track decision: a doubling ladder of story-age bands,
// short-circuited by the same stable-interval rule as the article
// track. Stable wins even inside a short tier — a thread that's
// been unchanged ≥ stableThreshold doesn't need tier-1 polling.
// Tier selection is surfaced via `ageBand` on the log line (bucket
// widths match the ladder 1:1), not a separate field.
export function decideCommentsInterval(
  record: BackoffState,
  story: HNItem | null,
  now: number,
  knobs: WarmKnobs,
): { shouldCheck: boolean; stableFor: number } {
  const stableFor = Math.max(0, now - record.lastChangedAt);
  const sinceLastCheck = Math.max(0, now - record.lastCheckedAt);
  if (stableFor >= knobs.stableThresholdSeconds * 1000) {
    return {
      shouldCheck: sinceLastCheck >= knobs.stableCheckIntervalSeconds * 1000,
      stableFor,
    };
  }
  const storyAge = storyAgeMs(story, now);
  if (storyAge === undefined) {
    // No HN timestamp to place the story on the ladder — fall back
    // to the flat fresh interval so we keep checking at a sensible
    // cadence rather than defaulting to the shortest tier and
    // over-polling.
    return {
      shouldCheck: sinceLastCheck >= knobs.refreshCheckIntervalSeconds * 1000,
      stableFor,
    };
  }
  for (const tier of COMMENTS_TIERS) {
    if (storyAge <= tier.maxAgeSeconds * 1000) {
      return {
        shouldCheck: sinceLastCheck >= tier.intervalSeconds * 1000,
        stableFor,
      };
    }
  }
  // Past the last tier — caller will already have hit the max-age
  // skip; this is just a safe fall-through.
  return { shouldCheck: false, stableFor };
}

// Age axis used by the analytics and the tiered schedule. `story.time`
// is the HN submission time in Unix seconds. Returns undefined when
// the HN item isn't loaded or lacks a time field.
function storyAgeMs(story: HNItem | null, now: number): number | undefined {
  if (!story || typeof story.time !== 'number') return undefined;
  return Math.max(0, now - story.time * 1000);
}

// Coarse story-age band, derived from story age in minutes. These
// buckets match the comments-tier ladder so a query like "changed
// outcomes by ageBand" lines up with the thresholds operators are
// tuning. Also used on article entries so the article-side "when
// does an article's hash actually change" question has a ready-made
// grouping key.
export type AgeBand =
  | '0-1h'
  | '1-2h'
  | '2-4h'
  | '4-8h'
  | '8-16h'
  | '16-32h'
  | '32h+';

export function ageBandFromMinutes(ageMin: number): AgeBand {
  const h = ageMin / 60;
  if (h < 1) return '0-1h';
  if (h < 2) return '1-2h';
  if (h < 4) return '2-4h';
  if (h < 8) return '4-8h';
  if (h < 16) return '8-16h';
  if (h < 32) return '16-32h';
  return '32h+';
}

export interface WarmDeps {
  createClient?: (apiKey: string) => SummaryClient;
  fetchImpl?: typeof fetch;
  fetchFeedIds?: (feed: WarmFeed, signal?: AbortSignal) => Promise<number[]>;
  fetchItem?: (id: number, signal?: AbortSignal) => Promise<HNItem | null>;
  jinaApiKey?: string;
  // `undefined` = use the lazy-initialised Upstash store for that
  // track. `null` explicitly disables that store. Both stores are
  // required for a successful run — passing `null` for either
  // short-circuits the whole handler to 503, it does not run only
  // the other track. (Per-track disable would be a feature addition,
  // not a current contract.)
  store?: SummaryStore | null;
  commentsStore?: CommentsSummaryStore | null;
  now?: () => number;
  knobs?: Partial<WarmKnobs>;
  logger?: Logger;
}

async function defaultFetchFeedIds(
  feed: WarmFeed,
  signal?: AbortSignal,
): Promise<number[]> {
  const endpoint = FEED_ENDPOINTS[feed];
  const res = await fetch(
    `https://hacker-news.firebaseio.com/v0/${endpoint}.json`,
    { signal },
  );
  if (!res.ok) throw new Error(`${endpoint} ${res.status}`);
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) return [];
  return data.filter((n): n is number => Number.isSafeInteger(n) && n > 0);
}

export function parseWarmFeed(raw: string | null): WarmFeed | null {
  if (!raw) return DEFAULT_FEED;
  return raw in FEED_ENDPOINTS ? (raw as WarmFeed) : null;
}

export function parseWarmN(raw: string | null, fallback: number): number | null {
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_N) return null;
  return n;
}

async function defaultFetchItem(
  id: number,
  signal?: AbortSignal,
): Promise<HNItem | null> {
  const res = await fetch(HN_ITEM_URL(id), { signal });
  if (!res.ok) return null;
  return (await res.json()) as HNItem | null;
}

function minutes(ms: number): number {
  return Math.round((ms / 60_000) * 10) / 10;
}

// Simple promise pool. Keeps at most `concurrency` workers in flight;
// returns an array in input order. Each task is isolated — one
// exception doesn't cancel the others. The `onError` hook turns a
// thrown error into a value of the same shape the worker returns, so
// the caller gets a uniform results array without having to know which
// entries failed.
async function runPool<T, R>(
  inputs: T[],
  concurrency: number,
  worker: (input: T, index: number) => Promise<R>,
  onError: (error: unknown, input: T, index: number) => R,
): Promise<R[]> {
  const results: R[] = new Array(inputs.length);
  let cursor = 0;
  async function step(): Promise<void> {
    while (cursor < inputs.length) {
      const i = cursor++;
      try {
        results[i] = await worker(inputs[i]!, i);
      } catch (err) {
        results[i] = onError(err, inputs[i]!, i);
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, inputs.length) },
    () => step(),
  );
  await Promise.all(workers);
  return results;
}

interface StoryContext {
  deps: WarmDeps;
  knobs: WarmKnobs;
  now: number;
  fetchFn: typeof fetch;
  jinaApiKey: string | undefined;
  apiKey: string | null;
  // Propagated from request.signal so a Vercel-level function abort
  // (wall-clock or otherwise) cancels in-flight HN and Jina fetches
  // instead of letting them hang to completion.
  signal?: AbortSignal;
}

function makeLog(track: WarmTrack, storyId: number) {
  return (extra: Partial<StoryLog>): StoryLog => ({
    type: 'warm-story',
    track,
    storyId,
    outcome: extra.outcome ?? 'error',
    ...extra,
  });
}

// Article-track skip gate: cache-age cutoff (WARM_MAX_STORY_AGE_SECONDS)
// plus the fresh/stable interval from decideInterval.
function shouldSkipArticleByBackoff(
  existing: BackoffState & { firstSeenAt: number },
  now: number,
  knobs: WarmKnobs,
): { skip: CheckOutcome | null; stableFor: number } {
  if (now - existing.firstSeenAt > knobs.maxStoryAgeSeconds * 1000) {
    return { skip: 'skipped_age', stableFor: 0 };
  }
  const { shouldCheck, stableFor } = decideInterval(existing, now, knobs);
  if (!shouldCheck) return { skip: 'skipped_interval', stableFor };
  return { skip: null, stableFor };
}

// Comments-track skip gate: uses the comments-specific max age
// (WARM_COMMENTS_MAX_AGE_SECONDS, default 32h — shorter than the
// article track because the tier ladder already covers 0-32h and
// beyond is ~always a dead thread) plus the tier ladder from
// decideCommentsInterval. Unlike the article gate, this also
// measures aging against HN `story.time` when available, not just
// firstSeenAt — so a story the cron only first-saw at hour 5 still
// ages out at the 32h HN-submission mark rather than 37h cache-age.
// Falls back to cache age when `story.time` isn't available (e.g.
// HN item fetch failed this tick).
function shouldSkipCommentsByBackoff(
  existing: BackoffState & { firstSeenAt: number },
  story: HNItem | null,
  now: number,
  knobs: WarmKnobs,
): { skip: CheckOutcome | null; stableFor: number } {
  const ageMs = storyAgeMs(story, now) ?? now - existing.firstSeenAt;
  if (ageMs > knobs.commentsMaxStoryAgeSeconds * 1000) {
    return { skip: 'skipped_age', stableFor: 0 };
  }
  const { shouldCheck, stableFor } = decideCommentsInterval(
    existing,
    story,
    now,
    knobs,
  );
  if (!shouldCheck) return { skip: 'skipped_interval', stableFor };
  return { skip: null, stableFor };
}

async function processArticleTrack(
  storyId: number,
  story: HNItem | null,
  existing: SummaryRecord | null,
  store: SummaryStore,
  ctx: StoryContext,
): Promise<StoryLog> {
  const { deps, knobs, now, fetchFn, jinaApiKey, apiKey } = ctx;
  const baseLog = makeLog('article', storyId);
  // Derive the host and story-age fields once so every outcome this
  // function emits carries them, including skipped_* branches that
  // don't hit Jina. The two pre-fetch fallbacks (skipped_budget,
  // runPool error) fire before this function and don't get these
  // fields; see StoryLog.urlHost / StoryLog.storyAgeMinutes.
  const urlHost = parseUrlHost(story?.url);
  const storyAge = storyAgeMs(story, now);
  const storyAgeFields: Partial<StoryLog> =
    storyAge === undefined
      ? {}
      : {
          storyAgeMinutes: minutes(storyAge),
          ageBand: ageBandFromMinutes(minutes(storyAge)),
        };
  const log = (extra: Partial<StoryLog>): StoryLog =>
    baseLog({
      ...(urlHost ? { urlHost } : {}),
      ...storyAgeFields,
      ...extra,
    });

  if (existing) {
    const { skip, stableFor } = shouldSkipArticleByBackoff(existing, now, knobs);
    if (skip === 'skipped_age') {
      return log({ outcome: 'skipped_age', ageMinutes: minutes(now - existing.firstSeenAt) });
    }
    if (skip === 'skipped_interval') {
      return log({
        outcome: 'skipped_interval',
        ageMinutes: minutes(now - existing.firstSeenAt),
        stableForMinutes: minutes(stableFor),
        sinceLastCheckMinutes: minutes(now - existing.lastCheckedAt),
      });
    }
  }

  if (!story || story.deleted || story.dead) {
    return log({ outcome: 'skipped_unreachable' });
  }
  if (!(typeof story.score === 'number' && story.score > 1)) {
    return log({ outcome: 'skipped_low_score' });
  }
  const hasArticleUrl = !!story.url && isValidHttpUrl(story.url);
  const selfPostBody = hasArticleUrl
    ? ''
    : clampContent(htmlToPlainText(story.text)) ?? '';
  if (!hasArticleUrl && !selfPostBody) {
    return log({ outcome: 'skipped_no_content' });
  }

  let content: string;
  let prompt: string;
  let jinaTokens: number | undefined;
  if (hasArticleUrl) {
    const articleUrl = story.url!;
    if (!jinaApiKey) return log({ outcome: 'skipped_unreachable' });
    const res = await fetchViaJina(articleUrl, jinaApiKey, fetchFn);
    if (!res.ok) {
      if (res.failure === 'payment_required') {
        return log({ outcome: 'skipped_payment_required' });
      }
      return log({ outcome: 'skipped_unreachable' });
    }
    content = res.content;
    jinaTokens = res.tokens;
    prompt = buildPrompt(articleUrl, content);
  } else {
    // Self-post: body is already in the HN item, no Jina fetch needed.
    content = selfPostBody;
    prompt = buildSelfPostPrompt(story.title ?? '', content);
  }

  const newHash = hashArticle(content);
  const contentBytes = Buffer.byteLength(content, 'utf8');

  if (existing && existing.articleHash === newHash) {
    const updated: SummaryRecord = {
      ...existing,
      lastCheckedAt: now,
      // Backfill on the first unchanged tick after deploy for records
      // that predate the persistence. No-op once it's set.
      contentBytes,
    };
    try {
      await store.set(storyId, updated, RECORD_TTL_SECONDS);
    } catch {
      // best-effort
    }
    return log({
      outcome: 'unchanged',
      ageMinutes: minutes(now - existing.firstSeenAt),
      stableForMinutes: minutes(now - existing.lastChangedAt),
      sinceLastCheckMinutes: minutes(now - existing.lastCheckedAt),
      contentBytes,
      tokens: jinaTokens,
    });
  }

  if (!apiKey) return log({ outcome: 'error', tokens: jinaTokens });

  const client: SummaryClient = deps.createClient
    ? deps.createClient(apiKey)
    : (new GoogleGenAI({ apiKey }) as unknown as SummaryClient);
  let summary = '';
  try {
    const res = await client.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: { thinkingConfig: { thinkingBudget: 0 } },
    });
    summary = (res.text ?? '').trim();
  } catch {
    // falls through
  }
  if (!summary) return log({ outcome: 'error', tokens: jinaTokens });

  const summaryChanged = !!existing && existing.summary !== summary;
  const record: SummaryRecord = {
    summary,
    articleHash: newHash,
    firstSeenAt: existing?.firstSeenAt ?? now,
    summaryGeneratedAt: now,
    lastCheckedAt: now,
    lastChangedAt: now,
    contentBytes,
  };
  try {
    await store.set(storyId, record, RECORD_TTL_SECONDS);
  } catch {
    // best-effort
  }
  if (!existing) {
    return log({ outcome: 'first_seen', contentBytes, tokens: jinaTokens });
  }
  const deltaBytes =
    typeof existing.contentBytes === 'number'
      ? Math.abs(contentBytes - existing.contentBytes)
      : undefined;
  return log({
    outcome: 'changed',
    ageMinutes: minutes(now - existing.firstSeenAt),
    stableForMinutes: minutes(now - existing.lastChangedAt),
    sinceLastCheckMinutes: minutes(now - existing.lastCheckedAt),
    summaryChanged,
    contentBytes,
    ...(deltaBytes !== undefined ? { deltaBytes } : {}),
    tokens: jinaTokens,
  });
}

async function processCommentsTrack(
  storyId: number,
  story: HNItem | null,
  existing: CommentsSummaryRecord | null,
  store: CommentsSummaryStore,
  ctx: StoryContext,
): Promise<StoryLog> {
  const { deps, knobs, now, apiKey } = ctx;
  const fetchItem = deps.fetchItem ?? defaultFetchItem;
  const baseLog = makeLog('comments', storyId);
  // Every log line on this track carries storyAgeMinutes + ageBand
  // when the HN story.time is known. `ageBand` doubles as the
  // tier label — bucket widths are 1:1 with the ladder, so
  // grouping by `ageBand` already groups by tier.
  const storyAge = storyAgeMs(story, now);
  const storyAgeFields: Partial<StoryLog> =
    storyAge === undefined
      ? {}
      : {
          storyAgeMinutes: minutes(storyAge),
          ageBand: ageBandFromMinutes(minutes(storyAge)),
        };
  const log = (extra: Partial<StoryLog>): StoryLog =>
    baseLog({ ...storyAgeFields, ...extra });

  if (existing) {
    const { skip, stableFor } = shouldSkipCommentsByBackoff(
      existing,
      story,
      now,
      knobs,
    );
    if (skip === 'skipped_age') {
      return log({
        outcome: 'skipped_age',
        ageMinutes: minutes(now - existing.firstSeenAt),
      });
    }
    if (skip === 'skipped_interval') {
      return log({
        outcome: 'skipped_interval',
        ageMinutes: minutes(now - existing.firstSeenAt),
        stableForMinutes: minutes(stableFor),
        sinceLastCheckMinutes: minutes(now - existing.lastCheckedAt),
      });
    }
  }

  if (!story || story.deleted || story.dead) {
    return log({ outcome: 'skipped_unreachable' });
  }
  if (!(typeof story.score === 'number' && story.score > 1)) {
    return log({ outcome: 'skipped_low_score' });
  }
  const kidIds = (story.kids ?? []).slice(0, TOP_LEVEL_SAMPLE_SIZE);
  if (kidIds.length === 0) return log({ outcome: 'skipped_no_content' });

  const rawComments = await Promise.all(
    kidIds.map(async (id) => {
      try {
        return await fetchItem(id, ctx.signal);
      } catch {
        return null;
      }
    }),
  );
  const usable = rawComments.filter(
    (c): c is HNItem =>
      !!c && !c.deleted && !c.dead && typeof c.text === 'string',
  );
  if (usable.length === 0) return log({ outcome: 'skipped_no_content' });

  // Min-kids gate: the cron refuses to be the one to create a
  // first_seen record for a thin thread — wait until at least N
  // usable top-level comments are in. An existing record is never
  // re-gated, so a thread that drops from 10 → 2 comments still
  // gets regenerated on hash change rather than silently going stale.
  if (!existing && usable.length < knobs.commentsMinKids) {
    return log({
      outcome: 'skipped_low_volume',
      commentCount: usable.length,
    });
  }

  const transcript = buildTranscript(usable);
  const newHash = hashTranscript(transcript);
  const commentCount = usable.length;
  const transcriptBytes = Buffer.byteLength(transcript, 'utf8');

  if (existing && existing.transcriptHash === newHash) {
    const updated: CommentsSummaryRecord = {
      ...existing,
      lastCheckedAt: now,
      // Backfill on the first unchanged tick after deploy for legacy
      // records. No-op once set.
      transcriptBytes,
    };
    try {
      await store.set(storyId, updated, RECORD_TTL_SECONDS);
    } catch {
      // best-effort
    }
    return log({
      outcome: 'unchanged',
      ageMinutes: minutes(now - existing.firstSeenAt),
      stableForMinutes: minutes(now - existing.lastChangedAt),
      sinceLastCheckMinutes: minutes(now - existing.lastCheckedAt),
      commentCount,
      transcriptBytes,
    });
  }

  if (!apiKey) return log({ outcome: 'error' });

  const client: SummaryClient = deps.createClient
    ? deps.createClient(apiKey)
    : (new GoogleGenAI({ apiKey }) as unknown as SummaryClient);
  let rawResponse = '';
  try {
    const res = await client.models.generateContent({
      model: MODEL,
      contents: buildCommentsPrompt(story.title, transcript),
      config: { thinkingConfig: { thinkingBudget: 0 } },
    });
    rawResponse = (res.text ?? '').trim();
  } catch {
    // falls through
  }
  const insights = parseInsights(rawResponse);
  if (insights.length === 0) return log({ outcome: 'error' });

  const prior = existing?.insights.join('\n') ?? '';
  const insightsChanged = !!existing && prior !== insights.join('\n');
  const record: CommentsSummaryRecord = {
    insights,
    transcriptHash: newHash,
    firstSeenAt: existing?.firstSeenAt ?? now,
    summaryGeneratedAt: now,
    lastCheckedAt: now,
    lastChangedAt: now,
    transcriptBytes,
  };
  try {
    await store.set(storyId, record, RECORD_TTL_SECONDS);
  } catch {
    // best-effort
  }
  if (!existing) {
    return log({
      outcome: 'first_seen',
      commentCount,
      transcriptBytes,
    });
  }
  const deltaBytes =
    typeof existing.transcriptBytes === 'number'
      ? Math.abs(transcriptBytes - existing.transcriptBytes)
      : undefined;
  return log({
    outcome: 'changed',
    ageMinutes: minutes(now - existing.firstSeenAt),
    stableForMinutes: minutes(now - existing.lastChangedAt),
    sinceLastCheckMinutes: minutes(now - existing.lastCheckedAt),
    insightsChanged,
    commentCount,
    transcriptBytes,
    ...(deltaBytes !== undefined ? { deltaBytes } : {}),
  });
}

// Orchestrates one story across both tracks. Reads both cache records
// in parallel, fetches the HN item once (needed for `story.time` to
// place the story on the comments-track tier ladder and to populate
// storyAgeMinutes / ageBand on both tracks), then fans out to both
// track processors in parallel. Each track checks its own backoff
// gate before touching the story fields, so a null story still
// yields the correct skip outcome per-track.
async function processStory(
  storyId: number,
  store: SummaryStore,
  commentsStore: CommentsSummaryStore,
  ctx: StoryContext,
): Promise<StoryLog[]> {
  const { deps } = ctx;
  const fetchItem = deps.fetchItem ?? defaultFetchItem;

  const [existing, existingComments, story] = await Promise.all([
    store.get(storyId).catch(() => null),
    commentsStore.get(storyId).catch(() => null),
    fetchItem(storyId, ctx.signal).catch(() => null),
  ]);

  const [articleLog, commentsLog] = await Promise.all([
    processArticleTrack(storyId, story, existing, store, ctx),
    processCommentsTrack(storyId, story, existingComments, commentsStore, ctx),
  ]);
  return [articleLog, commentsLog];
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

export async function handleWarmRequest(
  request: Request,
  deps: WarmDeps = {},
): Promise<Response> {
  if (!isAuthorizedCronRequest(request)) {
    return json({ error: 'Forbidden' }, 403);
  }

  const knobs: WarmKnobs = { ...readKnobs(), ...deps.knobs };
  const logger = deps.logger ?? defaultLogger;
  const now = (deps.now ?? Date.now)();
  const startedAt = now;

  const { searchParams } = new URL(request.url);
  const feed = parseWarmFeed(searchParams.get('feed'));
  if (feed === null) {
    return json({ error: 'Invalid feed parameter' }, 400);
  }
  const n = parseWarmN(searchParams.get('n'), knobs.topN);
  if (n === null) {
    return json({ error: 'Invalid n parameter' }, 400);
  }

  const store = deps.store === undefined ? getDefaultStore() : deps.store;
  const commentsStore =
    deps.commentsStore === undefined
      ? getDefaultCommentsStore()
      : deps.commentsStore;

  if (!store || !commentsStore) {
    const entry: RunLog = {
      type: 'warm-run',
      durationMs: 0,
      processed: 0,
      storyCount: 0,
      outcomes: emptyTrackOutcomes(),
      topNRequested: n,
      feed,
      knobs,
      articleTokensTotal: 0,
    };
    logger(entry);
    return json({ error: 'Store not configured', reason: 'no_store' }, 503);
  }

  const fetchFeedIds = deps.fetchFeedIds ?? defaultFetchFeedIds;
  let ids: number[];
  try {
    ids = await fetchFeedIds(feed, request.signal);
  } catch {
    return json(
      { error: 'Could not load feed', reason: 'feed_unreachable' },
      502,
    );
  }
  const selected = ids.slice(0, n);

  const fetchFn = deps.fetchImpl ?? fetch;
  const jinaApiKey = deps.jinaApiKey ?? process.env.JINA_API_KEY;
  const apiKey = process.env.GOOGLE_API_KEY ?? null;
  const ctx: StoryContext = {
    deps,
    knobs,
    now,
    fetchFn,
    jinaApiKey,
    apiKey,
    signal: request.signal,
  };

  const outcomes = emptyTrackOutcomes();
  let processed = 0;
  let storyCount = 0;
  let articleTokensTotal = 0;

  const logGroups = await runPool(
    selected,
    CONCURRENCY,
    async (storyId) => {
      if ((deps.now ?? Date.now)() - startedAt > WALL_CLOCK_BUDGET_MS) {
        return [
          makeLog('article', storyId)({ outcome: 'skipped_budget' }),
          makeLog('comments', storyId)({ outcome: 'skipped_budget' }),
        ];
      }
      return processStory(storyId, store, commentsStore, ctx);
    },
    (_err, storyId) => [
      makeLog('article', storyId)({ outcome: 'error' }),
      makeLog('comments', storyId)({ outcome: 'error' }),
    ],
  );

  for (const group of logGroups) {
    storyCount += 1;
    for (const entry of group) {
      logger(entry);
      outcomes[entry.track][entry.outcome] =
        (outcomes[entry.track][entry.outcome] ?? 0) + 1;
      processed += 1;
      if (entry.track === 'article' && typeof entry.tokens === 'number') {
        articleTokensTotal += entry.tokens;
      }
    }
  }

  const runEntry: RunLog = {
    type: 'warm-run',
    durationMs: (deps.now ?? Date.now)() - startedAt,
    processed,
    storyCount,
    outcomes,
    topNRequested: n,
    feed,
    knobs,
    articleTokensTotal,
  };
  logger(runEntry);

  return json({ ok: true, feed, storyCount, processed, outcomes });
}

export async function GET(request: Request): Promise<Response> {
  return handleWarmRequest(request);
}
