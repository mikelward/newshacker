// GET /api/hn-favorites-list — returns the signed-in user's favorite
// story IDs as scraped from https://news.ycombinator.com/favorites?id=<user>.
// 401 if the hn_session cookie is missing; 502 if HN itself is
// unreachable or returns an unexpected shape.
//
// HN paginates the page at 30 items by default with a "More" anchor;
// we follow up to MAX_PAGES to cap worst-case latency and fetch cost.
// Returned IDs are deduplicated and preserve HN's document order
// (which is roughly reverse-chronological by favorite time — HN
// doesn't expose a per-favorite timestamp, so clients that want to
// merge with local state should treat these entries as `at: 0`).

import { parseFavoritesPage } from './hnFavoritesScrape';

const HN_FAVORITES_URL = 'https://news.ycombinator.com/favorites';
const HN_ORIGIN = 'https://news.ycombinator.com';

// 20 pages × 30 items/page = 600 favorites. Above that, we stop
// paginating and return what we have. 600 covers all but the most
// prolific favoriters; a future pass can raise the cap if complaints
// come in.
const MAX_PAGES = 20;

// Matches the login UA. Node's default undici UA is sometimes treated
// as a bot by HN and can yield a stripped response.
const HN_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'hn_session';
const HN_COOKIE_NAME = process.env.HN_COOKIE_NAME ?? 'user';
const HN_USERNAME_RE = /^[a-zA-Z0-9_-]{2,32}$/;

// Duplicated from api/me.ts / api/sync.ts on purpose — Vercel's
// per-file function bundler has been flaky about tracing shared
// modules outside `api/`, and the helpers are short. See
// IMPLEMENTATION_PLAN.md § 5-infra.
function parseCookieHeader(
  header: string | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const raw of header.split(';')) {
    const part = raw.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function usernameFromSessionValue(value: string | undefined): string | null {
  if (!value) return null;
  const amp = value.indexOf('&');
  const candidate = amp === -1 ? value : value.slice(0, amp);
  return HN_USERNAME_RE.test(candidate) ? candidate : null;
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

// Resolve the morelink's href against the favorites URL. HN's More
// link is relative (`favorites?id=user&p=2`), so we construct the
// absolute URL via the `URL` constructor anchored on the origin.
function resolveMorePath(morePath: string): string {
  // Absolute URLs are already fine.
  if (/^https?:\/\//i.test(morePath)) return morePath;
  return new URL(morePath, `${HN_ORIGIN}/`).toString();
}

export interface FavoritesListDeps {
  fetchImpl?: typeof fetch;
  // Test seam — override the page cap for targeted pagination tests.
  maxPages?: number;
}

export interface FavoritesListResult {
  ids: number[];
  // True if we stopped because we hit the page cap before HN said
  // "no more". Useful telemetry; clients can ignore.
  truncated: boolean;
}

export async function handleHnFavoritesListRequest(
  request: Request,
  deps: FavoritesListDeps = {},
): Promise<Response> {
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const cookies = parseCookieHeader(request.headers.get('cookie'));
  const sessionValue = cookies[SESSION_COOKIE_NAME];
  const username = usernameFromSessionValue(sessionValue);
  if (!username || !sessionValue) {
    return json({ error: 'Not authenticated' }, 401);
  }

  const fetchFn = deps.fetchImpl ?? fetch;
  const maxPages = deps.maxPages ?? MAX_PAGES;

  const cookieHeader = `${HN_COOKIE_NAME}=${sessionValue}`;
  const allIds: number[] = [];
  const seen = new Set<number>();
  let nextUrl: string | null = `${HN_FAVORITES_URL}?id=${encodeURIComponent(username)}`;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    if (!nextUrl) break;
    let upstream: Response;
    try {
      upstream = await fetchFn(nextUrl, {
        method: 'GET',
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          'user-agent': HN_USER_AGENT,
          cookie: cookieHeader,
        },
        redirect: 'manual',
      });
    } catch {
      return json({ error: 'Could not reach Hacker News' }, 502);
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      // HN redirects unauthenticated callers to /login; treat that as
      // our session being dead so the client can prompt a re-login.
      return json({ error: 'Hacker News session expired' }, 401);
    }
    if (!upstream.ok) {
      return json({ error: 'Hacker News returned an error' }, 502);
    }

    let html: string;
    try {
      html = await upstream.text();
    } catch {
      return json({ error: 'Could not read Hacker News response' }, 502);
    }

    const { ids, morePath } = parseFavoritesPage(html);
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      allIds.push(id);
    }

    if (!morePath) {
      nextUrl = null;
      break;
    }
    nextUrl = resolveMorePath(morePath);
    if (page === maxPages - 1) truncated = true;
  }

  const result: FavoritesListResult = { ids: allIds, truncated };
  return json(result);
}

export async function GET(request: Request): Promise<Response> {
  return handleHnFavoritesListRequest(request);
}

export const _internals = {
  MAX_PAGES,
  resolveMorePath,
  parseCookieHeader,
  usernameFromSessionValue,
};
