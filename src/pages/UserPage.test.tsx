import { afterEach, describe, it, expect, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserPage } from './UserPage';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock } from '../test/mockFetch';
import type { HNItem } from '../lib/hn';

function renderAt(route: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/user/:id" element={<UserPage />} />
    </Routes>,
    { route },
  );
}

describe('<UserPage>', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows karma and a sanitized about section', async () => {
    installHNFetchMock({
      users: {
        alice: {
          id: 'alice',
          karma: 1234,
          created: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 365,
          about: 'Hi <script>evil()</script><b>bold</b>',
        },
      },
    });
    renderAt('/user/alice');
    await waitFor(() => {
      expect(screen.getByText('alice')).toBeInTheDocument();
    });
    expect(screen.getByText('1,234')).toBeInTheDocument();
    // Sanitized: no script
    expect(document.body.innerHTML).not.toContain('<script>');
    expect(document.body.innerHTML).toContain('<b>bold</b>');
  });

  it('shows empty state when the user is not found', async () => {
    installHNFetchMock({ users: { missing: null } });
    renderAt('/user/missing');
    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toHaveTextContent(/not found/i);
    });
  });

  it('groups recent comments by the article they were posted on, with the story title as a heading link', async () => {
    const now = Math.floor(Date.now() / 1000);
    installHNFetchMock({
      users: {
        alice: {
          id: 'alice',
          karma: 100,
          created: now - 60 * 60 * 24 * 30,
          submitted: [101, 102, 103, 104],
        },
      },
      items: {
        // Story from the user's submitted list itself is not rendered
        // as a recent-comments entry; it can still resolve as the
        // parent story for other comments though.
        101: { id: 101, type: 'story', title: 'Alice posted story', by: 'alice', time: now - 60 },
        102: {
          id: 102,
          type: 'comment',
          by: 'alice',
          time: now - 120,
          text: 'First comment body',
          parent: 999,
        },
        // Dead/deleted comments are skipped before they can reach the walk.
        103: { id: 103, type: 'comment', by: 'alice', time: now - 180, text: 'gone', dead: true },
        104: {
          id: 104,
          type: 'comment',
          by: 'alice',
          time: now - 240,
          text: 'Second comment body',
          parent: 999,
        },
        // Shared root story — both comments above live under it, so
        // they should render together under one "The shared thread"
        // heading.
        999: { id: 999, type: 'story', title: 'The shared thread', by: 'someone', time: now - 300 },
      },
    });
    renderAt('/user/alice');

    const section = await screen.findByRole('region', { name: /recent comments/i });
    // One group heading pointing at the shared root story.
    const groupHeading = await within(section).findByRole('link', {
      name: 'The shared thread',
    });
    expect(groupHeading).toHaveAttribute('href', '/item/999');

    // Both comment snippets live under that one heading; the order
    // of the inline links reflects `submitted` (102 before 104).
    await within(section).findByText(/First comment body/);
    expect(within(section).getByText(/Second comment body/)).toBeInTheDocument();
    const itemLinks = within(section)
      .getAllByRole('link')
      .filter((a) => a.getAttribute('href')?.startsWith('/item/'))
      .map((a) => a.getAttribute('href'));
    // /item/999 (heading) + /item/102 + /item/104 (snippets) — the
    // user's own submitted story (/item/101) is filtered out of the
    // comment list before the walk.
    expect(itemLinks).toEqual(['/item/999', '/item/102', '/item/104']);
    expect(within(section).queryByText(/^gone$/)).not.toBeInTheDocument();

    const hnLink = within(section).getByRole('link', {
      name: /view all comments on hacker news/i,
    });
    expect(hnLink).toHaveAttribute(
      'href',
      'https://news.ycombinator.com/threads?id=alice',
    );
    expect(hnLink).toHaveAttribute('target', '_blank');
  });

  it('renders one group heading per root story when the user has commented on multiple articles', async () => {
    const now = Math.floor(Date.now() / 1000);
    installHNFetchMock({
      users: {
        carol: {
          id: 'carol',
          karma: 50,
          created: now - 60,
          submitted: [402, 404, 406],
        },
      },
      items: {
        // Each comment has a different root story; walking up through
        // an intermediate parent comment for 406 exercises the
        // multi-level walk.
        402: { id: 402, type: 'comment', by: 'carol', time: now - 1, text: 'on A', parent: 401 },
        401: { id: 401, type: 'story', title: 'Article A', time: now - 100 },
        404: { id: 404, type: 'comment', by: 'carol', time: now - 2, text: 'on B', parent: 403 },
        403: { id: 403, type: 'story', title: 'Article B', time: now - 100 },
        406: { id: 406, type: 'comment', by: 'carol', time: now - 3, text: 'on C deep', parent: 405 },
        405: { id: 405, type: 'comment', by: 'x', text: 'parent', parent: 400 },
        400: { id: 400, type: 'story', title: 'Article C', time: now - 100 },
      },
    });
    renderAt('/user/carol');

    const section = await screen.findByRole('region', { name: /recent comments/i });
    await within(section).findByRole('link', { name: 'Article A' });
    const headings = within(section)
      .getAllByRole('link')
      .filter((a) => /^Article [ABC]$/.test(a.textContent ?? ''))
      .map((a) => a.textContent);
    // Groups are ordered by the first comment that resolves to each
    // story — and `submitted` is 402, 404, 406 → A, B, C.
    expect(headings).toEqual(['Article A', 'Article B', 'Article C']);
  });

  it('still renders the article heading when /api/items thins responses (fields=full required for parent)', async () => {
    // Regression: the /api/items proxy strips `parent` and `kids` from
    // its response unless the caller passes ?fields=full. If UserPage
    // forgets that flag, every comment's `parent` arrives as undefined,
    // the parent-walk resolves every comment to a null root, and the
    // article heading collapses into an unheaded fallback group.
    const now = Math.floor(Date.now() / 1000);
    const items: Record<number, HNItem> = {
      702: { id: 702, type: 'comment', by: 'frank', time: now - 1, text: 'on D', parent: 701 },
      701: { id: 701, type: 'story', title: 'Article D', time: now - 100 },
    };
    function thinForFeed<T extends HNItem>(it: T): T {
      // Mirrors api/items.ts thinForFeed: drops `parent` and `kids`.
      const { id, type, by, time, title, url, text, score, descendants, dead, deleted } = it;
      return { id, type, by, time, title, url, text, score, descendants, dead, deleted } as T;
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/items')) {
          const parsed = new URL(url, 'http://localhost');
          const ids = (parsed.searchParams.get('ids') ?? '')
            .split(',')
            .map((s) => Number(s.trim()))
            .filter(Number.isFinite);
          const isFull = parsed.searchParams.get('fields') === 'full';
          const body = ids.map((cid) => {
            const it = items[cid];
            if (!it) return null;
            return isFull ? it : thinForFeed(it);
          });
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/v0/user/frank.json')) {
          return new Response(
            JSON.stringify({
              id: 'frank',
              karma: 1,
              created: now - 60,
              submitted: [702],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('not found', { status: 404 });
      }),
    );
    renderAt('/user/frank');

    const section = await screen.findByRole('region', { name: /recent comments/i });
    const heading = await within(section).findByRole('link', {
      name: 'Article D',
    });
    expect(heading).toHaveAttribute('href', '/item/701');
  });

  it('still renders the comments (unheaded) when the parent walk fetch errors out', async () => {
    // Regression: previously a 500 from /api/items on the walk left
    // `rootByCommentId` undefined, `groups` empty, and the section
    // flashed "No recent comments." even though the comments
    // themselves had loaded. Degrade gracefully — the comments
    // render in a single unheaded fallback group.
    const now = Math.floor(Date.now() / 1000);
    let itemsCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/items')) {
          itemsCalls++;
          // First call (the recent-items batch) succeeds; subsequent
          // calls (the walk's per-level parent fetches) all 500 so the
          // walk's useQuery resolves to error.
          if (itemsCalls === 1) {
            return new Response(
              JSON.stringify([
                {
                  id: 802,
                  type: 'comment',
                  by: 'gina',
                  time: now - 1,
                  text: 'walk-broken comment',
                  parent: 801,
                },
              ]),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          return new Response('boom', { status: 500 });
        }
        if (url.endsWith('/v0/user/gina.json')) {
          return new Response(
            JSON.stringify({
              id: 'gina',
              karma: 1,
              created: now - 60,
              submitted: [802],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('not found', { status: 404 });
      }),
    );
    renderAt('/user/gina');

    const section = await screen.findByRole('region', { name: /recent comments/i });
    await within(section).findByText(/walk-broken comment/);
    // The "No recent comments." status must NOT show up — that was the
    // misleading state on the previous behavior.
    expect(within(section).queryByText(/no recent comments/i)).toBeNull();
    // No story heading (the walk errored), only the snippet's own link.
    const itemLinks = within(section)
      .getAllByRole('link')
      .filter((a) => a.getAttribute('href')?.startsWith('/item/'))
      .map((a) => a.getAttribute('href'));
    expect(itemLinks).toEqual(['/item/802']);
  });

  it('renders comments without a heading when the parent walk cannot reach a root story', async () => {
    const now = Math.floor(Date.now() / 1000);
    installHNFetchMock({
      users: {
        dana: {
          id: 'dana',
          karma: 1,
          created: now - 60,
          submitted: [502],
        },
      },
      items: {
        // Comment's parent (501) is missing from the fixture, so the
        // walk returns null. The comment still renders, just in an
        // unheaded fallback group.
        502: { id: 502, type: 'comment', by: 'dana', time: now - 1, text: 'orphan comment', parent: 501 },
      },
    });
    renderAt('/user/dana');

    const section = await screen.findByRole('region', { name: /recent comments/i });
    await within(section).findByText(/orphan comment/);
    // No group-title link was produced (we'd see an /item/ link that's
    // not the snippet's own /item/502).
    const itemLinks = within(section)
      .getAllByRole('link')
      .filter((a) => a.getAttribute('href')?.startsWith('/item/'))
      .map((a) => a.getAttribute('href'));
    expect(itemLinks).toEqual(['/item/502']);
  });

  it('omits the recent-comments section when the user has no submissions', async () => {
    installHNFetchMock({
      users: {
        quiet: {
          id: 'quiet',
          karma: 1,
          created: Math.floor(Date.now() / 1000),
        },
      },
    });
    renderAt('/user/quiet');
    await waitFor(() => {
      expect(screen.getByText('quiet')).toBeInTheDocument();
    });
    expect(screen.queryByRole('region', { name: /recent comments/i })).toBeNull();
    expect(
      screen.queryByRole('link', { name: /view all comments on hacker news/i }),
    ).toBeNull();
  });

  it('shows the HN threads link even when no comments are returned', async () => {
    const now = Math.floor(Date.now() / 1000);
    installHNFetchMock({
      users: {
        storyteller: {
          id: 'storyteller',
          karma: 5,
          created: now - 60,
          submitted: [201],
        },
      },
      items: {
        201: { id: 201, type: 'story', title: 'Only stories', by: 'storyteller', time: now },
      },
    });
    renderAt('/user/storyteller');

    const section = await screen.findByRole('region', { name: /recent comments/i });
    await within(section).findByText(/no recent comments/i);
    expect(
      within(section).getByRole('link', { name: /view all comments on hacker news/i }),
    ).toHaveAttribute(
      'href',
      'https://news.ycombinator.com/threads?id=storyteller',
    );
  });

  it('shows an error + retry inside the section when the recent-items fetch fails, and keeps the HN threads link reachable', async () => {
    const now = Math.floor(Date.now() / 1000);
    let attempt = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/items')) {
          attempt++;
          if (attempt === 1) {
            return new Response('boom', { status: 500 });
          }
          return new Response(
            JSON.stringify([
              {
                id: 301,
                type: 'comment',
                by: 'erin',
                time: now - 60,
                text: 'recovered comment',
                parent: 1,
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.endsWith('/v0/user/erin.json')) {
          return new Response(
            JSON.stringify({
              id: 'erin',
              karma: 9,
              created: now - 60 * 60,
              submitted: [301],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('not found', { status: 404 });
      }),
    );
    renderAt('/user/erin');

    const section = await screen.findByRole('region', { name: /recent comments/i });
    await within(section).findByTestId('error-state');
    expect(
      within(section).getByText(/could not load recent comments/i),
    ).toBeInTheDocument();
    // The HN threads link is still reachable while the inline list errors.
    expect(
      within(section).getByRole('link', {
        name: /view all comments on hacker news/i,
      }),
    ).toHaveAttribute('href', 'https://news.ycombinator.com/threads?id=erin');

    await userEvent.click(
      within(section).getByRole('button', { name: /retry/i }),
    );
    await within(section).findByText(/recovered comment/i);
  });

  it('shows error state with working retry', async () => {
    let attempt = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        attempt++;
        if (attempt === 1) return new Response('no', { status: 500 });
        return new Response(
          JSON.stringify({
            id: 'bob',
            karma: 10,
            created: Math.floor(Date.now() / 1000),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    renderAt('/user/bob');

    await waitFor(() => {
      expect(screen.getByTestId('error-state')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => {
      expect(screen.getByText('bob')).toBeInTheDocument();
    });
  });
});
