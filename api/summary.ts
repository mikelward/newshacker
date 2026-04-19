import { GoogleGenAI } from '@google/genai';

const MODEL = 'gemini-2.5-flash';
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_URL_LEN = 2048;

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

function buildPrompt(articleUrl: string): string {
  return `Summarize this in a single, concise sentence without using bullet points or introductory text: ${articleUrl}`;
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

  try {
    const response = await client.models.generateContent({
      model: MODEL,
      contents: buildPrompt(articleUrl),
      config: { tools: [{ urlContext: {} }] },
    });
    const summary = (response.text ?? '').trim();
    if (!summary) {
      return json({ error: 'Empty summary from model' }, 502);
    }
    cache.set(articleUrl, { summary, ts: now() });
    return json({ summary });
  } catch {
    return json({ error: 'Summarization failed' }, 502);
  }
}

export function __clearCacheForTests(): void {
  cache.clear();
}

export async function GET(request: Request): Promise<Response> {
  return handleSummaryRequest(request);
}
