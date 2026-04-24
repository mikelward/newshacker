// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { extractAuthToken, handleVoteRequest } from './vote';

function postRequest(body: unknown, cookie: string | null): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (cookie !== null) headers.set('cookie', cookie);
  return new Request('https://newshacker.app/api/vote', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

// Minimal item page with a vote link. HN emits the upvote form when
// the caller hasn't voted on the item yet (how=up) and the unvote
// form after an upvote (how=un).
function itemPageHtml(
  id: number,
  opts: {
    voted?: boolean;
    token?: string;
    // When true, emit a `how=down` anchor too — HN renders this
    // alongside the upvote arrow once the viewer has enough karma
    // to downvote that item. Off by default to mirror the baseline
    // (low-karma viewer) in the existing upvote tests.
    canDownvote?: boolean;
    downToken?: string;
  } = {},
): string {
  const token = opts.token ?? 'abc123xyz';
  const how = opts.voted ? 'un' : 'up';
  const goto = `item%3Fid%3D${id}`;
  const voteHref = `vote?id=${id}&amp;how=${how}&amp;auth=${token}&amp;goto=${goto}`;
  const label = opts.voted ? 'unvote' : 'upvote';
  const downAnchor = opts.canDownvote
    ? `<a id="down_${id}" href="vote?id=${id}&amp;how=down&amp;auth=${opts.downToken ?? 'dtok'}&amp;goto=${goto}"><div class="votearrow" title="downvote"></div></a>`
    : '';
  return `
<html><body>
<table>
  <tr class="athing" id="${id}">
    <td class="votelinks">
      <a id="up_${id}" href="${voteHref}">
        <div class="votearrow" title="${label}"></div>
      </a>
      ${downAnchor}
    </td>
    <td>a story</td>
  </tr>
  <tr><td class="subtext">
    123 points by user |
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
  it('pulls the token out of an upvote anchor', () => {
    const html = itemPageHtml(42, { token: 'tok_UP' });
    expect(extractAuthToken(html, 42, 'up')).toBe('tok_UP');
  });

  it('pulls the token out of an unvote anchor', () => {
    const html = itemPageHtml(42, { voted: true, token: 'tok_UN' });
    expect(extractAuthToken(html, 42, 'un')).toBe('tok_UN');
  });

  it('does not match the wrong direction', () => {
    // An upvote-form page has no `how=un` anchor and vice versa.
    const upHtml = itemPageHtml(42, { voted: false, token: 'X' });
    expect(extractAuthToken(upHtml, 42, 'un')).toBeNull();
    const unHtml = itemPageHtml(42, { voted: true, token: 'Y' });
    expect(extractAuthToken(unHtml, 42, 'up')).toBeNull();
  });

  it('does not cross-match a different item id', () => {
    const html = itemPageHtml(999, { token: 'tok' });
    expect(extractAuthToken(html, 42, 'up')).toBeNull();
  });

  it('returns null when the anchor is missing', () => {
    expect(extractAuthToken('<html>no vote link</html>', 42, 'up')).toBeNull();
  });

  it('handles absolute-URL hrefs', () => {
    const html =
      `<a href="https://news.ycombinator.com/vote?id=42&amp;how=up&amp;auth=tokABS">upvote</a>`;
    expect(extractAuthToken(html, 42, 'up')).toBe('tokABS');
  });

  it('picks the right anchor when both up and un shapes appear', () => {
    // HN doesn't normally emit both on the same item, but other items
    // on a listing page may present the opposite direction.
    const html =
      `<a href="vote?id=42&amp;how=up&amp;auth=tokUP">upvote</a>` +
      `<a href="vote?id=43&amp;how=un&amp;auth=tokUN">unvote</a>`;
    expect(extractAuthToken(html, 42, 'up')).toBe('tokUP');
    expect(extractAuthToken(html, 43, 'un')).toBe('tokUN');
    expect(extractAuthToken(html, 42, 'un')).toBeNull();
  });

  it('tolerates single-quoted hrefs', () => {
    const html = `<a href='vote?id=7&amp;how=up&amp;auth=tokSQ'>upvote</a>`;
    expect(extractAuthToken(html, 7, 'up')).toBe('tokSQ');
  });
});

describe('handleVoteRequest auth & shape', () => {
  it('returns 401 without the session cookie', async () => {
    const res = await handleVoteRequest(
      postRequest({ id: 1, how: 'up' }, null),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when the session value has no valid username prefix', async () => {
    const res = await handleVoteRequest(
      postRequest({ id: 1, how: 'up' }, 'hn_session=%26hash-only'),
    );
    expect(res.status).toBe(401);
  });

  it('returns 405 on non-POST', async () => {
    const res = await handleVoteRequest(
      new Request('https://newshacker.app/api/vote', { method: 'GET' }),
    );
    expect(res.status).toBe(405);
  });

  it('returns 400 on invalid id', async () => {
    const res = await handleVoteRequest(
      postRequest({ id: 'nope', how: 'up' }, 'hn_session=alice%26hash'),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 on unknown how', async () => {
    const res = await handleVoteRequest(
      postRequest({ id: 1, how: 'sideways' }, 'hn_session=alice%26hash'),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 on a non-JSON body', async () => {
    const req = new Request('https://newshacker.app/api/vote', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'hn_session=alice%26hash',
      },
      body: 'not json',
    });
    const res = await handleVoteRequest(req);
    expect(res.status).toBe(400);
  });
});

describe('handleVoteRequest HN round-trip', () => {
  it('scrapes the token and issues the vote GET for upvote', async () => {
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
      // vote endpoint
      return new Response(null, {
        status: 302,
        headers: { location: 'news' },
      });
    }) as unknown as typeof fetch;

    const res = await handleVoteRequest(
      postRequest({ id: 42, how: 'up' }, 'hn_session=alice%26hash'),
      { fetchImpl },
    );
    expect(res.status).toBe(204);

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://news.ycombinator.com/item?id=42');
    expect(calls[0].headers.cookie).toBe('user=alice&hash');
    expect(calls[1].url).toBe(
      'https://news.ycombinator.com/vote?id=42&how=up&auth=tokABC&goto=news',
    );
    expect(calls[1].headers.cookie).toBe('user=alice&hash');
  });

  it('scrapes the how=down anchor and issues the vote GET for downvote', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url).startsWith('https://news.ycombinator.com/item')) {
        return htmlResponse(
          itemPageHtml(7, {
            token: 'tokUP',
            canDownvote: true,
            downToken: 'tokDOWN',
          }),
        );
      }
      return new Response(null, {
        status: 302,
        headers: { location: 'news' },
      });
    }) as unknown as typeof fetch;

    const res = await handleVoteRequest(
      postRequest({ id: 7, how: 'down' }, 'hn_session=alice%26hash'),
      { fetchImpl },
    );
    expect(res.status).toBe(204);
    expect(calls[1]).toBe(
      'https://news.ycombinator.com/vote?id=7&how=down&auth=tokDOWN&goto=news',
    );
  });

  it('returns 502 on a downvote when HN omits the how=down anchor (karma-gated)', async () => {
    // Matches the low-karma / ineligible-item case: HN renders the
    // upvote anchor but no downvote one. The handler can't
    // distinguish "low karma" from "HTML changed" at this layer —
    // both surface as 502 and the client toasts a generic error.
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).startsWith('https://news.ycombinator.com/item')) {
        return htmlResponse(
          itemPageHtml(8, { token: 'tok', canDownvote: false }),
        );
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const res = await handleVoteRequest(
      postRequest({ id: 8, how: 'down' }, 'hn_session=alice%26hash'),
      { fetchImpl },
    );
    expect(res.status).toBe(502);
  });

  it('issues the how=un variant for unvote', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url).startsWith('https://news.ycombinator.com/item')) {
        return htmlResponse(itemPageHtml(99, { voted: true, token: 'T' }));
      }
      return new Response(null, {
        status: 302,
        headers: { location: 'news' },
      });
    }) as unknown as typeof fetch;

    const res = await handleVoteRequest(
      postRequest({ id: 99, how: 'un' }, 'hn_session=alice%26hash'),
      { fetchImpl },
    );
    expect(res.status).toBe(204);
    expect(calls[1]).toBe(
      'https://news.ycombinator.com/vote?id=99&how=un&auth=T&goto=news',
    );
  });

  it('returns 502 when the item page has no vote link', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(htmlResponse('<html>no link</html>'));
    const res = await handleVoteRequest(
      postRequest({ id: 1, how: 'up' }, 'hn_session=alice%26hash'),
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
    const res = await handleVoteRequest(
      postRequest({ id: 1, how: 'up' }, 'hn_session=alice%26hash'),
      { fetchImpl },
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when the vote request is redirected to login', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).startsWith('https://news.ycombinator.com/item')) {
        return htmlResponse(itemPageHtml(5, { token: 'tok' }));
      }
      return new Response(null, {
        status: 302,
        headers: { location: '/login' },
      });
    }) as unknown as typeof fetch;
    const res = await handleVoteRequest(
      postRequest({ id: 5, how: 'up' }, 'hn_session=alice%26hash'),
      { fetchImpl },
    );
    expect(res.status).toBe(401);
  });

  it('returns 502 if the item fetch throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const res = await handleVoteRequest(
      postRequest({ id: 1, how: 'up' }, 'hn_session=alice%26hash'),
      { fetchImpl },
    );
    expect(res.status).toBe(502);
  });

  it('returns 502 if the vote fetch throws', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (url) => {
      call += 1;
      if (call === 1) {
        return htmlResponse(itemPageHtml(1, { token: 'tok' }));
      }
      void url;
      throw new Error('network down mid-vote');
    }) as unknown as typeof fetch;
    const res = await handleVoteRequest(
      postRequest({ id: 1, how: 'up' }, 'hn_session=alice%26hash'),
      { fetchImpl },
    );
    expect(res.status).toBe(502);
  });

  it('returns 502 when HN returns a non-redirect non-2xx on the vote call', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).startsWith('https://news.ycombinator.com/item')) {
        return htmlResponse(itemPageHtml(1, { token: 'tok' }));
      }
      return new Response('rate limited', { status: 429 });
    }) as unknown as typeof fetch;
    const res = await handleVoteRequest(
      postRequest({ id: 1, how: 'up' }, 'hn_session=alice%26hash'),
      { fetchImpl },
    );
    expect(res.status).toBe(502);
  });
});
