import { describe, expect, it } from 'vitest';
import {
  handleMeRequest,
  parseCookieHeader,
  usernameFromSessionValue,
} from './me';

function requestWithCookie(cookie: string | null): Request {
  const headers = new Headers();
  if (cookie !== null) headers.set('cookie', cookie);
  return new Request('https://newshacker.app/api/me', {
    method: 'GET',
    headers,
  });
}

describe('parseCookieHeader', () => {
  it('returns an empty map for null/undefined/empty input', () => {
    expect(parseCookieHeader(null)).toEqual({});
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader('')).toEqual({});
  });

  it('parses a single cookie', () => {
    expect(parseCookieHeader('hn_session=alice%26hash')).toEqual({
      hn_session: 'alice&hash',
    });
  });

  it('parses multiple cookies', () => {
    const cookies = parseCookieHeader('a=1; b=2; hn_session=alice%26hash');
    expect(cookies).toEqual({ a: '1', b: '2', hn_session: 'alice&hash' });
  });

  it('ignores cookies without a name or value-separator', () => {
    expect(parseCookieHeader('=value; noequals; a=1')).toEqual({ a: '1' });
  });
});

describe('usernameFromSessionValue', () => {
  it('extracts username from `alice&hash`', () => {
    expect(usernameFromSessionValue('alice&hash')).toBe('alice');
  });
  it('rejects bad values', () => {
    expect(usernameFromSessionValue('')).toBeNull();
    expect(usernameFromSessionValue(undefined)).toBeNull();
    expect(usernameFromSessionValue('a&x')).toBeNull(); // too short
  });
});

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
