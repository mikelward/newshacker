// GET /api/me — returns `{ username }` when the caller has a valid
// `hn_session` cookie, 401 otherwise.
//
// We do NOT round-trip to news.ycombinator.com to re-validate the
// cookie; the cookie's presence is treated as proof of intent, and
// any downstream HN request that actually uses the cookie will fail
// with HN's own auth error if the session has since been revoked.
// This keeps the boot-time auth check free of an external dependency.

import { json } from '../lib/api/http';
import {
  SESSION_COOKIE_NAME,
  parseCookieHeader,
  usernameFromSessionValue,
} from '../lib/api/session';

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
