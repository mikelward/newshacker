import { afterEach, describe, it, expect, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserPage } from './UserPage';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock } from '../test/mockFetch';

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

  it('shows recent comments with a link to the thread and an HN threads link', async () => {
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
        // Story should be skipped, only comments shown.
        101: { id: 101, type: 'story', title: 'A story', by: 'alice', time: now - 60 },
        102: {
          id: 102,
          type: 'comment',
          by: 'alice',
          time: now - 120,
          text: 'First <i>comment</i> body with <a href="https://example.com">link</a>',
          parent: 999,
        },
        // Dead/deleted comments should be skipped.
        103: { id: 103, type: 'comment', by: 'alice', time: now - 180, text: 'gone', dead: true },
        104: {
          id: 104,
          type: 'comment',
          by: 'alice',
          time: now - 240,
          text: 'Second comment body',
          parent: 999,
        },
      },
    });
    renderAt('/user/alice');

    const section = await screen.findByRole('region', { name: /recent comments/i });
    await within(section).findByText(/First comment body/);
    const itemLinks = within(section)
      .getAllByRole('link')
      .filter((a) => a.getAttribute('href')?.startsWith('/item/'));
    expect(itemLinks.map((a) => a.getAttribute('href'))).toEqual([
      '/item/102',
      '/item/104',
    ]);
    expect(within(section).getByText(/Second comment body/)).toBeInTheDocument();
    expect(within(section).queryByText(/A story/)).not.toBeInTheDocument();
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
