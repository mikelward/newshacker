// POST /api/vote — forward a single upvote or un-upvote action to
// news.ycombinator.com on behalf of the signed-in user.
//
// Request body: { id: number, how: "up" | "un" }
// Responses:
//   204 on success
//   400 on malformed body
//   401 on missing / expired HN session
//   405 on non-POST
//   502 if HN is unreachable or the scraped item page is missing the
//       expected `vote?id=…&how=…&auth=…` anchor (HN HTML changed, or
//       the user has already voted the way they're trying to).
//
// The per-item `auth` token is scraped from the item page — HN signs
// each vote link with a per-user, per-item token that must be
// replayed. Mirrors api/hn-favorite.ts; helpers are intentionally
// duplicated because api/*.ts cannot share modules on Vercel (see
// AGENTS.md § "Vercel `api/` gotchas" and api/imports.test.ts).

const HN_ITEM_URL = (id: number) =>
  `https://news.ycombinator.com/item?id=${id}`;
const HN_ORIGIN = 'https://news.ycombinator.com';

const HN_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'hn_session';
const HN_COOKIE_NAME = process.env.HN_COOKIE_NAME ?? 'user';
const HN_USERNAME_RE = /^[a-zA-Z0-9_-]{2,32}$/;

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

// Scrape the upvote / un-upvote auth token out of the rendered item
// page. HN emits one of:
//   - `<a href="vote?id=<id>&how=up&auth=<tok>&goto=item%3Fid%3D…">` for
//     items the user has NOT voted on yet (upvotable).
//   - `<a href="vote?id=<id>&how=un&auth=<tok>&goto=item%3Fid%3D…">` for
//     items the user has already voted on (unvotable).
// Query-string ordering isn't guaranteed, so we decode entities, parse
// as a URL, and match on (id, how). Exported for testing.
export function extractAuthToken(
  html: string,
  id: number,
  how: 'up' | 'un',
): string | null {
  const anchorRe = /<a\b[^>]*\bhref=(?:"([^"]*)"|'([^']*)')[^>]*>/gi;
  for (const m of html.matchAll(anchorRe)) {
    const rawHref = m[1] ?? m[2] ?? '';
    if (!rawHref) continue;
    const href = rawHref.replace(/&amp;/gi, '&');
    if (!/(^|\/)vote\?/.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href, 'https://news.ycombinator.com/');
    } catch {
      continue;
    }
    if (url.searchParams.get('id') !== String(id)) continue;
    if (url.searchParams.get('how') !== how) continue;
    const auth = url.searchParams.get('auth');
    if (!auth) continue;
    return auth;
  }
  return null;
}

export interface VoteBody {
  id: unknown;
  how: unknown;
}

export interface VoteDeps {
  fetchImpl?: typeof fetch;
}

export async function handleVoteRequest(
  request: Request,
  deps: VoteDeps = {},
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

  let body: VoteBody;
  try {
    body = (await request.json()) as VoteBody;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const id =
    typeof body.id === 'number' &&
    Number.isSafeInteger(body.id) &&
    body.id > 0
      ? body.id
      : null;
  const how = body.how === 'up' || body.how === 'un' ? body.how : null;
  if (id === null || how === null) {
    return json({ error: 'Missing or invalid id/how' }, 400);
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

  const token = extractAuthToken(html, id, how);
  if (!token) {
    // Happens if (a) HN's HTML changed shape, (b) the item is dead /
    // hidden so HN omits the vote link, or (c) the item is already in
    // the requested state (asking to upvote something already voted,
    // or to unvote something not yet voted). We can't distinguish
    // these without more scraping; treat all as 502.
    return json(
      { error: 'Could not find vote link on Hacker News item page' },
      502,
    );
  }

  // 2) Issue the vote. HN's vote endpoint 302s back to the item
  // (success) or to /login (session died mid-flight).
  const voteUrl = `${HN_ORIGIN}/vote?id=${id}&how=${how}&auth=${encodeURIComponent(token)}&goto=news`;

  let voteRes: Response;
  try {
    voteRes = await fetchFn(voteUrl, {
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

  if (voteRes.status >= 300 && voteRes.status < 400) {
    const loc = voteRes.headers.get('location') ?? '';
    if (/\blogin\b/i.test(loc)) {
      return json({ error: 'Hacker News session expired' }, 401);
    }
    return new Response(null, { status: 204 });
  }
  if (voteRes.ok) {
    return new Response(null, { status: 204 });
  }
  return json({ error: 'Hacker News rejected the vote' }, 502);
}

export async function POST(request: Request): Promise<Response> {
  return handleVoteRequest(request);
}

export const _internals = {
  extractAuthToken,
  parseCookieHeader,
  usernameFromSessionValue,
};
