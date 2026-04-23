import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { FeedBarProvider } from './FeedBarContext';
import { Comment } from './Comment';
import { ToastContext, type ToastOptions } from '../hooks/useToast';
import type { HNItem } from '../lib/hn';
import { addDownvotedId, addVotedId } from '../lib/votes';

// Comment overflow menu — replaces the inline upvote button. The
// ⋮ button is always rendered (collapsed and expanded, signed-in or
// not) so the menu is discoverable on every comment. Logged-in users
// see Upvote / Downvote / Reply on HN; logged-out users see only
// Reply on HN. Long-press behavior itself is tested at the hook
// level in useSwipeToDismiss.test.tsx; this file covers the
// integration: ⋮ button + menu items + the same /api/vote payload
// shape the inline button used.

function commentFixture(id: number, overrides: Partial<HNItem> = {}): HNItem {
  return {
    id,
    type: 'comment',
    by: 'alice',
    text: `body ${id}`,
    time: 1_700_000_000,
    kids: [],
    ...overrides,
  };
}

interface FetchPlan {
  me: string | null;
  items?: Record<number, HNItem>;
  vote?: (body: { id: number; how: string }) => Response;
}

function stubFetch(plan: FetchPlan): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/me') {
      if (plan.me) {
        return new Response(JSON.stringify({ username: plan.me }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'nope' }), { status: 401 });
    }
    if (url === '/api/vote') {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const handler = plan.vote ?? (() => new Response(null, { status: 204 }));
      return handler(body as { id: number; how: string });
    }
    const match = url.match(/\/item\/(\d+)\.json/);
    if (match) {
      const id = Number(match[1]);
      const item = plan.items?.[id];
      return new Response(JSON.stringify(item ?? null), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function newClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, networkMode: 'always' },
    },
  });
}

function renderComment(
  ui: ReactElement,
  toasts: ToastOptions[] = [],
): ReturnType<typeof render> {
  const client = newClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/']}>
          <FeedBarProvider>
            <ToastContext.Provider
              value={{
                showToast: (opts) => {
                  toasts.push(opts);
                },
              }}
            >
              {children}
            </ToastContext.Provider>
          </FeedBarProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }
  return render(ui, { wrapper: Wrapper });
}

describe('<Comment> overflow menu', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('renders the ⋮ button on collapsed comments (no auth required)', async () => {
    stubFetch({ me: null, items: { 8000: commentFixture(8000) } });
    renderComment(<Comment id={8000} />);
    await waitFor(() => {
      expect(screen.getByText('body 8000')).toBeInTheDocument();
    });
    expect(screen.getByTestId('comment-menu-8000')).toBeInTheDocument();
  });

  it('renders the ⋮ button on expanded comments too', async () => {
    stubFetch({ me: null, items: { 8001: commentFixture(8001) } });
    renderComment(<Comment id={8001} />);
    await waitFor(() => {
      expect(screen.getByText('body 8001')).toBeInTheDocument();
    });
    act(() => {
      fireEvent.click(screen.getByText('body 8001'));
    });
    expect(screen.getByTestId('comment-menu-8001')).toBeInTheDocument();
  });

  it('logged-out menu shows only Reply on HN', async () => {
    stubFetch({ me: null, items: { 8002: commentFixture(8002) } });
    renderComment(<Comment id={8002} />);
    await waitFor(() => {
      expect(screen.getByText('body 8002')).toBeInTheDocument();
    });
    act(() => {
      fireEvent.click(screen.getByTestId('comment-menu-8002'));
    });
    await screen.findByTestId('story-row-menu');
    expect(screen.queryByTestId('story-row-menu-upvote')).toBeNull();
    expect(screen.queryByTestId('story-row-menu-downvote')).toBeNull();
    expect(
      screen.getByTestId('story-row-menu-reply-on-hn'),
    ).toBeInTheDocument();
  });

  it('logged-in menu shows Upvote, Downvote, and Reply on HN', async () => {
    stubFetch({ me: 'alice', items: { 8003: commentFixture(8003) } });
    renderComment(<Comment id={8003} />);
    await waitFor(() => {
      expect(screen.getByText('body 8003')).toBeInTheDocument();
    });
    act(() => {
      fireEvent.click(screen.getByTestId('comment-menu-8003'));
    });
    await screen.findByTestId('story-row-menu');
    expect(screen.getByTestId('story-row-menu-upvote')).toHaveTextContent(
      'Upvote',
    );
    expect(screen.getByTestId('story-row-menu-downvote')).toHaveTextContent(
      'Downvote',
    );
    expect(
      screen.getByTestId('story-row-menu-reply-on-hn'),
    ).toBeInTheDocument();
  });

  it('Upvote item POSTs /api/vote with the comment id and how=up', async () => {
    const fetchMock = stubFetch({
      me: 'alice',
      items: { 8004: commentFixture(8004) },
    });
    renderComment(<Comment id={8004} />);
    await waitFor(() => {
      expect(screen.getByText('body 8004')).toBeInTheDocument();
    });
    act(() => {
      fireEvent.click(screen.getByTestId('comment-menu-8004'));
    });
    const upvote = await screen.findByTestId('story-row-menu-upvote');
    act(() => {
      fireEvent.click(upvote);
    });
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        ([url]) => String(url) === '/api/vote',
      );
      expect(calls.length).toBe(1);
    });
    const call = fetchMock.mock.calls.find(
      ([url]) => String(url) === '/api/vote',
    )!;
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body).toEqual({ id: 8004, how: 'up' });
  });

  it('Downvote item POSTs /api/vote with how=down', async () => {
    const fetchMock = stubFetch({
      me: 'alice',
      items: { 8005: commentFixture(8005) },
    });
    renderComment(<Comment id={8005} />);
    await waitFor(() => {
      expect(screen.getByText('body 8005')).toBeInTheDocument();
    });
    act(() => {
      fireEvent.click(screen.getByTestId('comment-menu-8005'));
    });
    const downvote = await screen.findByTestId('story-row-menu-downvote');
    act(() => {
      fireEvent.click(downvote);
    });
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        ([url]) => String(url) === '/api/vote',
      );
      expect(calls.length).toBe(1);
    });
    const call = fetchMock.mock.calls.find(
      ([url]) => String(url) === '/api/vote',
    )!;
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body).toEqual({ id: 8005, how: 'down' });
  });

  it('Upvote on an already-upvoted comment relabels to Unvote and sends how=un', async () => {
    addVotedId('alice', 8006);
    const fetchMock = stubFetch({
      me: 'alice',
      items: { 8006: commentFixture(8006) },
    });
    renderComment(<Comment id={8006} />);
    await waitFor(() => {
      expect(screen.getByText('body 8006')).toBeInTheDocument();
    });
    act(() => {
      fireEvent.click(screen.getByTestId('comment-menu-8006'));
    });
    const item = await screen.findByTestId('story-row-menu-upvote');
    expect(item).toHaveTextContent('Unvote');
    act(() => {
      fireEvent.click(item);
    });
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        ([url]) => String(url) === '/api/vote',
      );
      expect(calls.length).toBe(1);
    });
    const call = fetchMock.mock.calls.find(
      ([url]) => String(url) === '/api/vote',
    )!;
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body).toEqual({ id: 8006, how: 'un' });
  });

  it('Downvote on an already-downvoted comment relabels to Undownvote', async () => {
    addDownvotedId('alice', 8007);
    stubFetch({
      me: 'alice',
      items: { 8007: commentFixture(8007) },
    });
    renderComment(<Comment id={8007} />);
    await waitFor(() => {
      expect(screen.getByText('body 8007')).toBeInTheDocument();
    });
    act(() => {
      fireEvent.click(screen.getByTestId('comment-menu-8007'));
    });
    const item = await screen.findByTestId('story-row-menu-downvote');
    expect(item).toHaveTextContent('Undownvote');
  });

  it('Reply on HN item opens the reply page in a new tab', async () => {
    stubFetch({ me: null, items: { 8008: commentFixture(8008) } });
    const openSpy = vi
      .spyOn(window, 'open')
      .mockImplementation(() => null);
    renderComment(<Comment id={8008} />);
    await waitFor(() => {
      expect(screen.getByText('body 8008')).toBeInTheDocument();
    });
    act(() => {
      fireEvent.click(screen.getByTestId('comment-menu-8008'));
    });
    const reply = await screen.findByTestId('story-row-menu-reply-on-hn');
    act(() => {
      fireEvent.click(reply);
    });
    expect(openSpy).toHaveBeenCalledWith(
      'https://news.ycombinator.com/reply?id=8008',
      '_blank',
      'noopener,noreferrer',
    );
    openSpy.mockRestore();
  });

  it('voted comments get a row accent class', async () => {
    addVotedId('alice', 8009);
    stubFetch({ me: 'alice', items: { 8009: commentFixture(8009) } });
    const { container } = renderComment(<Comment id={8009} />);
    await waitFor(() => {
      expect(screen.getByText('body 8009')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        container.querySelector('.comment.comment--upvoted'),
      ).toBeInTheDocument();
    });
  });

  it('downvoted comments get a row accent class', async () => {
    addDownvotedId('alice', 8010);
    stubFetch({ me: 'alice', items: { 8010: commentFixture(8010) } });
    const { container } = renderComment(<Comment id={8010} />);
    await waitFor(() => {
      expect(screen.getByText('body 8010')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        container.querySelector('.comment.comment--downvoted'),
      ).toBeInTheDocument();
    });
  });

  it('tapping the ⋮ button again closes the open menu (toggle, not open-only)', async () => {
    stubFetch({ me: null, items: { 8012: commentFixture(8012) } });
    renderComment(<Comment id={8012} />);
    await waitFor(() => {
      expect(screen.getByText('body 8012')).toBeInTheDocument();
    });
    const menuBtn = screen.getByTestId('comment-menu-8012');

    act(() => {
      fireEvent.click(menuBtn);
    });
    expect(screen.getByTestId('story-row-menu')).toBeInTheDocument();

    act(() => {
      fireEvent.click(menuBtn);
    });
    expect(screen.queryByTestId('story-row-menu')).toBeNull();
  });

  it('upvoted comments highlight the Unvote item with the active class', async () => {
    addVotedId('alice', 8013);
    stubFetch({ me: 'alice', items: { 8013: commentFixture(8013) } });
    renderComment(<Comment id={8013} />);
    await waitFor(() => {
      expect(screen.getByText('body 8013')).toBeInTheDocument();
    });
    act(() => {
      fireEvent.click(screen.getByTestId('comment-menu-8013'));
    });
    const upvoteItem = await screen.findByTestId('story-row-menu-upvote');
    expect(upvoteItem.className).toMatch(/story-menu__item--active/);
    expect(upvoteItem).toHaveTextContent('Unvote');

    // Downvote item is unvoted, so it stays at the default style.
    const downvoteItem = screen.getByTestId('story-row-menu-downvote');
    expect(downvoteItem.className).not.toMatch(/story-menu__item--active/);
  });

  it('downvoted comments highlight the Undownvote item with the active class', async () => {
    addDownvotedId('alice', 8014);
    stubFetch({ me: 'alice', items: { 8014: commentFixture(8014) } });
    renderComment(<Comment id={8014} />);
    await waitFor(() => {
      expect(screen.getByText('body 8014')).toBeInTheDocument();
    });
    act(() => {
      fireEvent.click(screen.getByTestId('comment-menu-8014'));
    });
    const downvoteItem = await screen.findByTestId('story-row-menu-downvote');
    expect(downvoteItem.className).toMatch(/story-menu__item--active/);
    expect(downvoteItem).toHaveTextContent('Undownvote');
  });

  it('vote failure rolls back state and surfaces a toast', async () => {
    const toasts: ToastOptions[] = [];
    stubFetch({
      me: 'alice',
      items: { 8011: commentFixture(8011) },
      vote: () =>
        new Response(JSON.stringify({ error: 'Hacker News is down' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const { container } = renderComment(<Comment id={8011} />, toasts);
    await waitFor(() => {
      expect(screen.getByText('body 8011')).toBeInTheDocument();
    });
    act(() => {
      fireEvent.click(screen.getByTestId('comment-menu-8011'));
    });
    const upvote = await screen.findByTestId('story-row-menu-upvote');
    act(() => {
      fireEvent.click(upvote);
    });
    // Optimistic accent applies briefly.
    await waitFor(() => {
      expect(
        container.querySelector('.comment.comment--upvoted'),
      ).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(toasts.length).toBeGreaterThan(0);
    });
    expect(
      container.querySelector('.comment.comment--upvoted'),
    ).toBeNull();
    expect(toasts[toasts.length - 1].message).toBe('Hacker News is down');
  });
});
