import { describe, expect, it, vi } from 'vitest';
import { handleHnFavoritesListRequest } from './hn-favorites-list';

function requestWithCookie(cookie: string | null): Request {
  const headers = new Headers();
  if (cookie !== null) headers.set('cookie', cookie);
  return new Request('https://newshacker.app/api/hn-favorites-list', {
    method: 'GET',
    headers,
  });
}

// Build a minimal favorites-page response. `morePath` links to the
// next page; set to null on the last page.
function favoritesHtml(opts: {
  ids: number[];
  morePath: string | null;
}): string {
  const storyRows = opts.ids
    .map(
      (id) =>
        `<tr class="athing" id="${id}"><td>story ${id}</td></tr>` +
        `<tr><td class="subtext">subtext</td></tr>`,
    )
    .join('\n');
  const more =
    opts.morePath === null
      ? ''
      : `<a class="morelink" href="${opts.morePath}" rel="next">More</a>`;
  return `<html><body><table>${storyRows}${more}</table></body></html>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

describe('handleHnFavoritesListRequest', () => {
  it('returns 401 when the session cookie is missing', async () => {
    const res = await handleHnFavoritesListRequest(requestWithCookie(null));
    expect(res.status).toBe(401);
  });

  it('returns 401 when the session cookie value is malformed', async () => {
    const res = await handleHnFavoritesListRequest(
      requestWithCookie('hn_session=a'),
    );
    expect(res.status).toBe(401);
  });

  it('rejects non-GET methods with 405', async () => {
    const headers = new Headers({ cookie: 'hn_session=alice%26hash' });
    const res = await handleHnFavoritesListRequest(
      new Request('https://newshacker.app/api/hn-favorites-list', {
        method: 'POST',
        headers,
      }),
    );
    expect(res.status).toBe(405);
  });

  it('fetches the user-scoped URL with the HN cookie and returns the scraped IDs', async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe('https://news.ycombinator.com/favorites?id=alice');
      expect((init as RequestInit).method).toBe('GET');
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.cookie).toBe('user=alice&hash');
      expect(headers['user-agent']).toMatch(/Mozilla/);
      return htmlResponse(favoritesHtml({ ids: [10, 20, 30], morePath: null }));
    }) as unknown as typeof fetch;

    const res = await handleHnFavoritesListRequest(
      requestWithCookie('hn_session=alice%26hash'),
      { fetchImpl },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ids: [10, 20, 30], truncated: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('follows the morelink across pages and dedupes', async () => {
    const pages: Record<string, string> = {
      'https://news.ycombinator.com/favorites?id=alice': favoritesHtml({
        ids: [1, 2, 3],
        morePath: 'favorites?id=alice&p=2',
      }),
      'https://news.ycombinator.com/favorites?id=alice&p=2': favoritesHtml({
        ids: [3, 4, 5],
        morePath: 'favorites?id=alice&p=3',
      }),
      'https://news.ycombinator.com/favorites?id=alice&p=3': favoritesHtml({
        ids: [6],
        morePath: null,
      }),
    };
    const fetchImpl = vi.fn(async (url) => {
      const html = pages[url as string];
      if (!html) throw new Error(`unexpected url: ${url}`);
      return htmlResponse(html);
    }) as unknown as typeof fetch;

    const res = await handleHnFavoritesListRequest(
      requestWithCookie('hn_session=alice%26hash'),
      { fetchImpl },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ids: [1, 2, 3, 4, 5, 6],
      truncated: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('truncates when the page cap is hit before HN says stop', async () => {
    const fetchImpl = vi.fn(async (url) => {
      // Every page has a More link, so without the cap we would loop
      // forever. Assert the handler stops at maxPages.
      const pageMatch = /p=(\d+)/.exec(url as string);
      const page = pageMatch ? Number(pageMatch[1]) : 1;
      return htmlResponse(
        favoritesHtml({
          ids: [page * 10],
          morePath: `favorites?id=alice&p=${page + 1}`,
        }),
      );
    }) as unknown as typeof fetch;

    const res = await handleHnFavoritesListRequest(
      requestWithCookie('hn_session=alice%26hash'),
      { fetchImpl, maxPages: 3 },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ids: number[]; truncated: boolean };
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(body.truncated).toBe(true);
    expect(body.ids).toHaveLength(3);
  });

  it('returns 401 if HN redirects (session expired upstream)', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(null, { status: 302, headers: { location: '/login' } });
    }) as unknown as typeof fetch;
    const res = await handleHnFavoritesListRequest(
      requestWithCookie('hn_session=alice%26hash'),
      { fetchImpl },
    );
    expect(res.status).toBe(401);
  });

  it('returns 502 if HN returns a 5xx', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('oops', 503)) as unknown as typeof fetch;
    const res = await handleHnFavoritesListRequest(
      requestWithCookie('hn_session=alice%26hash'),
      { fetchImpl },
    );
    expect(res.status).toBe(502);
  });

  it('returns 502 if fetch itself throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const res = await handleHnFavoritesListRequest(
      requestWithCookie('hn_session=alice%26hash'),
      { fetchImpl },
    );
    expect(res.status).toBe(502);
  });
});
