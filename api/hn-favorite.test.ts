import { describe, expect, it, vi } from 'vitest';
import {
  extractAuthToken,
  handleHnFavoriteRequest,
} from './hn-favorite';

function postRequest(body: unknown, cookie: string | null): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (cookie !== null) headers.set('cookie', cookie);
  return new Request('https://newshacker.app/api/hn-favorite', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

// Realistic-ish item page with a favorite link. HN emits `&amp;`
// entities and renders the un-faved form (no `&un=t`) when the caller
// hasn't favorited yet.
function itemPageHtml(
  id: number,
  opts: { faved?: boolean; token?: string } = {},
): string {
  const token = opts.token ?? 'abc123xyz';
  const faveHref = opts.faved
    ? `fave?id=${id}&amp;un=t&amp;auth=${token}`
    : `fave?id=${id}&amp;auth=${token}`;
  const label = opts.faved ? 'un-favorite' : 'favorite';
  return `
<html><body>
<table>
  <tr class="athing" id="${id}"><td>…</td></tr>
  <tr><td class="subtext">
    123 points by user |
    <a href="${faveHref}">${label}</a> |
    <a href="hide?id=${id}&amp;auth=somehide">hide</a>
  </td></tr>
</table>
</body></html>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

describe('extractAuthToken', () => {
  it('pulls the token out of a favorite anchor', () => {
    const html = itemPageHtml(42, { token: 'tok_ABC' });
    expect(extractAuthToken(html, 42, 'favorite')).toBe('tok_ABC');
  });

  it('pulls the token from an unfavorite anchor (needs &un=t)', () => {
    const html = itemPageHtml(42, { faved: true, token: 'tok_XYZ' });
    expect(extractAuthToken(html, 42, 'unfavorite')).toBe('tok_XYZ');
  });

  it('does not match the wrong direction', () => {
    const favedHtml = itemPageHtml(42, { faved: true, token: 'X' });
    expect(extractAuthToken(favedHtml, 42, 'favorite')).toBeNull();
    const unfavedHtml = itemPageHtml(42, { faved: false, token: 'Y' });
    expect(extractAuthToken(unfavedHtml, 42, 'unfavorite')).toBeNull();
  });

  it('does not cross-match a different item id', () => {
    const html = itemPageHtml(999, { token: 'tok' });
    expect(extractAuthToken(html, 42, 'favorite')).toBeNull();
  });

  it('returns null when the anchor is missing', () => {
    expect(extractAuthToken('<html></html>', 42, 'favorite')).toBeNull();
  });
});

describe('handleHnFavoriteRequest auth', () => {
  it('returns 401 without the session cookie', async () => {
    const res = await handleHnFavoriteRequest(
      postRequest({ id: 1, action: 'favorite' }, null),
    );
    expect(res.status).toBe(401);
  });

  it('returns 405 on non-POST', async () => {
    const res = await handleHnFavoriteRequest(
      new Request('https://newshacker.app/api/hn-favorite', { method: 'GET' }),
    );
    expect(res.status).toBe(405);
  });

  it('returns 400 on invalid body', async () => {
    const res = await handleHnFavoriteRequest(
      postRequest({ id: 'nope', action: 'favorite' }, 'hn_session=alice%26hash'),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 on unknown action', async () => {
    const res = await handleHnFavoriteRequest(
      postRequest({ id: 1, action: 'flag' }, 'hn_session=alice%26hash'),
    );
    expect(res.status).toBe(400);
  });
});

describe('handleHnFavoriteRequest HN round-trip', () => {
  it('scrapes the token and issues the fave GET for favorite', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const headers = ((init as RequestInit).headers ?? {}) as Record<
        string,
        string
      >;
      calls.push({ url: String(url), headers });
      if (String(url).startsWith('https://news.ycombinator.com/item')) {
        return htmlResponse(itemPageHtml(42, { token: 'tokABC' }));
      }
      // fave endpoint
      return new Response(null, {
        status: 302,
        headers: { location: '/item?id=42' },
      });
    }) as unknown as typeof fetch;

    const res = await handleHnFavoriteRequest(
      postRequest({ id: 42, action: 'favorite' }, 'hn_session=alice%26hash'),
      { fetchImpl },
    );
    expect(res.status).toBe(204);

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://news.ycombinator.com/item?id=42');
    expect(calls[0].headers.cookie).toBe('user=alice&hash');
    expect(calls[1].url).toBe(
      'https://news.ycombinator.com/fave?id=42&auth=tokABC',
    );
    expect(calls[1].headers.cookie).toBe('user=alice&hash');
  });

  it('issues the &un=t variant for unfavorite', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url).startsWith('https://news.ycombinator.com/item')) {
        return htmlResponse(
          itemPageHtml(99, { faved: true, token: 'T' }),
        );
      }
      return new Response(null, {
        status: 302,
        headers: { location: '/item?id=99' },
      });
    }) as unknown as typeof fetch;

    const res = await handleHnFavoriteRequest(
      postRequest({ id: 99, action: 'unfavorite' }, 'hn_session=alice%26hash'),
      { fetchImpl },
    );
    expect(res.status).toBe(204);
    expect(calls[1]).toBe('https://news.ycombinator.com/fave?id=99&un=t&auth=T');
  });

  it('returns 502 when the item page has no fave link', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(htmlResponse('<html>no link</html>'));
    const res = await handleHnFavoriteRequest(
      postRequest({ id: 1, action: 'favorite' }, 'hn_session=alice%26hash'),
      { fetchImpl },
    );
    expect(res.status).toBe(502);
  });

  it('returns 401 when the item fetch is redirected to login', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: '/login?goto=item%3Fid%3D1' },
        }),
    ) as unknown as typeof fetch;
    const res = await handleHnFavoriteRequest(
      postRequest({ id: 1, action: 'favorite' }, 'hn_session=alice%26hash'),
      { fetchImpl },
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when the fave request is redirected to login', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).startsWith('https://news.ycombinator.com/item')) {
        return htmlResponse(itemPageHtml(5, { token: 'tok' }));
      }
      return new Response(null, {
        status: 302,
        headers: { location: '/login' },
      });
    }) as unknown as typeof fetch;
    const res = await handleHnFavoriteRequest(
      postRequest({ id: 5, action: 'favorite' }, 'hn_session=alice%26hash'),
      { fetchImpl },
    );
    expect(res.status).toBe(401);
  });

  it('returns 502 if either fetch throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const res = await handleHnFavoriteRequest(
      postRequest({ id: 1, action: 'favorite' }, 'hn_session=alice%26hash'),
      { fetchImpl },
    );
    expect(res.status).toBe(502);
  });
});
