// GET /api/me — returns `{ username }` when the caller has a valid
// `hn_session` cookie, 401 otherwise.
//
// We do NOT round-trip to news.ycombinator.com to re-validate the
// cookie; the cookie's presence is treated as proof of intent, and
// any downstream HN request that actually uses the cookie will fail
// with HN's own auth error if the session has since been revoked.
// This keeps the boot-time auth check free of an external dependency.

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'hn_session';

// Mirrors the validator in api/login.ts — usernames are letters, digits,
// dashes, underscores; 2–32 chars.
const HN_USERNAME_RE = /^[a-zA-Z0-9_-]{2,32}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
    },
  });
}

// Parse a `Cookie:` header value into a name → value map. Values are URL
// decoded to reverse the `encodeURIComponent` we apply at Set-Cookie
// time. Non-spec cookies (no `=`) are ignored.
export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
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

export function usernameFromSessionValue(value: string | undefined): string | null {
  if (!value) return null;
  const amp = value.indexOf('&');
  const candidate = amp === -1 ? value : value.slice(0, amp);
  return HN_USERNAME_RE.test(candidate) ? candidate : null;
}

export async function handleMeRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'Method not allowed' }, 405);
  }
  const cookies = parseCookieHeader(request.headers.get('cookie'));
  const username = usernameFromSessionValue(cookies[SESSION_COOKIE_NAME]);
  if (!username) return json({ error: 'Not authenticated' }, 401);
  return json({ username });
}

export async function GET(request: Request): Promise<Response> {
  return handleMeRequest(request);
}
