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
const DEFAULT_MAX_STORY_AGE = 60 * 60 * 48; // give up after 48 h
const DEFAULT_TOP_N = 30;
// Young-story tuning: hot threads on HN grow fast in their first
// couple of hours. For the *comments* track only, re-check a live
// thread more aggressively while the story is young — otherwise the
// 30-min fresh interval leaves the cached insights lagging behind
// real comment churn. Articles don't grow after publication, so
// this doesn't apply to the article track.
const DEFAULT_YOUNG_STORY_AGE = 60 * 60 * 2; // "young" = HN-submitted < 2 h ago
const DEFAULT_YOUNG_STORY_REFRESH_INTERVAL = 60 * 10; // 10 min
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
  // Comments-track-specific tuning (see defaults above).
  youngStoryAgeSeconds: number;
  youngStoryRefreshIntervalSeconds: number;
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
    youngStoryAgeSeconds: parsePositiveInt(
      env.WARM_YOUNG_STORY_AGE_SECONDS,
      DEFAULT_YOUNG_STORY_AGE,
    ),
    youngStoryRefreshIntervalSeconds: parsePositiveInt(
      env.WARM_YOUNG_STORY_REFRESH_INTERVAL_SECONDS,
      DEFAULT_YOUNG_STORY_REFRESH_INTERVAL,
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

type FetchFailure = 'timeout' | 'unreachable';
type FetchOutcome =
  | { ok: true; content: string }
  | { ok: false; failure: FetchFailure };

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
        accept: 'text/plain',
        'x-return-format': 'markdown',
      },
    });
    if (!res.ok) return { ok: false, failure: 'unreachable' };
    const content = clampContent(await res.text());
    return content
      ? { ok: true, content }
      : { ok: false, failure: 'unreachable' };
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
  // still flipped because the in-body timestamp moved).
  contentBytes?: number;
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

export interface DecideIntervalOptions {
  // Comments track passes `true` when the HN story was submitted less
  // than youngStoryAgeSeconds ago, to trigger the shorter refresh
  // interval. Article track always leaves this false.
  isYoungStory?: boolean;
}

export function decideInterval(
  record: BackoffState,
  now: number,
  knobs: WarmKnobs,
  options: DecideIntervalOptions = {},
): { shouldCheck: boolean; stableFor: number } {
  const stableFor = Math.max(0, now - record.lastChangedAt);
  const sinceLastCheck = Math.max(0, now - record.lastCheckedAt);
  let interval: number;
  if (stableFor >= knobs.stableThresholdSeconds * 1000) {
    // Stable wins even for young stories — a comments thread that's
    // been unchanged for 6+ hours doesn't need the aggressive cadence.
    interval = knobs.stableCheckIntervalSeconds * 1000;
  } else if (options.isYoungStory) {
    interval = knobs.youngStoryRefreshIntervalSeconds * 1000;
  } else {
    interval = knobs.refreshCheckIntervalSeconds * 1000;
  }
  return { shouldCheck: sinceLastCheck >= interval, stableFor };
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

function shouldSkipByBackoff(
  existing: BackoffState & { firstSeenAt: number },
  now: number,
  knobs: WarmKnobs,
  options: DecideIntervalOptions = {},
): { skip: CheckOutcome | null; stableFor: number } {
  const ageMs = now - existing.firstSeenAt;
  if (ageMs > knobs.maxStoryAgeSeconds * 1000) {
    return { skip: 'skipped_age', stableFor: 0 };
  }
  const { shouldCheck, stableFor } = decideInterval(
    existing,
    now,
    knobs,
    options,
  );
  if (!shouldCheck) return { skip: 'skipped_interval', stableFor };
  return { skip: null, stableFor };
}

// True when the HN submission time falls inside the "young story"
// window. `story.time` is a Unix epoch in seconds per the HN API.
function isYoungStory(
  story: HNItem | null,
  now: number,
  knobs: WarmKnobs,
): boolean {
  if (!story || typeof story.time !== 'number') return false;
  return now - story.time * 1000 < knobs.youngStoryAgeSeconds * 1000;
}

async function processArticleTrack(
  storyId: number,
  story: HNItem | null,
  existing: SummaryRecord | null,
  store: SummaryStore,
  ctx: StoryContext,
): Promise<StoryLog> {
  const { deps, knobs, now, fetchFn, jinaApiKey, apiKey } = ctx;
  const log = makeLog('article', storyId);

  if (existing) {
    const { skip, stableFor } = shouldSkipByBackoff(existing, now, knobs);
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
  if (!story.url || !isValidHttpUrl(story.url)) {
    return log({ outcome: 'skipped_no_content' });
  }
  const articleUrl = story.url;

  if (!jinaApiKey) return log({ outcome: 'skipped_unreachable' });
  const res = await fetchViaJina(articleUrl, jinaApiKey, fetchFn);
  if (!res.ok) return log({ outcome: 'skipped_unreachable' });
  const content = res.content;

  const newHash = hashArticle(content);
  const contentBytes = Buffer.byteLength(content, 'utf8');

  if (existing && existing.articleHash === newHash) {
    const updated: SummaryRecord = { ...existing, lastCheckedAt: now };
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
    });
  }

  if (!apiKey) return log({ outcome: 'error' });

  const client: SummaryClient = deps.createClient
    ? deps.createClient(apiKey)
    : (new GoogleGenAI({ apiKey }) as unknown as SummaryClient);
  let summary = '';
  try {
    const res = await client.models.generateContent({
      model: MODEL,
      contents: buildPrompt(articleUrl, content),
      config: { thinkingConfig: { thinkingBudget: 0 } },
    });
    summary = (res.text ?? '').trim();
  } catch {
    // falls through
  }
  if (!summary) return log({ outcome: 'error' });

  const summaryChanged = !!existing && existing.summary !== summary;
  const record: SummaryRecord = {
    summary,
    articleHash: newHash,
    firstSeenAt: existing?.firstSeenAt ?? now,
    summaryGeneratedAt: now,
    lastCheckedAt: now,
    lastChangedAt: now,
  };
  try {
    await store.set(storyId, record, RECORD_TTL_SECONDS);
  } catch {
    // best-effort
  }
  if (!existing) {
    return log({ outcome: 'first_seen', contentBytes });
  }
  return log({
    outcome: 'changed',
    ageMinutes: minutes(now - existing.firstSeenAt),
    stableForMinutes: minutes(now - existing.lastChangedAt),
    sinceLastCheckMinutes: minutes(now - existing.lastCheckedAt),
    summaryChanged,
    contentBytes,
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
  const log = makeLog('comments', storyId);

  const young = isYoungStory(story, now, knobs);

  if (existing) {
    const { skip, stableFor } = shouldSkipByBackoff(existing, now, knobs, {
      isYoungStory: young,
    });
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
    const updated: CommentsSummaryRecord = { ...existing, lastCheckedAt: now };
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
  };
  try {
    await store.set(storyId, record, RECORD_TTL_SECONDS);
  } catch {
    // best-effort
  }
  if (!existing) {
    return log({ outcome: 'first_seen', commentCount, transcriptBytes });
  }
  return log({
    outcome: 'changed',
    ageMinutes: minutes(now - existing.firstSeenAt),
    stableForMinutes: minutes(now - existing.lastChangedAt),
    sinceLastCheckMinutes: minutes(now - existing.lastCheckedAt),
    insightsChanged,
    commentCount,
    transcriptBytes,
  });
}

// Orchestrates one story across both tracks. Reads both cache records
// in parallel, fetches the HN item once (needed for `story.time` to
// compute isYoungStory, which the comments-track backoff depends on),
// then fans out to both track processors in parallel. Each track
// checks its own backoff gate before touching the story fields, so a
// null story still yields the correct skip outcome per-track.
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
  };
  logger(runEntry);

  return json({ ok: true, feed, storyCount, processed, outcomes });
}

export async function GET(request: Request): Promise<Response> {
  return handleWarmRequest(request);
}
