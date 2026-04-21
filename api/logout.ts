// POST /api/logout — clear the `hn_session` cookie on our origin.
//
// We do not hit news.ycombinator.com to invalidate the HN cookie. HN's
// cookie lives on their domain; we only control our own copy. Logging
// out of newshacker therefore does not log you out of HN itself —
// that's by design (and matches user intuition for "sign out of this
// reader app").

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'hn_session';

// Same attributes as the cookie we set at login time (minus the value),
// so the browser actually matches and replaces it. `Max-Age=0` tells the
// browser to drop it immediately.
function clearSessionCookieHeader(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ');
}

function json(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      ...extraHeaders,
    },
  });
}

export async function handleLogoutRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  return json({ ok: true }, 200, { 'set-cookie': clearSessionCookieHeader() });
}

export async function POST(request: Request): Promise<Response> {
  return handleLogoutRequest(request);
}
