// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  handleHnFavoritesListRequest,
  parseFavoritesPage,
} from './hn-favorites-list';

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

describe('parseFavoritesPage', () => {
  it('returns empty result for empty / garbage input', () => {
    expect(parseFavoritesPage('')).toEqual({ ids: [], morePath: null });
    expect(parseFavoritesPage('not html at all')).toEqual({
      ids: [],
      morePath: null,
    });
    expect(
      parseFavoritesPage('<html><body>no favorites yet</body></html>'),
    ).toEqual({ ids: [], morePath: null });
  });

  it('extracts story IDs in document order', () => {
    const html = favoritesHtml({ ids: [111, 222, 333], morePath: null });
    expect(parseFavoritesPage(html)).toEqual({
      ids: [111, 222, 333],
      morePath: null,
    });
  });

  it('captures the morelink href and decodes &amp;', () => {
    const html = favoritesHtml({
      ids: [42],
      morePath: 'favorites?id=alice&amp;p=2',
    });
    expect(parseFavoritesPage(html)).toEqual({
      ids: [42],
      morePath: 'favorites?id=alice&p=2',
    });
  });

  it('ignores comment-favorite rows (class="athing comtr")', () => {
    const html =
      `<tr class="athing" id="1"></tr>` +
      `<tr class="athing comtr" id="9990"></tr>` +
      `<tr class="athing" id="2"></tr>`;
    expect(parseFavoritesPage(html).ids).toEqual([1, 2]);
  });

  it('handles attribute order with id before class', () => {
    const html =
      `<tr id="555" class="athing"><td>a</td></tr>` +
      `<tr class="athing" id="666"><td>b</td></tr>`;
    expect(parseFavoritesPage(html).ids).toEqual([555, 666]);
  });

  it('handles single-quoted attributes', () => {
    const html =
      `<tr class='athing' id='777'><td>a</td></tr>` +
      `<a class='morelink' href='favorites?id=bob&amp;p=3' rel='next'>More</a>`;
    expect(parseFavoritesPage(html)).toEqual({
      ids: [777],
      morePath: 'favorites?id=bob&p=3',
    });
  });

  it('deduplicates repeat IDs', () => {
    const html =
      `<tr class="athing" id="10"></tr>` +
      `<tr class="athing" id="20"></tr>` +
      `<tr class="athing" id="10"></tr>`;
    expect(parseFavoritesPage(html).ids).toEqual([10, 20]);
  });

  it('rejects non-numeric, zero, or negative IDs', () => {
    const html =
      `<tr class="athing" id="abc"></tr>` +
      `<tr class="athing" id="0"></tr>` +
      `<tr class="athing" id="-5"></tr>` +
      `<tr class="athing" id="123"></tr>`;
    expect(parseFavoritesPage(html).ids).toEqual([123]);
  });

  it('tolerates extra class tokens on morelink', () => {
    const html = `<a class="foo morelink bar" href="favorites?id=u&amp;p=2">More</a>`;
    expect(parseFavoritesPage(html).morePath).toBe('favorites?id=u&p=2');
  });
});

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
