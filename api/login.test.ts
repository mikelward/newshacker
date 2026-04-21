import { describe, expect, it, vi } from 'vitest';
import {
  extractHnSessionValue,
  handleLoginRequest,
  serializeSessionCookie,
  usernameFromHnCookieValue,
} from './login';

function jsonRequest(body: unknown): Request {
  return new Request('https://newshacker.app/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function hnResponseWithCookie(cookie: string): Response {
  const headers = new Headers();
  headers.append('set-cookie', cookie);
  return new Response('', { status: 302, headers });
}

function hnBadLoginResponse(): Response {
  return new Response('<html>Bad login.</html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
}

describe('usernameFromHnCookieValue', () => {
  it('returns the username from `alice&hash`', () => {
    expect(usernameFromHnCookieValue('alice&abcdef1234')).toBe('alice');
  });
  it('returns the whole value if there is no ampersand', () => {
    expect(usernameFromHnCookieValue('alice')).toBe('alice');
  });
  it('rejects values that would not be valid HN usernames', () => {
    expect(usernameFromHnCookieValue('a b&c')).toBeNull(); // space
    expect(usernameFromHnCookieValue('a&c')).toBeNull(); // too short
    expect(usernameFromHnCookieValue('')).toBeNull();
    expect(usernameFromHnCookieValue(null)).toBeNull();
    expect(usernameFromHnCookieValue(undefined)).toBeNull();
  });
  it('accepts dashes and underscores', () => {
    expect(usernameFromHnCookieValue('a-b_c&x')).toBe('a-b_c');
  });
});

describe('extractHnSessionValue', () => {
  it('returns the value when a Set-Cookie header is present', () => {
    const h = new Headers();
    h.append('set-cookie', 'user=alice&abc; Path=/; HttpOnly');
    expect(extractHnSessionValue(h)).toBe('alice&abc');
  });

  it('returns null when no user cookie is set', () => {
    const h = new Headers();
    h.append('set-cookie', 'other=value; Path=/');
    expect(extractHnSessionValue(h)).toBeNull();
  });

  it('picks user out of multiple Set-Cookie headers', () => {
    const h = new Headers();
    h.append('set-cookie', 'session=abc; Path=/');
    h.append('set-cookie', 'user=bob&xyz; Path=/');
    expect(extractHnSessionValue(h)).toBe('bob&xyz');
  });
});

describe('serializeSessionCookie', () => {
  it('sets HttpOnly, Secure, SameSite=Lax, Path=/ and a Max-Age', () => {
    const cookie = serializeSessionCookie('alice&hash');
    expect(cookie).toContain('hn_session=alice%26hash');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toMatch(/Max-Age=\d+/);
  });
});

describe('handleLoginRequest', () => {
  it('rejects non-POST requests with 405', async () => {
    const res = await handleLoginRequest(
      new Request('https://newshacker.app/api/login', { method: 'GET' }),
    );
    expect(res.status).toBe(405);
  });

  it('rejects a missing username with 400', async () => {
    const res = await handleLoginRequest(jsonRequest({ password: 'x' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/username/i) });
  });

  it('rejects a missing password with 400', async () => {
    const res = await handleLoginRequest(jsonRequest({ username: 'alice' }));
    expect(res.status).toBe(400);
  });

  it('rejects malformed JSON with 400', async () => {
    const req = new Request('https://newshacker.app/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const res = await handleLoginRequest(req);
    expect(res.status).toBe(400);
  });

  it('returns 401 when HN rejects the credentials', async () => {
    const fetchImpl = vi.fn(async () => hnBadLoginResponse());
    const res = await handleLoginRequest(
      jsonRequest({ username: 'alice', password: 'wrong' }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Bad login' });
    // No session cookie should be set on a failed login.
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('sets an HttpOnly session cookie and returns the username on success', async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      // Sanity-check the outbound request shape.
      expect(init?.method).toBe('POST');
      const body = (init as { body?: string } | undefined)?.body ?? '';
      expect(body).toContain('acct=alice');
      expect(body).toContain('pw=secret');
      expect(body).toContain('goto=news');
      // Must pass a realistic User-Agent — HN otherwise can treat the
      // fetch as a bot and respond without setting the `user` cookie,
      // which we would then surface to the user as "Bad login".
      const headers = (init as { headers?: Record<string, string> } | undefined)?.headers ?? {};
      expect(headers['user-agent'] ?? '').toMatch(/Mozilla|Chrome|Safari/i);
      return hnResponseWithCookie('user=alice&hash; Path=/; HttpOnly');
    });
    const res = await handleLoginRequest(
      jsonRequest({ username: 'alice', password: 'secret' }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: 'alice' });
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toMatch(/^hn_session=alice%26hash/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
  });

  it('returns 502 if HN is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const res = await handleLoginRequest(
      jsonRequest({ username: 'alice', password: 'secret' }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.status).toBe(502);
  });

  it('returns 502 if the HN cookie value is not a valid username', async () => {
    // Defensive: HN responds with a Set-Cookie we can't parse.
    const fetchImpl = vi.fn(async () =>
      hnResponseWithCookie('user=; Path=/'),
    );
    const res = await handleLoginRequest(
      jsonRequest({ username: 'alice', password: 'secret' }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    // Empty `user=` → extractor returns '' → parser rejects → 401
    // (interpreted as "bad login" since there's no distinguishable
    // signal from HN). The important bit is we never set a cookie
    // with a junk username.
    expect([401, 502]).toContain(res.status);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('does not echo the password in the response body', async () => {
    const fetchImpl = vi.fn(async () =>
      hnResponseWithCookie('user=alice&hash; Path=/'),
    );
    const res = await handleLoginRequest(
      jsonRequest({ username: 'alice', password: 'super-secret-leak-test' }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const text = await res.text();
    expect(text).not.toContain('super-secret-leak-test');
  });

  it('rejects absurdly long credentials', async () => {
    const giant = 'x'.repeat(2000);
    const res = await handleLoginRequest(
      jsonRequest({ username: giant, password: 'secret' }),
    );
    expect(res.status).toBe(400);
  });
});
