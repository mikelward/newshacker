// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { handleLogoutRequest } from './logout';

describe('handleLogoutRequest', () => {
  it('rejects GET with 405', async () => {
    const res = await handleLogoutRequest(
      new Request('https://newshacker.app/api/logout', { method: 'GET' }),
    );
    expect(res.status).toBe(405);
  });

  it('returns 200 with a cleared session cookie on POST', async () => {
    const res = await handleLogoutRequest(
      new Request('https://newshacker.app/api/logout', { method: 'POST' }),
    );
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toMatch(/^hn_session=;/);
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
  });

  it('returns a no-store cache-control header', async () => {
    const res = await handleLogoutRequest(
      new Request('https://newshacker.app/api/logout', { method: 'POST' }),
    );
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
  });
});
