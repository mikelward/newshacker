import { GoogleGenAI } from '@google/genai';
import { Redis } from '@upstash/redis';
import { createHash } from 'node:crypto';

const MODEL = 'gemini-2.5-flash-lite';
// Upstash records live 30 days. The cron (/api/warm-summaries) owns
// freshness for top-30 stories; anything that ages out of the cron's
// MAX_STORY_AGE window is served from whatever is in the cache until
// Upstash itself evicts it.
const RECORD_TTL_SECONDS = 60 * 60 * 24 * 30;
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

export interface SummaryDeps {
  createClient?: (apiKey: string) => SummaryClient;
  fetchImpl?: typeof fetch;
  fetchItem?: (id: number, signal?: AbortSignal) => Promise<HNItem | null>;
  jinaApiKey?: string;
  // `null` = explicitly disable the shared cache for this request;
  // `undefined` = use the default (lazy-initialised) Upstash store.
  store?: SummaryStore | null;
  now?: () => number;
}

function clampContent(body: string): string | null {
  const trimmed =
    body.length > MAX_CONTENT_CHARS ? body.slice(0, MAX_CONTENT_CHARS) : body;
  const clean = trimmed.trim();
  return clean || null;
}

type FetchFailure = 'timeout' | 'unreachable' | 'payment_required';
type FetchOutcome =
  | { ok: true; content: string }
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
    return content
      ? { ok: true, content }
      : { ok: false, failure: 'unreachable' };
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
    return json({ error: 'Forbidden' }, 403);
  }

  const { searchParams } = new URL(request.url);
  const storyId = parseStoryId(searchParams.get('id'));
  if (storyId === null) {
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
      if (cached) return json({ summary: cached.summary, cached: true });
    } catch {
      // fall through to live generation
    }
  }

  const fetchItem = deps.fetchItem ?? defaultFetchItem;
  let story: HNItem | null;
  try {
    story = await fetchItem(storyId, request.signal);
  } catch {
    return json(
      { error: 'Could not load story', reason: 'story_unreachable' },
      502,
    );
  }
  if (!story || story.deleted || story.dead) {
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
    return json(
      { error: 'Story has no article to summarize', reason: 'no_article' },
      400,
    );
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return json(
      { error: 'Summary is not configured', reason: 'not_configured' },
      503,
    );
  }

  let content: string;
  let prompt: string;
  if (hasArticleUrl) {
    const articleUrl = story.url!;
    const jinaApiKey = deps.jinaApiKey ?? process.env.JINA_API_KEY;
    if (!jinaApiKey) {
      return json(
        { error: 'Summary is not configured', reason: 'not_configured' },
        503,
      );
    }
    const jinaResult = await fetchViaJina(articleUrl, jinaApiKey, deps);
    if (!jinaResult.ok) {
      if (jinaResult.failure === 'timeout') {
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
        return json(
          {
            error: 'Summaries are temporarily unavailable',
            reason: 'summary_budget_exhausted',
          },
          503,
        );
      }
      return json(
        {
          error: 'Could not access the article',
          reason: 'source_unreachable',
        },
        502,
      );
    }
    content = jinaResult.content;
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
  } catch {
    // falls through to the 502 below
  }

  if (!summary) {
    return json(
      { error: 'Summarization failed', reason: 'summarization_failed' },
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
    };
    try {
      await store.set(storyId, record, RECORD_TTL_SECONDS);
    } catch {
      // best-effort write
    }
  }
  return json({ summary });
}

export async function GET(request: Request): Promise<Response> {
  return handleSummaryRequest(request);
}
