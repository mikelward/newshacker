// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { handleMeRequest } from './me';

// Unit tests for `parseCookieHeader` and `usernameFromSessionValue` now
// live next to the shared implementation in `lib/api/session.test.ts`.
// This file covers the request-handler behavior on top of them.

function requestWithCookie(cookie: string | null): Request {
  const headers = new Headers();
  if (cookie !== null) headers.set('cookie', cookie);
  return new Request('https://newshacker.app/api/me', {
    method: 'GET',
    headers,
  });
}

describe('handleMeRequest', () => {
  it('returns 401 when no cookie is set', async () => {
    const res = await handleMeRequest(requestWithCookie(null));
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
  });

  it('returns 401 when the session cookie is absent among other cookies', async () => {
    const res = await handleMeRequest(requestWithCookie('foo=bar; baz=qux'));
    expect(res.status).toBe(401);
  });

  it('returns the username when the session cookie is present', async () => {
    const res = await handleMeRequest(
      requestWithCookie('hn_session=alice%26hash'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: 'alice' });
  });

  it('returns 401 if the session cookie value is malformed', async () => {
    const res = await handleMeRequest(requestWithCookie('hn_session=a'));
    expect(res.status).toBe(401);
  });

  it('rejects non-GET methods with 405', async () => {
    const res = await handleMeRequest(
      new Request('https://newshacker.app/api/me', { method: 'POST' }),
    );
    expect(res.status).toBe(405);
  });
});
