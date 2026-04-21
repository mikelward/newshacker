import { GoogleGenAI } from '@google/genai';
import { Redis } from '@upstash/redis';

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
// can ride the cheaper 1h cadence. TTLs are seconds because that's what
// Redis EX takes; the wall-clock comparison below uses ms.
const YOUNG_STORY_WINDOW_MS = 2 * 60 * 60 * 1000;
const YOUNG_STORY_TTL_SECONDS = 30 * 60;
const OLDER_STORY_TTL_SECONDS = 60 * 60;

// Cache-Control on success. Same rationale as api/summary.ts: the shared
// cache lives in KV (Upstash), not the edge CDN, because the CDN is
// regional and a popular cross-region story would still pay one Gemini
// call per region. `private, no-store` keeps the function in the request
// path so KV is consulted; the service worker still caches per its own
// runtime rule (see vite.config.ts).
const NO_STORE_HEADER = 'private, no-store';

// Max per-comment plaintext length fed into the prompt. Long comments
// are truncated to keep total prompt size bounded and predictable.
const MAX_COMMENT_CHARS = 2000;

// Shared backend cache: see api/summary.ts for the rationale on Upstash
// over Vercel edge CDN, on the env-var fallback chain, and on why the
// per-instance Map was removed in favor of a single shared store.
const KV_KEY_PREFIX = 'newshacker:summary:comments:';

export interface CommentsSummaryStore {
  get(storyId: number): Promise<string[] | null>;
  set(
    storyId: number,
    insights: string[],
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
        const value = await redis.get<string[]>(`${KV_KEY_PREFIX}${storyId}`);
        return value ?? null;
      } catch {
        return null;
      }
    },
    async set(storyId, insights, ttlSeconds) {
      try {
        await redis.set(`${KV_KEY_PREFIX}${storyId}`, insights, {
          ex: ttlSeconds,
        });
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

function parseStoryId(raw: string | null): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

function computeTtlSeconds(
  storyTimeSec: number | undefined,
  nowMs: number,
): number {
  if (!storyTimeSec) return OLDER_STORY_TTL_SECONDS;
  const ageMs = nowMs - storyTimeSec * 1000;
  return ageMs < YOUNG_STORY_WINDOW_MS
    ? YOUNG_STORY_TTL_SECONDS
    : OLDER_STORY_TTL_SECONDS;
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
  // `null` = explicitly disable the shared cache for this request;
  // `undefined` = use the default (lazy-initialised) Upstash store.
  store?: CommentsSummaryStore | null;
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
  const store =
    deps.store === undefined ? getDefaultStore() : deps.store;

  if (store) {
    // Fail-open at the handler layer too: if the store implementation
    // forgets to catch (the default Upstash one does, but tests and
    // future stores might not), KV trouble must not break the endpoint.
    try {
      const cached = await store.get(storyId);
      if (cached && cached.length > 0) {
        return json({ insights: cached, cached: true });
      }
    } catch {
      // fall through to live generation
    }
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

  const ttlSeconds = computeTtlSeconds(story.time, now());
  if (store) {
    try {
      await store.set(storyId, insights, ttlSeconds);
    } catch {
      // best-effort write
    }
  }
  return json({ insights });
}

export async function GET(request: Request): Promise<Response> {
  return handleCommentsSummaryRequest(request);
}
