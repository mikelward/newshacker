import { GoogleGenAI } from '@google/genai';

const MODEL = 'gemini-2.5-flash';
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_URL_LEN = 2048;
const FETCH_TIMEOUT_MS = 8000;
const MAX_CONTENT_CHARS = 200_000;

// A realistic desktop User-Agent. Some publishers (e.g. theverge.com) serve
// a bot-blocked page to bare UAs, which is why Gemini's urlContext sometimes
// reports no access — we look more like a regular browser here.
const FETCH_USER_AGENT =
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

function buildUrlContextPrompt(articleUrl: string): string {
  return `Summarize this in a single, concise sentence without using bullet points or introductory text: ${articleUrl}`;
}

function buildInlineContentPrompt(articleUrl: string, content: string): string {
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

interface UrlMetadataEntry {
  retrievedUrl?: string;
  urlRetrievalStatus?: string;
}

interface GenerateResponse {
  text?: string | null;
  candidates?: Array<{
    urlContextMetadata?: {
      urlMetadata?: UrlMetadataEntry[];
    };
  }>;
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
}

// Returns true if every URL Gemini tried to retrieve came back as anything
// other than SUCCESS. When this is the case the model's "summary" is usually
// an apology — we'd rather fall back to fetching the page ourselves.
function urlContextFailed(response: GenerateResponse): boolean {
  const entries = response.candidates?.[0]?.urlContextMetadata?.urlMetadata;
  if (!entries || entries.length === 0) return false;
  return entries.every(
    (m) =>
      (m.urlRetrievalStatus ?? '').toUpperCase() !==
      'URL_RETRIEVAL_STATUS_SUCCESS',
  );
}

async function fetchArticleContent(
  articleUrl: string,
  deps: SummaryDeps,
): Promise<string | null> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchFn(articleUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': FETCH_USER_AGENT,
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
    const body = await res.text();
    const trimmed = body.length > MAX_CONTENT_CHARS
      ? body.slice(0, MAX_CONTENT_CHARS)
      : body;
    return trimmed.trim() || null;
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

  const client: SummaryClient = deps.createClient
    ? deps.createClient(apiKey)
    : (new GoogleGenAI({ apiKey }) as unknown as SummaryClient);

  let summary = '';
  let urlContextWorked = true;
  try {
    const response = await client.models.generateContent({
      model: MODEL,
      contents: buildUrlContextPrompt(articleUrl),
      config: { tools: [{ urlContext: {} }] },
    });
    urlContextWorked = !urlContextFailed(response);
    if (urlContextWorked) {
      summary = (response.text ?? '').trim();
    }
  } catch {
    urlContextWorked = false;
  }

  if (!summary) {
    const content = await fetchArticleContent(articleUrl, deps);
    if (content) {
      try {
        const fallback = await client.models.generateContent({
          model: MODEL,
          contents: buildInlineContentPrompt(articleUrl, content),
        });
        summary = (fallback.text ?? '').trim();
      } catch {
        // fall through to the shared error path below
      }
    }
  }

  if (!summary) {
    const errorMessage = urlContextWorked
      ? 'Summarization failed'
      : 'Could not access the article';
    return json({ error: errorMessage }, 502);
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
