import { GoogleGenAI } from '@google/genai';

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
const TOP_LEVEL_SAMPLE_SIZE = 20;

// Freshness-aware server TTL. A young, front-paged story gains comments
// rapidly in its first couple of hours, so the summary goes stale fast
// — re-run every 30 min. Older stories have settled conversations and
// can ride the cheaper 1h cadence.
const YOUNG_STORY_WINDOW_MS = 2 * 60 * 60 * 1000;
const YOUNG_STORY_TTL_MS = 30 * 60 * 1000;
const OLDER_STORY_TTL_MS = 60 * 60 * 1000;

// Shared-cache layer on Vercel's edge CDN. Mirrors the per-story TTL
// above so one cache-miss pays Gemini once across all instances, not
// once per instance. `stale-while-revalidate` keeps the edge serving
// instantly while refreshing in the background. See api/summary.ts for
// the rationale on why Referer is not part of the cache key.
const YOUNG_STORY_EDGE_CACHE =
  'public, s-maxage=1800, stale-while-revalidate=3600';
const OLDER_STORY_EDGE_CACHE =
  'public, s-maxage=3600, stale-while-revalidate=14400';
const NO_STORE_HEADER = 'private, no-store';

function edgeCacheHeaderForTtl(ttlMs: number): string {
  return ttlMs === YOUNG_STORY_TTL_MS
    ? YOUNG_STORY_EDGE_CACHE
    : OLDER_STORY_EDGE_CACHE;
}

// Max per-comment plaintext length fed into the prompt. Long comments
// are truncated to keep total prompt size bounded and predictable.
const MAX_COMMENT_CHARS = 2000;

type CacheEntry = { insights: string[]; expiresAt: number; ttlMs: number };

// Per-instance in-memory cache. Vercel may run multiple instances, so this is
// best-effort — not a correctness boundary. It just trims obvious repeats.
const cache = new Map<number, CacheEntry>();

function parseStoryId(raw: string | null): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

function computeTtlMs(storyTimeSec: number | undefined, nowMs: number): number {
  if (!storyTimeSec) return OLDER_STORY_TTL_MS;
  const ageMs = nowMs - storyTimeSec * 1000;
  return ageMs < YOUNG_STORY_WINDOW_MS ? YOUNG_STORY_TTL_MS : OLDER_STORY_TTL_MS;
}

// Minimal HTML-to-plaintext. HN comment bodies use a constrained subset
// (<p>, <i>, <b>, <a>, <pre>, <code>, <br>), so a tag strip + entity
// decode is enough to feed a language model — we don't need DOMPurify
// server-side.
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

function buildPrompt(title: string | undefined, transcript: string): string {
  const header = title ? `Article title: ${title}\n\n` : '';
  return (
    `${header}Below are the top comments from a Hacker News discussion. ` +
    `Extract 3 to 5 of the most useful insights from the conversation — points ` +
    `of agreement, notable dissents, corrections, or interesting additions.\n\n` +
    `Return one insight per line, each a short sentence under 25 words. ` +
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

function json(
  body: unknown,
  status = 200,
  cacheControl?: string,
): Response {
  const resolved =
    cacheControl ??
    (status >= 200 && status < 300 ? OLDER_STORY_EDGE_CACHE : NO_STORE_HEADER);
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': resolved,
    },
  });
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
}

export async function handleCommentsSummaryRequest(
  request: Request,
  deps: CommentsSummaryDeps = {},
): Promise<Response> {
  if (!isAllowedReferer(request.headers.get('referer'))) {
    return json({ error: 'Forbidden' }, 403);
  }

  const { searchParams } = new URL(request.url);
  const storyId = parseStoryId(searchParams.get('id'));
  if (storyId === null) {
    return json({ error: 'Invalid id parameter' }, 400);
  }

  const now = deps.now ?? Date.now;
  const cached = cache.get(storyId);
  if (cached && now() < cached.expiresAt) {
    return json(
      { insights: cached.insights, cached: true },
      200,
      edgeCacheHeaderForTtl(cached.ttlMs),
    );
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return json({ error: 'Summary is not configured' }, 503);
  }

  const fetchItem = deps.fetchItem ?? defaultFetchItem;
  let story: HNItem | null;
  try {
    story = await fetchItem(storyId, request.signal);
  } catch {
    return json({ error: 'Could not load story' }, 502);
  }
  if (!story || story.deleted || story.dead) {
    return json({ error: 'Story not available' }, 404);
  }

  const kidIds = (story.kids ?? []).slice(0, TOP_LEVEL_SAMPLE_SIZE);
  if (kidIds.length === 0) {
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
    return json({ error: 'No comments to summarize' }, 404);
  }

  const transcript = usableComments
    .map((comment, index) => {
      const body = htmlToPlainText(comment.text).slice(0, MAX_COMMENT_CHARS);
      return `[#${index + 1}]\n${body}`;
    })
    .join('\n\n');

  const client: SummaryClient = deps.createClient
    ? deps.createClient(apiKey)
    : (new GoogleGenAI({ apiKey }) as unknown as SummaryClient);

  let rawResponse = '';
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
  } catch {
    return json({ error: 'Summarization failed' }, 502);
  }

  const insights = parseInsights(rawResponse);
  if (insights.length === 0) {
    return json({ error: 'Summarization failed' }, 502);
  }

  const ttlMs = computeTtlMs(story.time, now());
  cache.set(storyId, { insights, expiresAt: now() + ttlMs, ttlMs });
  return json({ insights }, 200, edgeCacheHeaderForTtl(ttlMs));
}

export function __clearCacheForTests(): void {
  cache.clear();
}

export async function GET(request: Request): Promise<Response> {
  return handleCommentsSummaryRequest(request);
}
