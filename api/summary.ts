import { GoogleGenAI } from '@google/genai';

const MODEL = 'gemini-2.5-flash';
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_URL_LEN = 2048;
const MAX_CONTENT_CHARS = 200_000;

const JINA_ENDPOINT = 'https://r.jina.ai/';
const JINA_TIMEOUT_MS = 15_000;

const RAW_FETCH_TIMEOUT_MS = 8_000;
// A realistic desktop User-Agent for the raw-fetch fallback. Some publishers
// serve a bot-blocked page to bare UAs; this isn't a spoof, it's just polite
// defaults that match what any real browser sends.
const RAW_FETCH_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const DEFAULT_ALLOWED_HOSTS = ['hnews.app', 'newshacker.app'];

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

type CacheEntry = { summary: string; ts: number };

// Per-instance in-memory cache. Vercel may run multiple instances, so this is
// best-effort — not a correctness boundary. It just trims obvious repeats.
const cache = new Map<string, CacheEntry>();

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
    `The article was fetched from ${articleUrl}. Ignore navigation, boilerplate, and markup; focus on the main body.\n\n` +
    `--- BEGIN ARTICLE ---\n${content}\n--- END ARTICLE ---`
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

interface GenerateRequest {
  model: string;
  contents: string;
  config?: { tools?: unknown[] };
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
  now?: () => number;
  fetchImpl?: typeof fetch;
  jinaApiKey?: string;
}

function clampContent(body: string): string | null {
  const trimmed =
    body.length > MAX_CONTENT_CHARS ? body.slice(0, MAX_CONTENT_CHARS) : body;
  const clean = trimmed.trim();
  return clean || null;
}

// Jina's Reader API (r.jina.ai) handles JS-rendered pages, paywalls, and
// bot-blocked sites that our raw fetch can't reach. Returns clean markdown
// that we can feed to Gemini directly. Free tier via API key is generous.
async function fetchViaJina(
  articleUrl: string,
  jinaApiKey: string,
  deps: SummaryDeps,
): Promise<string | null> {
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
    if (!res.ok) return null;
    return clampContent(await res.text());
  } catch {
    return null;
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
): Promise<string | null> {
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
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (
      !contentType.includes('text/html') &&
      !contentType.includes('text/plain') &&
      !contentType.includes('application/xhtml')
    ) {
      return null;
    }
    return clampContent(await res.text());
  } catch {
    return null;
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
  const articleUrl = searchParams.get('url');

  if (!articleUrl || !isValidHttpUrl(articleUrl)) {
    return json({ error: 'Invalid url parameter' }, 400);
  }

  const now = deps.now ?? Date.now;
  const cached = cache.get(articleUrl);
  if (cached && now() - cached.ts < CACHE_TTL_MS) {
    return json({ summary: cached.summary, cached: true });
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return json({ error: 'Summary is not configured' }, 503);
  }

  const jinaApiKey = deps.jinaApiKey ?? process.env.JINA_API_KEY;
  let content: string | null = null;
  if (jinaApiKey) {
    content = await fetchViaJina(articleUrl, jinaApiKey, deps);
  }
  if (!content) {
    content = await fetchRawHtml(articleUrl, deps);
  }
  if (!content) {
    return json({ error: 'Could not access the article' }, 502);
  }

  const client: SummaryClient = deps.createClient
    ? deps.createClient(apiKey)
    : (new GoogleGenAI({ apiKey }) as unknown as SummaryClient);

  let summary = '';
  try {
    const response = await client.models.generateContent({
      model: MODEL,
      contents: buildPrompt(articleUrl, content),
    });
    summary = (response.text ?? '').trim();
  } catch {
    // falls through to the 502 below
  }

  if (!summary) {
    return json({ error: 'Summarization failed' }, 502);
  }

  cache.set(articleUrl, { summary, ts: now() });
  return json({ summary });
}

export function __clearCacheForTests(): void {
  cache.clear();
}

export async function GET(request: Request): Promise<Response> {
  return handleSummaryRequest(request);
}
