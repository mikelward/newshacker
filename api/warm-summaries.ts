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
// Article-track delta guard. When the Jina-clean body's hash flips
// and `0 < |contentBytes_now − contentBytes_prev| < WARM_MIN_DELTA_BYTES`,
// skip the Gemini regen and log `skipped_minor_delta` instead. The
// `0 <` lower bound is intentional: a zero-byte delta means the body
// changed at the character level without changing length (date-format
// swap, same-length wording change), and byte count alone can't tell
// "real character-level edit" from "rendering coincidence" — those
// fall through to Gemini so we don't pin the baseline forever on a
// real edit. Most "changed" events at <100 B are in-body timestamps,
// ad slots, or related-article widgets churning — not real edits.
// 256 B is a conservative starting point that catches all <100 B
// noise plus part of the 100-1000 B oscillation band, while still
// letting a real multi-paragraph edit through. For non-zero deltas
// cumulative drift will eventually trip the threshold even if
// individual ticks don't, because we leave `articleHash` /
// `contentBytes` / `lastChangedAt` from the last real regen intact on
// a `skipped_minor_delta` tick.
const DEFAULT_MIN_DELTA_BYTES = 256;
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
  // Article-track only: see DEFAULT_MIN_DELTA_BYTES.
  minDeltaBytes: number;
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
    minDeltaBytes: parseNonNegativeInt(
      env.WARM_MIN_DELTA_BYTES,
      DEFAULT_MIN_DELTA_BYTES,
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
  // Floor first, then re-validate. `0.5` would otherwise pass the
  // `n <= 0` check and floor to 0, silently disabling whatever knob is
  // calling this — same bug class `parseNonNegativeInt` (below) was
  // built to avoid. We tolerate `'5.5'` → `5` since that's a sensible
  // truncation and matches the original loose-parsing intent; only
  // values that floor below 1 fall back.
  const i = Math.floor(n);
  if (i <= 0) return fallback;
  return i;
}

// Like parsePositiveInt but accepts 0 as "disabled" — used for
// WARM_MIN_DELTA_BYTES so an operator can turn the delta guard off
// without a redeploy by setting it to 0. Strict integer-only: rejects
// whitespace-only strings (Number(' ') === 0 would otherwise silently
// disable the guard) and rejects non-integer strings like '0.5' (which
// Math.floor would silently round down to 0). Also rejects values
// past Number.MAX_SAFE_INTEGER — the regex would let a 20-digit
// string through but `Number()` loses precision past 2^53, which
// would let a misconfigured knob behave non-deterministically. Any
// real threshold for this knob is in the low thousands, so the
// safe-integer ceiling is far above the useful range. Negatives,
// floats, oversized values, and junk all fall back to the default.
function parseNonNegativeInt(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  if (!/^\d+$/.test(trimmed)) return fallback;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) return fallback;
  return n;
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

// Per-record snapshot of how many times each correction-shaped phrase
// appears in the Jina-clean body. Compared tick-over-tick to surface
// "did a correction appear since last time?" as a Δ on the log line,
// without having to keep the full body in Redis. Buckets are coarse
// on purpose so the keyword list can grow without breaking the
// persisted shape.
export interface CorrectionKeywordCounts {
  update: number;
  correction: number;
  retraction: number;
  editorsNote: number;
  clarification: number;
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
  // Paywall-detector verdict on the Jina-clean body. `undefined` on
  // records written before the detector landed; advisory only — see
  // api/summary.ts § `detectPaywall` for the contract. Persisted so
  // `unchanged` logs can emit the field without recomputing.
  paywalled?: boolean;
  // Hypothesis-testing fields (added in the cache-strategy work — see
  // reports/2026-04-29-cache-strategy.md). All optional, all populated
  // on every write path once we've fetched a fresh body. None of them
  // affect the regen decision today; they exist purely so a week of
  // production data can answer "would this signal have helped suppress
  // the noise tier without missing real corrections?".
  //
  // HN title at the last check. Compared tick-over-tick to surface
  // editor-driven title rewrites (corrections, clarifications, tag
  // strips) on the warm-story log without storing the full HN item.
  title?: string;
  // sha256 of the normalized first ~500 chars of the body. Lets a
  // future filter ask "did the meaningful prefix change?" cheaply
  // without storing the lede prose itself; bodySample below covers
  // the spot-checking case.
  ledeHash?: string;
  // Verbatim first ~1000 chars of the Jina-clean body. The lede is
  // where corrections almost always appear, so a bounded sample on
  // the record leaves us the option of an authenticated debug
  // endpoint for spot-checking specific events without re-fetching
  // the article. `warm-story` logs intentionally do not emit body
  // text (see OBSERVABILITY.md § *Deliberately not logged*) and
  // Axiom cannot read Redis, so this field is Redis-only. Bounded
  // length keeps the per-record bloat predictable (~1 KB × catalog
  // size).
  bodySample?: string;
  // Per-keyword bucket counts over the full body. Compared on the
  // next tick to emit `correctionKeywordDelta` on the log line — a
  // direct measure of how often "would correction-keyword detection
  // have fired here?" lands.
  correctionKeywordCounts?: CorrectionKeywordCounts;
  // Count of markdown links in the body. Bloated link lists
  // ("Related articles", "You may also like") are one of the
  // suspected noise sources; tick-over-tick `linkCountDelta` should
  // separate that from prose churn.
  linkCount?: number;
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
    ...(typeof r.paywalled === 'boolean' ? { paywalled: r.paywalled } : {}),
    ...(typeof r.title === 'string' ? { title: r.title } : {}),
    ...(typeof r.ledeHash === 'string' ? { ledeHash: r.ledeHash } : {}),
    ...(typeof r.bodySample === 'string' ? { bodySample: r.bodySample } : {}),
    ...(isCorrectionKeywordCounts(r.correctionKeywordCounts)
      ? { correctionKeywordCounts: r.correctionKeywordCounts }
      : {}),
    ...(isNonNegativeInteger(r.linkCount) ? { linkCount: r.linkCount } : {}),
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function isCorrectionKeywordCounts(
  raw: unknown,
): raw is CorrectionKeywordCounts {
  if (!raw || typeof raw !== 'object') return false;
  const c = raw as Partial<CorrectionKeywordCounts>;
  // Reject NaN, Infinity, negative, and non-integer values — this is
  // the parser boundary for data coming back from Redis, and a
  // hand-edited or corrupted record should not emit misleading
  // deltas downstream.
  return (
    isNonNegativeInteger(c.update) &&
    isNonNegativeInteger(c.correction) &&
    isNonNegativeInteger(c.retraction) &&
    isNonNegativeInteger(c.editorsNote) &&
    isNonNegativeInteger(c.clarification)
  );
}

export function hashArticle(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// Lede = first ~500 chars of the body, with leading/trailing
// whitespace dropped and runs of internal whitespace collapsed to a
// single space. The intent is "would a human reader say the article
// opens the same way?" — not "are the bytes identical?". Whitespace-
// normalization is the cheapest noise filter that actually moves the
// signal: most "the article changed" oscillations are markdown-render
// drift in the trailing nav, but when they reach the lede they show
// up as extra newlines around an ad-slot or a "Updated 3 hours ago"
// banner above the headline.
const LEDE_CHARS = 500;
const BODY_SAMPLE_CHARS = 1000;

export function normalizeLede(content: string): string {
  return content.trim().replace(/\s+/g, ' ').slice(0, LEDE_CHARS);
}

export function hashLede(content: string): string {
  return createHash('sha256').update(normalizeLede(content)).digest('hex');
}

export function bodySampleOf(content: string): string {
  return content.slice(0, BODY_SAMPLE_CHARS);
}

// Correction-shaped phrase patterns. Case-insensitive and global —
// matches anywhere in the body, no `^` anchoring or multiline mode.
// Word-bounded so "Update:" matches but "UpdateScript" does not.
// Counts are per-bucket because we want "did corrections appear
// since last tick" to be a single comparison per bucket, not a
// cross-product of every regex.
const CORRECTION_PATTERNS: Record<keyof CorrectionKeywordCounts, RegExp> = {
  // Both `Update:` and `Updated:` — corrections at the top of an article
  // commonly use either. Word-bounded prefix; trailing punctuation keeps
  // out body sentences like "the team updates the page nightly".
  update: /\bupdated?\s*:/gi,
  correction: /\bcorrection\s*:/gi,
  // `Retraction` and the journalistic stock phrase "we regret the
  // error" — the latter is a reliable signal even when no formal
  // banner is present.
  retraction: /\bretract(?:ion|ed)\b|\bwe regret the error\b/gi,
  // `Editor's note:` / `Editorial note:` — the apostrophe in
  // "Editor's" sometimes renders as a typographic quote in Jina's
  // markdown output, so accept either.
  editorsNote: /\beditor(?:'|’)?s?\s+note\s*:|\beditorial\s+note\s*:/gi,
  clarification: /\bclarification\s*:/gi,
};

export function countCorrectionKeywords(
  content: string,
): CorrectionKeywordCounts {
  const out: CorrectionKeywordCounts = {
    update: 0,
    correction: 0,
    retraction: 0,
    editorsNote: 0,
    clarification: 0,
  };
  for (const key of Object.keys(out) as (keyof CorrectionKeywordCounts)[]) {
    const matches = content.match(CORRECTION_PATTERNS[key]);
    out[key] = matches ? matches.length : 0;
  }
  return out;
}

// Approximate count of markdown links — `](http…)` is a stable shape
// in Jina's output. Not exact (matches inside code fences too), but
// the goal is a tick-over-tick delta, and code fences are stable
// across re-fetches of the same article.
const LINK_PATTERN = /\]\(https?:/g;

export function countLinks(content: string): number {
  const matches = content.match(LINK_PATTERN);
  return matches ? matches.length : 0;
}

// Caller is responsible for only invoking this when `prev` is defined.
// The "delta vs implicit zero baseline" path was a foot-gun for legacy
// records (see correctionKeywordDelta call site for the guard).
function diffCorrectionKeywords(
  next: CorrectionKeywordCounts,
  prev: CorrectionKeywordCounts,
): CorrectionKeywordCounts {
  return {
    update: next.update - prev.update,
    correction: next.correction - prev.correction,
    retraction: next.retraction - prev.retraction,
    editorsNote: next.editorsNote - prev.editorsNote,
    clarification: next.clarification - prev.clarification,
  };
}

function correctionDeltaIsZero(d: CorrectionKeywordCounts): boolean {
  return (
    d.update === 0 &&
    d.correction === 0 &&
    d.retraction === 0 &&
    d.editorsNote === 0 &&
    d.clarification === 0
  );
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
  | { ok: true; content: string; tokens?: number; paywalled: boolean }
  | { ok: false; failure: FetchFailure };

// === Paywall detection (inlined — mirrored in api/summary.ts) ===
// See api/summary.ts § `detectPaywall` for the contract and the
// rationale for the heuristic thresholds. Duplicated per AGENTS.md
// § "Vercel api/ gotchas"; api/warm-summaries.test.ts § "detectPaywall
// parity with summary.ts" fails loudly if they drift.
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
const JSON_LD_PAYWALL_MARKER = /"isAccessibleForFree"\s*:\s*false\b/i;
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
    return { ok: true, content, tokens, paywalled: detectPaywall(content) };
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
  // Mirrors the shape api/summary.ts already pulls from. Lets the
  // cron emit per-call Gemini-token telemetry on `first_seen` and
  // `changed` outcomes, closing the spend-visibility gap that used
  // to make the warm cron's Gemini usage invisible to the /admin
  // analytics dashboard.
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
  // Article track only: hash flipped but the body's byte length barely
  // moved (`0 < deltaBytes < WARM_MIN_DELTA_BYTES`). The strict-positive
  // lower bound is intentional — `deltaBytes === 0` (same-length
  // character-level change: date-format swap, typo fix, equal-length
  // wording change) is excluded and still logs as `changed`, since byte
  // count alone can't distinguish those from rendering coincidence and
  // skipping would pin the baseline indefinitely on a real edit.
  // Treated as "still the same article, page noise made the markdown
  // re-render different" — we refresh `lastCheckedAt` only and leave
  // `articleHash` / `contentBytes` / `lastChangedAt` / `summary` from
  // the last real regen intact, so cumulative drift will still
  // eventually trip the
  // threshold. Costs Jina (we already fetched) but skips Gemini.
  | 'skipped_minor_delta'
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
  // On `changed` and `skipped_minor_delta` outcomes:
  // `|contentBytes_now − contentBytes_prev|` for articles,
  // `|transcriptBytes_now − transcriptBytes_prev|` for comments. Lets
  // a single APL query separate noise (small delta from an in-body
  // timestamp flip) from real edits (multi-KB delta). On
  // `skipped_minor_delta` the value is by definition under
  // `WARM_MIN_DELTA_BYTES`, so an effectiveness query that buckets by
  // `deltaBytes` will see this outcome cluster at the low end.
  // Absent on `changed` only when the prior record predates the
  // contentBytes / transcriptBytes persistence (legacy records); the
  // next `changed` tick populates it. Always present on
  // `skipped_minor_delta` (the guard requires `existing.contentBytes`
  // to fire).
  deltaBytes?: number;
  // Article track: Jina Reader's billed token count for this fetch
  // (from the `usage.tokens` field of the JSON response). Present on
  // every outcome where Jina was actually called this tick — that's
  // `first_seen`, `unchanged`, `changed`, and `skipped_minor_delta`
  // (which is a `skipped_*` outcome but fires *after* the Jina fetch,
  // since the byte-length comparison needs the freshly-fetched body).
  // Absent on outcomes where no Jina fetch happened: the pre-fetch
  // `skipped_*` branches (`skipped_age`, `skipped_interval`,
  // `skipped_low_score`, `skipped_no_content`, `skipped_unreachable`,
  // `skipped_payment_required`, `skipped_budget`), self-posts (body
  // came from `story.text`, no round-trip), and runs where Jina
  // omitted the field. The run-level `articleTokensTotal` rolls these
  // up so operators can watch for budget drift without post-processing
  // the per-story lines.
  tokens?: number;
  // Article track: `detectPaywall()` verdict on the Jina-clean body.
  // Present on every outcome where Jina was actually called this tick:
  // `first_seen` and `changed` (freshly detected), `unchanged`
  // (propagated from the stored record when it carries the field;
  // freshly computed as a backfill when it doesn't), and
  // `skipped_minor_delta` (same propagate-or-backfill behaviour as
  // `unchanged`). Absent on the pre-fetch `skipped_*` branches and on
  // self-posts (no Jina round-trip). Advisory — today this just feeds
  // the warm-summaries analytics so we can measure paywall prevalence
  // per domain before acting on it in the UI.
  paywalled?: boolean;
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
  // Gemini billed token counts for the regenerated summary on this
  // tick. Field names + units mirror what api/summary.ts and
  // api/comments-summary.ts emit on user-path `summary-outcome` /
  // `comments-summary-outcome` lines, so the /admin analytics
  // dashboard's Token-spend rollup can sum across user + cron
  // paths under one field name. Present on both tracks for
  // `first_seen` and `changed` outcomes — and on `error`
  // outcomes that follow a Gemini call where the SDK reported
  // usage but the response was unusable (empty `res.text` on the
  // article track, `parseInsights` returned nothing on the
  // comments track), since those tokens were still billed.
  // Absent on every other outcome, including `error` paths that
  // fail before reaching Gemini and on outcomes where the Gemini
  // call itself threw (no usage to report).
  geminiPromptTokens?: number;
  geminiOutputTokens?: number;
  geminiTotalTokens?: number;
  // Hypothesis-testing instrumentation (article track only — see
  // reports/2026-04-29-cache-strategy.md). Pure measurement: none of
  // these fields gate regen today. After a week of production data
  // we'll know whether title-change, lede-change, or correction-
  // keyword-delta would have suppressed the noise tier without
  // missing real corrections.
  //
  // Whether the HN title differs from the previously-stored title.
  // Article track only. Boolean only — the title strings themselves
  // stay in the SummaryRecord cache and are deliberately not
  // surfaced to logs (see OBSERVABILITY.md § *Deliberately not
  // logged* — article title text is internal HN content and
  // gratuitous in observability retention). Absent when there's no
  // prior title to compare against (first_seen, or a pre-
  // instrumentation legacy record on its first post-deploy tick).
  titleChanged?: boolean;
  // Whether the normalized lede hash (first ~500 chars, whitespace-
  // collapsed) differs from the previously-stored ledeHash. Article
  // track only. Absent when there's no prior ledeHash to compare
  // against. A `changed` event with `ledeChanged: false` is
  // suspicious — the body's bytes moved but the meaningful prefix
  // didn't, which is what trailing-nav noise looks like.
  ledeChanged?: boolean;
  // Per-keyword count delta vs. the previously-stored counts. Only
  // emitted when at least one bucket is non-zero — a flat-zero delta
  // would crowd every log line with five fields that say "nothing
  // happened". In practice this means it only ever appears on
  // `changed` outcomes: on `unchanged` the body hash matches, so
  // the body bytes are identical, so the keyword counts derived
  // from them are identical, so the delta is always zero and
  // omitted.
  correctionKeywordDelta?: CorrectionKeywordCounts;
  // Total markdown-link count in the current body, plus tick-over-
  // tick absolute delta. linkCount is cheap to emit on every fetch;
  // linkCountDelta is omitted on first_seen and on legacy records
  // where prior linkCount wasn't persisted yet.
  linkCount?: number;
  linkCountDelta?: number;
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
  // Sum of per-story `geminiPromptTokens` / `geminiOutputTokens`
  // across both tracks for this run. Lets the operator track the
  // cron's Gemini spend at tick granularity without joining the
  // per-story `warm-story` lines back together. The `Total` suffix
  // is deliberate: per-event lines (`summary-outcome` /
  // `comments-summary-outcome` / `warm-story`) carry the same
  // values under the un-suffixed names, so an APL query summing
  // `e.geminiPromptTokens` over those three line types gives the
  // same answer cross-path. The run-level rollup uses a distinct
  // name so a query that *also* includes `warm-run` lines doesn't
  // double-count by adding the per-tick total to the per-event
  // sums. Combined-not-per-track because the per-track split is
  // already in the per-story lines if needed.
  geminiPromptTokensTotal: number;
  geminiOutputTokensTotal: number;
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
    skipped_minor_delta: 0,
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
    if (storyAge < tier.maxAgeSeconds * 1000) {
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
  // `in` would also accept Object.prototype keys (`toString`,
  // `__proto__`, …) and interpolate garbage into the Firebase URL.
  return Object.prototype.hasOwnProperty.call(FEED_ENDPOINTS, raw)
    ? (raw as WarmFeed)
    : null;
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
  // URL-post stories: populated from Jina's paywall detector verdict.
  // Left undefined on self-posts (no Jina round-trip, no overlay).
  let paywalled: boolean | undefined;
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
    paywalled = res.paywalled;
    prompt = buildPrompt(articleUrl, content);
  } else {
    // Self-post: body is already in the HN item, no Jina fetch needed.
    content = selfPostBody;
    prompt = buildSelfPostPrompt(story.title ?? '', content);
  }

  const newHash = hashArticle(content);
  const contentBytes = Buffer.byteLength(content, 'utf8');

  // Hypothesis-testing instrumentation. Computed once per fetch and
  // reused across the unchanged / first_seen / changed branches —
  // every write path persists the snapshot, every log path emits the
  // tick-over-tick deltas. None of these gate regen today; see
  // SummaryRecord docstrings.
  const ledeHash = hashLede(content);
  const bodySample = bodySampleOf(content);
  const correctionKeywordCounts = countCorrectionKeywords(content);
  const linkCount = countLinks(content);
  const currentTitle = typeof story.title === 'string' ? story.title : '';

  // Carry the prior title forward when the HN item is momentarily
  // missing one. Without this fall-through, a `changed` event whose
  // story.title happened to be undefined (rare but possible — the
  // HNItem.title field is optional) would erase the cached title on
  // the freshly-written record. The persistence shape is "store the
  // best title we know of", not "store whatever HN returned this
  // tick".
  const priorTitleStored =
    existing && typeof existing.title === 'string' ? existing.title : '';
  const titleToStore = currentTitle || priorTitleStored;

  const hypothesisRecordFields: Partial<SummaryRecord> = {
    ...(titleToStore ? { title: titleToStore } : {}),
    ledeHash,
    bodySample,
    correctionKeywordCounts,
    linkCount,
  };

  // Per-tick log spread: title-changed bit, lede-change bit, keyword
  // delta (when non-zero), link-count + delta. Article track only —
  // every callsite below reuses this builder so the comparison logic
  // lives in one place.
  const buildHypothesisLogFields = (
    prior: SummaryRecord | null,
  ): Partial<StoryLog> => {
    const out: Partial<StoryLog> = { linkCount };
    if (prior) {
      const priorTitle = typeof prior.title === 'string' ? prior.title : '';
      // Only fire titleChanged when both prior and current titles are
      // non-empty. A legacy record without `title` would otherwise
      // emit a spurious "changed" on every story's first post-deploy
      // tick; an HN item with a momentarily-empty title would emit
      // titleChanged repeatedly because we don't overwrite the
      // persisted title with empty (see titleToStore above).
      if (priorTitle && currentTitle) {
        out.titleChanged = currentTitle !== priorTitle;
      }
      if (typeof prior.ledeHash === 'string') {
        out.ledeChanged = prior.ledeHash !== ledeHash;
      }
      // Only emit correctionKeywordDelta when the prior record has
      // persisted keyword counts. Diffing against an implicit
      // zero-baseline on a legacy record would log a non-zero
      // delta on every story whose body already contained an
      // `Update:` banner before we deployed the instrumentation,
      // contaminating exactly the dataset this commit is meant to
      // collect.
      if (prior.correctionKeywordCounts) {
        const delta = diffCorrectionKeywords(
          correctionKeywordCounts,
          prior.correctionKeywordCounts,
        );
        if (!correctionDeltaIsZero(delta)) {
          out.correctionKeywordDelta = delta;
        }
      }
      if (typeof prior.linkCount === 'number') {
        out.linkCountDelta = Math.abs(linkCount - prior.linkCount);
      }
    }
    return out;
  };

  if (existing && existing.articleHash === newHash) {
    // Hash-stable: prefer the fresh detection (it's what hashed to the
    // same bytes we saw last tick, so it's authoritative now); fall
    // back to the stored verdict for self-posts (no fresh detection)
    // so a bit persisted on a prior URL tick isn't lost on a self-post
    // re-check — though in practice a story's URL-ness doesn't flip.
    const effectivePaywalled =
      paywalled !== undefined ? paywalled : existing.paywalled;
    const updated: SummaryRecord = {
      ...existing,
      lastCheckedAt: now,
      // Backfill on the first unchanged tick after deploy for records
      // that predate the persistence. No-op once it's set.
      contentBytes,
      ...(effectivePaywalled !== undefined
        ? { paywalled: effectivePaywalled }
        : {}),
      ...hypothesisRecordFields,
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
      ...(effectivePaywalled !== undefined
        ? { paywalled: effectivePaywalled }
        : {}),
      ...buildHypothesisLogFields(existing),
    });
  }

  // Hash flipped but the body's byte length barely moved — treat as
  // page-noise (timestamps, ad slots, related-article widgets) and
  // skip the Gemini regen. We refresh lastCheckedAt only; articleHash,
  // contentBytes, lastChangedAt and summary stay pinned to the last
  // real regen so cumulative drift trips the threshold once enough
  // small ticks accumulate, even if no individual tick crosses it.
  // URL-post path only — self-posts don't go through Jina (no markdown
  // re-render noise) and tend to be short enough that a small text
  // edit is genuinely material to the summary, so we let those through
  // to Gemini. Also requires contentBytes on the prior record (legacy
  // records pre-instrumentation get a free Gemini regen on their first
  // changed tick — accepted, since the next tick will have
  // contentBytes and the guard kicks in).
  //
  // Strictly-positive deltaBytes only. A `deltaBytes === 0` flip
  // (hash differs, byte length identical — same-length wording change,
  // date-format swap "Jan 28"→"Jan 29", typo fix "color"→"honor") is
  // ambiguous: byte count alone can't tell "real edit at the character
  // level" from "rendering coincidence". Skipping forever on those
  // would leave a stale summary in cache indefinitely, since with the
  // baseline pinned every subsequent tick recomputes the same 0 delta
  // and skips again — the "cumulative drift trips eventually" property
  // doesn't apply when there's no drift. Erring toward false-positive
  // regen (~$0.0008 each) is cheaper than indefinite false-negative
  // staleness, so deltaBytes === 0 falls through to Gemini.
  //
  // Second-order effect on Jina spend: pinning `lastChangedAt` here
  // means the article-track backoff logic (`decideInterval`, keyed off
  // `stableFor = now − lastChangedAt`) sees a noisy story as "still
  // stable" once 6 h passes without a real edit — at which point
  // polling drops from the 30-min fresh interval to the 2-h stable
  // interval, ~4× fewer ticks per day, ~4× fewer Jina fetches per
  // story during the stable window. Pre-fix behaviour reset
  // `lastChangedAt` on every noisy hash flip so a story drowning in
  // timestamp churn never graduated past the fresh interval. This is
  // separate from the Finding 1 ($5/mo Gemini) headline savings;
  // Jina-side recovery here grows over time as the backoff catches up.
  const deltaBytes =
    existing && existing.contentBytes !== undefined
      ? Math.abs(contentBytes - existing.contentBytes)
      : undefined;
  if (
    hasArticleUrl &&
    existing &&
    deltaBytes !== undefined &&
    knobs.minDeltaBytes > 0 &&
    deltaBytes > 0 &&
    deltaBytes < knobs.minDeltaBytes
  ) {
    const effectivePaywalled =
      paywalled !== undefined ? paywalled : existing.paywalled;
    const updated: SummaryRecord = {
      ...existing,
      lastCheckedAt: now,
      ...(effectivePaywalled !== undefined
        ? { paywalled: effectivePaywalled }
        : {}),
    };
    try {
      await store.set(storyId, updated, RECORD_TTL_SECONDS);
    } catch {
      // best-effort
    }
    return log({
      outcome: 'skipped_minor_delta',
      ageMinutes: minutes(now - existing.firstSeenAt),
      stableForMinutes: minutes(now - existing.lastChangedAt),
      sinceLastCheckMinutes: minutes(now - existing.lastCheckedAt),
      contentBytes,
      deltaBytes,
      tokens: jinaTokens,
      ...(effectivePaywalled !== undefined
        ? { paywalled: effectivePaywalled }
        : {}),
    });
  }

  if (!apiKey) return log({ outcome: 'error', tokens: jinaTokens });

  const client: SummaryClient = deps.createClient
    ? deps.createClient(apiKey)
    : (new GoogleGenAI({ apiKey }) as unknown as SummaryClient);
  let summary = '';
  let geminiPromptTokens: number | undefined;
  let geminiOutputTokens: number | undefined;
  let geminiTotalTokens: number | undefined;
  try {
    const res = await client.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: { thinkingConfig: { thinkingBudget: 0 } },
    });
    summary = (res.text ?? '').trim();
    geminiPromptTokens = res.usageMetadata?.promptTokenCount;
    geminiOutputTokens = res.usageMetadata?.candidatesTokenCount;
    geminiTotalTokens = res.usageMetadata?.totalTokenCount;
  } catch {
    // falls through
  }
  // Field-only-when-set spread: makes the log line carry the field
  // when Gemini reported the number, omit it when the SDK omitted it
  // (older response shapes, throw before usage was attached, etc.).
  // Same pattern as `paywalled` / `deltaBytes` elsewhere in this
  // file. Built before the `!summary` check so an error outcome
  // following a Gemini call that *did* bill tokens (empty res.text)
  // still carries the spend telemetry — matches api/summary.ts which
  // logs gemini fields on its own error paths for the same reason.
  const geminiFields: Partial<StoryLog> = {
    ...(geminiPromptTokens !== undefined ? { geminiPromptTokens } : {}),
    ...(geminiOutputTokens !== undefined ? { geminiOutputTokens } : {}),
    ...(geminiTotalTokens !== undefined ? { geminiTotalTokens } : {}),
  };
  if (!summary)
    return log({ outcome: 'error', tokens: jinaTokens, ...geminiFields });

  const summaryChanged = !!existing && existing.summary !== summary;
  const record: SummaryRecord = {
    summary,
    articleHash: newHash,
    firstSeenAt: existing?.firstSeenAt ?? now,
    summaryGeneratedAt: now,
    lastCheckedAt: now,
    lastChangedAt: now,
    contentBytes,
    ...(paywalled !== undefined ? { paywalled } : {}),
    ...hypothesisRecordFields,
  };
  try {
    await store.set(storyId, record, RECORD_TTL_SECONDS);
  } catch {
    // best-effort
  }
  if (!existing) {
    return log({
      outcome: 'first_seen',
      contentBytes,
      tokens: jinaTokens,
      ...(paywalled !== undefined ? { paywalled } : {}),
      ...geminiFields,
      ...buildHypothesisLogFields(null),
    });
  }
  // `deltaBytes` was already computed once above for the
  // skipped_minor_delta guard; reuse it here. By this point `existing`
  // is truthy (the `!existing` first_seen branch returned), so the
  // hoisted const has the same semantics as the previous local
  // declaration (`typeof existing.contentBytes === 'number'` is
  // equivalent to the hoisted ternary's `existing.contentBytes !== undefined`
  // condition for valid records).
  return log({
    outcome: 'changed',
    ageMinutes: minutes(now - existing.firstSeenAt),
    stableForMinutes: minutes(now - existing.lastChangedAt),
    sinceLastCheckMinutes: minutes(now - existing.lastCheckedAt),
    summaryChanged,
    contentBytes,
    ...(deltaBytes !== undefined ? { deltaBytes } : {}),
    tokens: jinaTokens,
    ...(paywalled !== undefined ? { paywalled } : {}),
    ...geminiFields,
    ...buildHypothesisLogFields(existing),
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
  let geminiPromptTokens: number | undefined;
  let geminiOutputTokens: number | undefined;
  let geminiTotalTokens: number | undefined;
  try {
    const res = await client.models.generateContent({
      model: MODEL,
      contents: buildCommentsPrompt(story.title, transcript),
      config: { thinkingConfig: { thinkingBudget: 0 } },
    });
    rawResponse = (res.text ?? '').trim();
    geminiPromptTokens = res.usageMetadata?.promptTokenCount;
    geminiOutputTokens = res.usageMetadata?.candidatesTokenCount;
    geminiTotalTokens = res.usageMetadata?.totalTokenCount;
  } catch {
    // falls through
  }
  // Built before the `parseInsights` empty-check so an error after
  // Gemini billed tokens (the SDK responded but the bullets didn't
  // parse) still carries the spend telemetry. See the matching
  // comment on the article track.
  const geminiFields: Partial<StoryLog> = {
    ...(geminiPromptTokens !== undefined ? { geminiPromptTokens } : {}),
    ...(geminiOutputTokens !== undefined ? { geminiOutputTokens } : {}),
    ...(geminiTotalTokens !== undefined ? { geminiTotalTokens } : {}),
  };
  const insights = parseInsights(rawResponse);
  if (insights.length === 0) return log({ outcome: 'error', ...geminiFields });

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
      ...geminiFields,
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
    ...geminiFields,
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
      geminiPromptTokensTotal: 0,
      geminiOutputTokensTotal: 0,
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
  let geminiPromptTokensTotal = 0;
  let geminiOutputTokensTotal = 0;

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
      if (typeof entry.geminiPromptTokens === 'number') {
        geminiPromptTokensTotal += entry.geminiPromptTokens;
      }
      if (typeof entry.geminiOutputTokens === 'number') {
        geminiOutputTokensTotal += entry.geminiOutputTokens;
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
    geminiPromptTokensTotal,
    geminiOutputTokensTotal,
  };
  logger(runEntry);

  return json({ ok: true, feed, storyCount, processed, outcomes });
}

export async function GET(request: Request): Promise<Response> {
  return handleWarmRequest(request);
}
