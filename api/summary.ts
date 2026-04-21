import { GoogleGenAI } from '@google/genai';
import { Redis } from '@upstash/redis';

const MODEL = 'gemini-2.5-flash-lite';
const CACHE_TTL_SECONDS = 60 * 60;
const MAX_URL_LEN = 2048;
const MAX_CONTENT_CHARS = 200_000;

// Cache-Control on success. We deliberately do NOT use the edge CDN as
// the shared cache anymore — Vercel's CDN is regional, so popular stories
// would still pay one Gemini call per region. The shared cache lives in
// KV (see SummaryStore below); the edge would just hide stale-by-region
// data behind it. `private, no-store` keeps the function in the request
// path so KV is always consulted; the service worker still caches per
// its own runtime rule (see vite.config.ts).
const NO_STORE_HEADER = 'private, no-store';

const JINA_ENDPOINT = 'https://r.jina.ai/';
const JINA_TIMEOUT_MS = 15_000;

const RAW_FETCH_TIMEOUT_MS = 8_000;
// A realistic desktop User-Agent for the raw-fetch fallback. Some publishers
// serve a bot-blocked page to bare UAs; this isn't a spoof, it's just polite
// defaults that match what any real browser sends.
const RAW_FETCH_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

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
// cache (the per-instance Map is intentionally gone — a 5ms KV read is
// the right shared-cache latency, and keeping a process-local Map next
// to it just creates incoherent state across instances).
//
// Cache key is the HN story id, not the article URL. Two HN posts
// pointing at the same external URL pay independently — accepted trade
// for not letting any caller pin arbitrary cache keys (and burn
// Gemini/Jina spend) via a `?url=` of their choosing.
const KV_KEY_PREFIX = 'newshacker:summary:article:';

export interface SummaryStore {
  get(storyId: number): Promise<string | null>;
  set(storyId: number, summary: string, ttlSeconds: number): Promise<void>;
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
        const value = await redis.get<string>(`${KV_KEY_PREFIX}${storyId}`);
        return value ?? null;
      } catch {
        // Fail-open: KV unreachable falls through to live generation.
        return null;
      }
    },
    async set(storyId, summary, ttlSeconds) {
      try {
        await redis.set(`${KV_KEY_PREFIX}${storyId}`, summary, {
          ex: ttlSeconds,
        });
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
}

function clampContent(body: string): string | null {
  const trimmed =
    body.length > MAX_CONTENT_CHARS ? body.slice(0, MAX_CONTENT_CHARS) : body;
  const clean = trimmed.trim();
  return clean || null;
}

type FetchFailure = 'timeout' | 'unreachable';
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

// Last-ditch fallback: fetch the article ourselves with a browser-like UA.
// Only catches the subset of sites that return usable HTML to a plain GET,
// which is a strict subset of what Jina handles — but it costs nothing and
// keeps things working if Jina is down or unconfigured.
async function fetchRawHtml(
  articleUrl: string,
  deps: SummaryDeps,
): Promise<FetchOutcome> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RAW_FETCH_TIMEOUT_MS);
  try {
    const res = await fetchFn(articleUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': RAW_FETCH_USER_AGENT,
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) return { ok: false, failure: 'unreachable' };
    const contentType = res.headers.get('content-type') ?? '';
    if (
      !contentType.includes('text/html') &&
      !contentType.includes('text/plain') &&
      !contentType.includes('application/xhtml')
    ) {
      return { ok: false, failure: 'unreachable' };
    }
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
    try {
      const cached = await store.get(storyId);
      if (cached) return json({ summary: cached, cached: true });
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
  if (!story.url || !isValidHttpUrl(story.url)) {
    return json(
      { error: 'Story has no article to summarize', reason: 'no_article' },
      400,
    );
  }
  const articleUrl = story.url;

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return json(
      { error: 'Summary is not configured', reason: 'not_configured' },
      503,
    );
  }

  const jinaApiKey = deps.jinaApiKey ?? process.env.JINA_API_KEY;
  let content: string | null = null;
  let sawTimeout = false;
  if (jinaApiKey) {
    const result = await fetchViaJina(articleUrl, jinaApiKey, deps);
    if (result.ok) content = result.content;
    else if (result.failure === 'timeout') sawTimeout = true;
  }
  if (!content) {
    const result = await fetchRawHtml(articleUrl, deps);
    if (result.ok) content = result.content;
    else if (result.failure === 'timeout') sawTimeout = true;
  }
  if (!content) {
    if (sawTimeout) {
      return json(
        {
          error: "The article site didn't respond in time",
          reason: 'source_timeout',
        },
        504,
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

  const client: SummaryClient = deps.createClient
    ? deps.createClient(apiKey)
    : (new GoogleGenAI({ apiKey }) as unknown as SummaryClient);

  let summary = '';
  try {
    const response = await client.models.generateContent({
      model: MODEL,
      contents: buildPrompt(articleUrl, content),
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
    try {
      await store.set(storyId, summary, CACHE_TTL_SECONDS);
    } catch {
      // best-effort write
    }
  }
  return json({ summary });
}

export async function GET(request: Request): Promise<Response> {
  return handleSummaryRequest(request);
}
