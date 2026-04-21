// POST /api/login — proxy credentials to news.ycombinator.com's /login form,
// capture the `user=<username>&<hash>` cookie it sets on success, and re-issue
// it on our own origin as an HTTP-only `hn_session` cookie.
//
// We never store the password anywhere (no logs, no cache); only the opaque
// HN cookie is persisted, and only as an HTTP-only Set-Cookie on the user's
// browser. The cookie is what future write endpoints (vote, etc.) will
// attach server-side when talking to HN.

const HN_LOGIN_URL = 'https://news.ycombinator.com/login';

// Max length for either username or password. HN's own limits are tighter
// but we don't mirror them 1:1 — this is a sanity ceiling that stops
// accidental megabyte-sized posts from reaching HN.
const MAX_CREDENTIAL_LEN = 1024;

// Realistic desktop User-Agent. Node's fetch sends `undici/...` by
// default, which HN sometimes treats as a bot — you can enter correct
// credentials and still get a passwordless response page (no `user=`
// Set-Cookie), which our code then reports as "Bad login." Matching
// the UA of a normal browser avoids that failure mode. This is not a
// spoof: every real browser sends one of these, and HN's own web form
// expects such a UA.
const HN_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// Names resolved once so a future env override (SPEC.md "Deployment")
// doesn't require code changes.
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'hn_session';
const HN_COOKIE_NAME = process.env.HN_COOKIE_NAME ?? 'user';

// 30 days — long enough that most users don't re-enter credentials weekly,
// short enough that a lost device eventually stops being a valid session.
// HN's own cookie is effectively permanent; we choose our own policy here.
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export interface LoginDeps {
  fetchImpl?: typeof fetch;
}

interface LoginBody {
  username?: unknown;
  password?: unknown;
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

// HN's `Set-Cookie: user=alice&abcdef...` — parse the value out. The Fetch
// spec's Headers.get('set-cookie') only returns the first entry when a
// response has multiple Set-Cookie headers; Node 18+ exposes
// `getSetCookie()` which returns them all. We prefer that when available
// so a response with other cookies alongside `user` still works.
export function extractHnSessionValue(
  headers: Headers,
  name: string = HN_COOKIE_NAME,
): string | null {
  const getAll = (headers as { getSetCookie?: () => string[] }).getSetCookie;
  const lines: string[] =
    typeof getAll === 'function'
      ? getAll.call(headers)
      : [headers.get('set-cookie')].filter((v): v is string => !!v);
  // Fallback combines multiple cookies on one line with commas; split on
  // commas that precede a `<name>=` pair rather than a date-value comma.
  const cookieRe = new RegExp(`(?:^|,\\s*)${escapeForRegex(name)}=([^;,]*)`);
  for (const line of lines) {
    const m = cookieRe.exec(line);
    if (m) return m[1];
  }
  return null;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// HN usernames: letters, digits, dashes, underscores; HN's own form says
// 2–15 chars, but historical accounts occasionally exceed that. 2–32 is
// lenient without being absurd.
const HN_USERNAME_RE = /^[a-zA-Z0-9_-]{2,32}$/;

export function usernameFromHnCookieValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const amp = value.indexOf('&');
  const candidate = amp === -1 ? value : value.slice(0, amp);
  return HN_USERNAME_RE.test(candidate) ? candidate : null;
}

export function serializeSessionCookie(
  value: string,
  maxAgeSeconds = SESSION_MAX_AGE_SECONDS,
): string {
  // Secure is always set — localhost is exempted by modern browsers, so
  // dev-over-http still works; preview/prod are https-only.
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

export async function handleLoginRequest(
  request: Request,
  deps: LoginDeps = {},
): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let body: LoginBody;
  try {
    body = (await request.json()) as LoginBody;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || username.length > MAX_CREDENTIAL_LEN) {
    return json({ error: 'Missing or invalid username' }, 400);
  }
  if (!password || password.length > MAX_CREDENTIAL_LEN) {
    return json({ error: 'Missing or invalid password' }, 400);
  }

  const fetchFn = deps.fetchImpl ?? fetch;
  const form = new URLSearchParams({
    acct: username,
    pw: password,
    goto: 'news',
  });

  let upstream: Response;
  try {
    upstream = await fetchFn(HN_LOGIN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': HN_USER_AGENT,
      },
      body: form.toString(),
      // HN redirects to /news on success; we don't want to follow because
      // the Set-Cookie header would otherwise be dropped on the redirect hop.
      redirect: 'manual',
    });
  } catch {
    return json({ error: 'Could not reach Hacker News' }, 502);
  }

  const cookieValue = extractHnSessionValue(upstream.headers);
  if (!cookieValue) {
    // HN returns 200 with a "Bad login." HTML page on wrong credentials
    // (no cookie set). Treat both shapes the same — but log the upstream
    // status so the Vercel function logs surface a weirder response
    // (e.g. 403 CAPTCHA, 429 rate-limit) as something other than a
    // generic "bad login" the user would be left puzzling over.
    console.warn(
      `[api/login] HN login did not set a user cookie — upstream status ${upstream.status}`,
    );
    return json({ error: 'Bad login' }, 401);
  }

  const parsedUsername = usernameFromHnCookieValue(cookieValue);
  if (!parsedUsername) {
    return json({ error: 'Could not parse Hacker News response' }, 502);
  }

  return json(
    { username: parsedUsername },
    200,
    { 'set-cookie': serializeSessionCookie(cookieValue) },
  );
}

export async function POST(request: Request): Promise<Response> {
  return handleLoginRequest(request);
}
