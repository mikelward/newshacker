// POST /api/hn-favorite — forward a single favorite or unfavorite
// action to news.ycombinator.com on behalf of the signed-in user.
//
// Request body: { id: number, action: "favorite" | "unfavorite" }
// Responses:
//   204 on success
//   400 on malformed body
//   401 on missing / expired HN session
//   405 on non-POST
//   502 if HN is unreachable, returns a redirect to /login (session
//       expired upstream), or the scraped item page is missing the
//       expected `fave?id=…&auth=…` anchor (HN HTML changed).
//
// The per-item auth token is scraped from the item page — HN signs
// each favorite link with a per-user, per-item token that must be
// replayed. This matches the planned voting flow in
// IMPLEMENTATION_PLAN.md § 5d; if voting lands first the scraper can
// be generalized at that point.

const HN_ITEM_URL = (id: number) =>
  `https://news.ycombinator.com/item?id=${id}`;
const HN_ORIGIN = 'https://news.ycombinator.com';

const HN_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'hn_session';
const HN_COOKIE_NAME = process.env.HN_COOKIE_NAME ?? 'user';
const HN_USERNAME_RE = /^[a-zA-Z0-9_-]{2,32}$/;

// Duplicated from api/me.ts etc. — see § 5-infra in IMPLEMENTATION_PLAN.md.
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

// Pull the auth token out of the logged-in-user's favorite /
// unfavorite anchor on the item page. HN renders:
//   - `<a href="fave?id=<id>&auth=<tok>">favorite</a>` for items the
//     user has NOT favorited yet, and
//   - `<a href="fave?id=<id>&auth=<tok>&un=t">un-favorite</a>` for
//     items the user already favorited
// (query-string ordering can be either way — HN has been observed
// emitting `&un=t` before OR after `&auth=…`, so we can't anchor on
// a fixed order. Earlier strict-ordering regex caused the unfavorite
// path to 502 in practice.)
//
// Strategy: find every `<a href=…>` anchor pointing at `fave?…`,
// decode entities, parse as a URL, then check the query params.
// The one whose `id` matches and whose `un=t` presence matches the
// requested action is ours. Exported for testing.
export function extractAuthToken(
  html: string,
  id: number,
  action: 'favorite' | 'unfavorite',
): string | null {
  const anchorRe = /<a\b[^>]*\bhref=(?:"([^"]*)"|'([^']*)')[^>]*>/gi;
  for (const m of html.matchAll(anchorRe)) {
    const rawHref = m[1] ?? m[2] ?? '';
    if (!rawHref) continue;
    const href = rawHref.replace(/&amp;/gi, '&');
    if (!/(^|\/)fave\?/.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href, 'https://news.ycombinator.com/');
    } catch {
      continue;
    }
    if (url.searchParams.get('id') !== String(id)) continue;
    const auth = url.searchParams.get('auth');
    if (!auth) continue;
    const hasUn = url.searchParams.get('un') === 't';
    if (action === 'unfavorite' && !hasUn) continue;
    if (action === 'favorite' && hasUn) continue;
    return auth;
  }
  return null;
}

export interface HnFavoriteBody {
  id: unknown;
  action: unknown;
}

export interface HnFavoriteDeps {
  fetchImpl?: typeof fetch;
}

export async function handleHnFavoriteRequest(
  request: Request,
  deps: HnFavoriteDeps = {},
): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const cookies = parseCookieHeader(request.headers.get('cookie'));
  const sessionValue = cookies[SESSION_COOKIE_NAME];
  const username = usernameFromSessionValue(sessionValue);
  if (!username || !sessionValue) {
    return json({ error: 'Not authenticated' }, 401);
  }

  let body: HnFavoriteBody;
  try {
    body = (await request.json()) as HnFavoriteBody;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const id =
    typeof body.id === 'number' &&
    Number.isSafeInteger(body.id) &&
    body.id > 0
      ? body.id
      : null;
  const action =
    body.action === 'favorite' || body.action === 'unfavorite'
      ? body.action
      : null;
  if (id === null || action === null) {
    return json({ error: 'Missing or invalid id/action' }, 400);
  }

  const fetchFn = deps.fetchImpl ?? fetch;
  const cookieHeader = `${HN_COOKIE_NAME}=${sessionValue}`;

  // 1) Fetch the item page and scrape the per-item auth token.
  let itemRes: Response;
  try {
    itemRes = await fetchFn(HN_ITEM_URL(id), {
      method: 'GET',
      headers: {
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': HN_USER_AGENT,
        cookie: cookieHeader,
      },
      redirect: 'manual',
    });
  } catch {
    return json({ error: 'Could not reach Hacker News' }, 502);
  }
  if (itemRes.status >= 300 && itemRes.status < 400) {
    return json({ error: 'Hacker News session expired' }, 401);
  }
  if (!itemRes.ok) {
    return json({ error: 'Hacker News returned an error' }, 502);
  }

  let html: string;
  try {
    html = await itemRes.text();
  } catch {
    return json({ error: 'Could not read Hacker News response' }, 502);
  }

  const token = extractAuthToken(html, id, action);
  if (!token) {
    // Happens if (a) HN's HTML changed shape, (b) the session cookie
    // was valid on /item but HN didn't render the fave link (e.g.
    // item is dead), or (c) the action is already in HN's desired
    // state (already favorited when we ask to favorite, or vice
    // versa). We can't distinguish (c) without more scraping; treat
    // all three as 502 and let the queue retry or eventually drop.
    return json(
      { error: 'Could not find favorite link on Hacker News item page' },
      502,
    );
  }

  // 2) Issue the favorite / unfavorite.
  const faveUrl =
    action === 'favorite'
      ? `${HN_ORIGIN}/fave?id=${id}&auth=${encodeURIComponent(token)}`
      : `${HN_ORIGIN}/fave?id=${id}&un=t&auth=${encodeURIComponent(token)}`;

  let faveRes: Response;
  try {
    faveRes = await fetchFn(faveUrl, {
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

  // HN's /fave endpoint responds with a 302 to /item on success. A
  // 302 to /login means the session died between step 1 and step 2.
  if (faveRes.status >= 300 && faveRes.status < 400) {
    const loc = faveRes.headers.get('location') ?? '';
    if (/\blogin\b/i.test(loc)) {
      return json({ error: 'Hacker News session expired' }, 401);
    }
    return new Response(null, { status: 204 });
  }
  if (faveRes.ok) {
    return new Response(null, { status: 204 });
  }
  return json({ error: 'Hacker News rejected the action' }, 502);
}

export async function POST(request: Request): Promise<Response> {
  return handleHnFavoriteRequest(request);
}

export const _internals = {
  extractAuthToken,
  parseCookieHeader,
  usernameFromSessionValue,
};
