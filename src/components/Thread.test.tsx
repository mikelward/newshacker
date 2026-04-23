import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Thread, TOP_LEVEL_PAGE_SIZE } from './Thread';
import { FeedBarProvider } from './FeedBarContext';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import type { HNItem } from '../lib/hn';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location-pathname">{loc.pathname}</div>;
}

// Wraps the existing HN fetch mock so a specific URL substring is held open
// until the test releases it. The skeleton tests need a guaranteed loading
// state — without this, the immediate-resolve mock races React's commit
// of the loaded state and the skeleton DOM is gone before the assertion runs.
function gateFetchOn(
  hnMock: ReturnType<typeof installHNFetchMock>,
  urlSubstring: string,
  resolved: Response,
) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes(urlSubstring)) {
        await gate;
        return resolved;
      }
      return hnMock(input);
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return { release };
}

// Renders <Thread> inside a MemoryRouter with a multi-entry history, so
// tests can observe what happens when the thread navigates back or home.
// initialIndex lands on the last entry (the /item/:id route).
function renderThreadWithHistory({
  id,
  entries,
}: {
  id: number;
  entries: string[];
}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        staleTime: 0,
        networkMode: 'offlineFirst',
      },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <FeedBarProvider>
          <LocationProbe />
          <Routes>
            <Route path="/" element={<div data-testid="route-home" />} />
            <Route path="/top" element={<div data-testid="route-top" />} />
            <Route path="/item/:id" element={<Thread id={id} />} />
          </Routes>
        </FeedBarProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<Thread>', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('renders story header + top-level comments, with replies collapsed by default', async () => {
    installHNFetchMock({
      items: {
        100: makeStory(100, { title: 'Parent', kids: [101], descendants: 3 }),
        101: {
          id: 101,
          type: 'comment',
          by: 'bob',
          text: 'hello <b>world</b>',
          time: Math.floor(Date.now() / 1000) - 60,
          kids: [102],
        },
        102: {
          id: 102,
          type: 'comment',
          by: 'carol',
          text: 'nested reply',
          time: Math.floor(Date.now() / 1000) - 30,
          kids: [103],
        },
        103: {
          id: 103,
          type: 'comment',
          by: 'dave',
          text: 'deep',
          time: Math.floor(Date.now() / 1000) - 10,
        },
      },
    });

    renderWithProviders(<Thread id={100} />, { route: '/item/100' });

    await waitFor(() => {
      expect(screen.getByText('Parent')).toBeInTheDocument();
    });
    // Only the top bar has "Read article"; the bottom bar's primary slot
    // is "Back to top" instead.
    const readArticle = screen.getByRole('link', { name: /read article/i });
    expect(readArticle).toHaveAttribute('href', 'https://example.com/100');
    expect(readArticle).toHaveTextContent(/^\s*Read article\s*$/);
    expect(readArticle).not.toHaveTextContent(/example\.com/);
    expect(
      screen.getByRole('button', { name: /back to top/i }),
    ).toBeInTheDocument();
    // Top-level comment body visible
    await waitFor(() => {
      expect(screen.getByText(/hello/)).toBeInTheDocument();
    });
    // Nested replies are collapsed by default
    expect(screen.queryByText(/nested reply/)).toBeNull();
    expect(screen.queryByText(/deep/)).toBeNull();
  });

  it('expands a collapsed subtree via the meta toggle and lazy-loads children', async () => {
    installHNFetchMock({
      items: {
        200: makeStory(200, { kids: [201], descendants: 2 }),
        201: {
          id: 201,
          type: 'comment',
          by: 'x',
          text: 'top comment',
          kids: [202],
          time: 1,
        },
        202: {
          id: 202,
          type: 'comment',
          by: 'y',
          text: 'child comment',
          time: 2,
        },
      },
    });

    renderWithProviders(<Thread id={200} />);

    await waitFor(() => {
      expect(screen.getByText(/top comment/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/child comment/)).toBeNull();

    const expander = screen.getByRole('button', { name: /expand comment/i });
    await userEvent.click(expander);

    await waitFor(() => {
      expect(screen.getByText(/child comment/)).toBeInTheDocument();
    });

    const collapser = screen.getByRole('button', { name: /collapse comment/i });
    await userEvent.click(collapser);
    expect(screen.queryByText(/child comment/)).toBeNull();
  });

  it('clamps comment body by default and removes the clamp when expanded', async () => {
    installHNFetchMock({
      items: {
        400: makeStory(400, { kids: [401], descendants: 1 }),
        401: {
          id: 401,
          type: 'comment',
          by: 'x',
          text: 'a long enough comment body',
          time: 1,
        },
      },
    });

    renderWithProviders(<Thread id={400} />);

    const bodyText = await screen.findByText(/a long enough comment body/);
    const body = bodyText.closest('.comment__body') as HTMLElement;
    expect(body).toHaveClass('comment__body--clamped');

    await userEvent.click(body);
    expect(body).not.toHaveClass('comment__body--clamped');

    await userEvent.click(body);
    expect(body).toHaveClass('comment__body--clamped');
  });

  it('renders the comment author as an internal link to /user/<by>', async () => {
    installHNFetchMock({
      items: {
        500: makeStory(500, { kids: [501], descendants: 1 }),
        501: {
          id: 501,
          type: 'comment',
          by: 'alice',
          text: 'comment body',
          time: 1,
        },
      },
    });

    renderWithProviders(<Thread id={500} />);

    const author = await screen.findByRole('link', { name: 'alice' });
    expect(author).toHaveAttribute('href', '/user/alice');
  });

  it('exposes "Reply on HN" via the per-comment overflow menu', async () => {
    // Reply on HN is no longer an inline link in the meta row — it
    // lives in the per-comment ⋮ menu (alongside Upvote / Downvote
    // for signed-in users) so the comment row can stay scannable
    // and tap targets stay generous. The menu is always reachable,
    // including on collapsed rows.
    installHNFetchMock({
      items: {
        450: makeStory(450, { kids: [451], descendants: 1 }),
        451: {
          id: 451,
          type: 'comment',
          by: 'x',
          text: 'comment body',
          time: 1,
        },
      },
    });

    renderWithProviders(<Thread id={450} />);
    await screen.findByText(/comment body/);

    // Menu opens on the collapsed comment.
    const menuBtn = screen.getByTestId('comment-menu-451');
    const openSpy = vi
      .spyOn(window, 'open')
      .mockImplementation(() => null);
    await userEvent.click(menuBtn);

    const reply = await screen.findByTestId('story-row-menu-reply-on-hn');
    expect(reply).toHaveTextContent(/reply on hn/i);
    await userEvent.click(reply);

    expect(openSpy).toHaveBeenCalledWith(
      'https://news.ycombinator.com/reply?id=451',
      '_blank',
      'noopener,noreferrer',
    );
    openSpy.mockRestore();
  });

  it('filters out deleted, dead, and empty comments from a thread', async () => {
    installHNFetchMock({
      items: {
        900: makeStory(900, { kids: [901, 902, 903, 904], descendants: 4 }),
        901: {
          id: 901,
          type: 'comment',
          by: 'alice',
          text: 'visible comment',
          time: 1,
        },
        902: { id: 902, type: 'comment', deleted: true, time: 2 },
        903: { id: 903, type: 'comment', dead: true, by: 'bob', text: 'x', time: 3 },
        904: { id: 904, type: 'comment', by: 'carol', time: 4 },
      },
    });

    renderWithProviders(<Thread id={900} />);

    await waitFor(() => {
      expect(screen.getByText(/visible comment/)).toBeInTheDocument();
    });
    expect(screen.queryByText('[deleted]')).toBeNull();
    expect(screen.queryByText('[dead]')).toBeNull();
    expect(screen.queryByText('carol')).toBeNull();
  });

  it('shows placeholder for deleted items without crashing', async () => {
    installHNFetchMock({
      items: {
        300: { id: 300, deleted: true },
      },
    });

    renderWithProviders(<Thread id={300} />);
    await waitFor(() => {
      expect(screen.getByText('[deleted]')).toBeInTheDocument();
    });
  });

  it('marks the article as opened when the Read article link is clicked', async () => {
    installHNFetchMock({
      items: { 720: makeStory(720, { title: 'Readable' }) },
    });

    renderWithProviders(<Thread id={720} />);
    await waitFor(() => {
      expect(screen.getByText('Readable')).toBeInTheDocument();
    });

    const link = screen.getByRole('link', { name: /read article/i });
    // jsdom follows hrefs — cancel navigation so the click handler still runs.
    link.addEventListener('click', (e) => e.preventDefault());
    await userEvent.click(link);

    const stored = window.localStorage.getItem('newshacker:openedStoryIds');
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored as string) as Array<{
      id: number;
      articleAt?: number;
    }>;
    const entry = parsed.find((e) => e.id === 720);
    expect(entry?.articleAt).toBeTruthy();
  });

  it('toggles favorite state via the Favorite entry in the overflow menu, independently of Pin', async () => {
    installHNFetchMock({
      items: { 710: makeStory(710, { title: 'Lovable' }) },
    });

    renderWithProviders(<Thread id={710} />);
    await waitFor(() => {
      expect(screen.getByText('Lovable')).toBeInTheDocument();
    });

    // Favorite lives in the overflow menu — it's a keepsake action,
    // less frequent than Done on the comments view.
    expect(screen.queryByTestId('thread-favorite')).toBeNull();

    await userEvent.click(screen.getByTestId('thread-more'));
    const favItem = screen.getByTestId('story-row-menu-favorite');
    expect(favItem).toHaveTextContent(/^favorite$/i);
    await userEvent.click(favItem);
    expect(
      window.localStorage.getItem('newshacker:favoriteStoryIds'),
    ).toContain('"id":710');
    // Pin is untouched by Favorite
    expect(window.localStorage.getItem('newshacker:pinnedStoryIds')).toBeNull();
    await waitFor(() => {
      expect(screen.queryByTestId('story-row-menu')).toBeNull();
    });

    await userEvent.click(screen.getByTestId('thread-more'));
    const unfavItem = screen.getByTestId('story-row-menu-favorite');
    expect(unfavItem).toHaveTextContent(/^unfavorite$/i);
    await userEvent.click(unfavItem);
    const storedFav = window.localStorage.getItem(
      'newshacker:favoriteStoryIds',
    );
    const parsedFav = storedFav
      ? (JSON.parse(storedFav) as Array<{ id: number; deleted?: true }>)
      : [];
    expect(parsedFav.filter((e) => !e.deleted)).toEqual([]);
  });

  it('toggles pinned state via the Pin button on the bar', async () => {
    installHNFetchMock({
      items: { 700: makeStory(700, { title: 'Pinnable' }) },
    });

    renderWithProviders(<Thread id={700} />);
    await waitFor(() => {
      expect(screen.getByText('Pinnable')).toBeInTheDocument();
    });

    const pin = screen.getByTestId('thread-pin');
    expect(pin).toHaveAccessibleName(/^pin$/i);
    expect(pin).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(pin);
    expect(pin).toHaveAccessibleName(/unpin/i);
    expect(pin).toHaveAttribute('aria-pressed', 'true');
    expect(
      window.localStorage.getItem('newshacker:pinnedStoryIds'),
    ).toContain('"id":700');

    await userEvent.click(pin);
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    expect(pin).toHaveAccessibleName(/^pin$/i);
    const storedPin = window.localStorage.getItem(
      'newshacker:pinnedStoryIds',
    );
    const parsedPin = storedPin
      ? (JSON.parse(storedPin) as Array<{ id: number; deleted?: true }>)
      : [];
    expect(parsedPin.filter((e) => !e.deleted)).toEqual([]);
  });

  it('mark-done: records the story, unpins it, and pops back to the previous entry', async () => {
    installHNFetchMock({
      items: { 730: makeStory(730, { title: 'Finishable' }) },
    });
    // Pre-pin the story so we can verify mark-done unpins it.
    window.localStorage.setItem(
      'newshacker:pinnedStoryIds',
      JSON.stringify([{ id: 730, at: Date.now() }]),
    );

    renderThreadWithHistory({
      id: 730,
      entries: ['/top', '/item/730'],
    });
    await screen.findByText('Finishable');

    const done = screen.getByTestId('thread-done');
    expect(done).toHaveAccessibleName(/^mark done$/i);
    expect(done).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(done);

    // Done persisted.
    expect(
      window.localStorage.getItem('newshacker:doneStoryIds'),
    ).toContain('"id":730');

    // Pin is tombstoned (mark-done unpins).
    const pinRaw = window.localStorage.getItem('newshacker:pinnedStoryIds');
    const pinEntries = pinRaw
      ? (JSON.parse(pinRaw) as Array<{ id: number; deleted?: true }>)
      : [];
    expect(pinEntries.filter((e) => !e.deleted && e.id === 730)).toEqual([]);

    // Navigated back to /top (the previous entry), and the thread UI is
    // gone.
    await waitFor(() => {
      expect(screen.getByTestId('location-pathname')).toHaveTextContent(
        '/top',
      );
    });
    expect(screen.queryByText('Finishable')).toBeNull();
  });

  it('mark-done with no in-app history falls back to the home feed', async () => {
    installHNFetchMock({
      items: { 731: makeStory(731, { title: 'Deeplinked' }) },
    });

    // Single-entry history: location.key will be 'default', so we can't
    // pop back — mark-done should navigate to '/' instead.
    renderThreadWithHistory({
      id: 731,
      entries: ['/item/731'],
    });
    await screen.findByText('Deeplinked');

    await userEvent.click(screen.getByTestId('thread-done'));

    await waitFor(() => {
      expect(screen.getByTestId('location-pathname')).toHaveTextContent('/');
    });
    expect(screen.getByTestId('route-home')).toBeInTheDocument();
  });

  it('unmark-done: does not navigate — the user stays on the thread', async () => {
    installHNFetchMock({
      items: { 732: makeStory(732, { title: 'Revisited' }) },
    });
    // Pre-mark the story done so we land on an "Unmark done" button.
    window.localStorage.setItem(
      'newshacker:doneStoryIds',
      JSON.stringify([{ id: 732, at: Date.now() }]),
    );

    renderThreadWithHistory({
      id: 732,
      entries: ['/top', '/item/732'],
    });
    await screen.findByText('Revisited');

    const done = screen.getByTestId('thread-done');
    expect(done).toHaveAccessibleName(/unmark done/i);
    expect(done).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(done);

    // Still on the thread, state flipped back to "Mark done".
    expect(screen.getByTestId('location-pathname')).toHaveTextContent(
      '/item/732',
    );
    expect(screen.getByText('Revisited')).toBeInTheDocument();
    expect(done).toHaveAttribute('aria-pressed', 'false');
    expect(done).toHaveAccessibleName(/^mark done$/i);
    // Tombstoned in localStorage, not active.
    const raw = window.localStorage.getItem('newshacker:doneStoryIds');
    const entries = raw
      ? (JSON.parse(raw) as Array<{ id: number; deleted?: true }>)
      : [];
    expect(entries.filter((e) => !e.deleted && e.id === 732)).toEqual([]);
  });

  it('renders a duplicated action bar at the bottom of the thread', async () => {
    installHNFetchMock({
      items: { 733: makeStory(733, { title: 'Doubled' }) },
    });

    renderWithProviders(<Thread id={733} />);
    await screen.findByText('Doubled');

    // Toggle buttons duplicated with distinct test ids.
    expect(screen.getByTestId('thread-done')).toBeInTheDocument();
    expect(screen.getByTestId('thread-done-bottom')).toBeInTheDocument();
    expect(screen.getByTestId('thread-pin')).toBeInTheDocument();
    expect(screen.getByTestId('thread-pin-bottom')).toBeInTheDocument();
    expect(screen.getByTestId('thread-more')).toBeInTheDocument();
    expect(screen.getByTestId('thread-more-bottom')).toBeInTheDocument();
    // Primary slot differs: top = Read article link, bottom = Back to top
    // button. Read article is NOT duplicated on the bottom bar.
    expect(
      screen.getAllByRole('link', { name: /read article/i }),
    ).toHaveLength(1);
    expect(screen.getByTestId('thread-back-to-top-bottom')).toBeInTheDocument();
  });

  it('bottom bar Back to top stretches like the top bar primary slot so icon buttons align', async () => {
    // Regression: the bottom Back to top previously didn't grow, so
    // Pin/Done/⋮ clustered to the left instead of sitting under their
    // top-bar counterparts. --stretch gives it the same flex-grow as
    // --primary (without the orange), keeping icon positions aligned
    // top-to-bottom.
    installHNFetchMock({
      items: { 7351: makeStory(7351, { title: 'StretchTest' }) },
    });

    renderWithProviders(<Thread id={7351} />);
    await screen.findByText('StretchTest');

    const bottomBackToTop = screen.getByTestId('thread-back-to-top-bottom');
    expect(bottomBackToTop.className).toContain('thread__action--stretch');
    // Not --primary (reserved for the top bar's Read article).
    expect(bottomBackToTop.className).not.toContain('thread__action--primary');
  });

  it('bottom bar Back to top scrolls the window to the top', async () => {
    installHNFetchMock({
      items: { 735: makeStory(735, { title: 'ScrollyTop' }) },
    });

    const scrollToSpy = vi.fn();
    vi.stubGlobal('scrollTo', scrollToSpy);

    renderWithProviders(<Thread id={735} />);
    await screen.findByText('ScrollyTop');

    const backToTop = screen.getByTestId('thread-back-to-top-bottom');
    expect(backToTop).toHaveAccessibleName(/back to top/i);
    await userEvent.click(backToTop);

    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  it('Read article: drops the primary-orange color once the article has been opened', async () => {
    installHNFetchMock({
      items: { 737: makeStory(737, { title: 'ReadOnce' }) },
    });

    // Pre-seed opened-state for story 737 as "article opened once".
    // Entries require both `id` and `at` (the TTL anchor); `articleAt`
    // is what flags the article half as opened.
    const now = Date.now();
    window.localStorage.setItem(
      'newshacker:openedStoryIds',
      JSON.stringify([{ id: 737, at: now, articleAt: now }]),
    );

    renderWithProviders(<Thread id={737} />);
    await screen.findByText('ReadOnce');

    const readArticle = screen.getByTestId('thread-read-article');
    // --primary layout class is preserved, --read overrides the colors.
    expect(readArticle.className).toContain('thread__action--primary');
    expect(readArticle.className).toContain('thread__action--read');
  });

  it('Read article: keeps the primary-orange color before the article is opened', async () => {
    installHNFetchMock({
      items: { 738: makeStory(738, { title: 'Unread' }) },
    });

    renderWithProviders(<Thread id={738} />);
    await screen.findByText('Unread');

    const readArticle = screen.getByTestId('thread-read-article');
    expect(readArticle.className).toContain('thread__action--primary');
    expect(readArticle.className).not.toContain('thread__action--read');
  });

  it('bottom bar shows Back to top even on self-posts with no article url', async () => {
    installHNFetchMock({
      items: {
        736: makeStory(736, {
          title: 'Ask HN: no url',
          url: undefined,
          text: 'a self post',
        }),
      },
    });

    renderWithProviders(<Thread id={736} />);
    await screen.findByText('Ask HN: no url');

    // Self-post → no Read article on either bar.
    expect(
      screen.queryByRole('link', { name: /read article/i }),
    ).toBeNull();
    // But the bottom bar still offers Back to top.
    expect(screen.getByTestId('thread-back-to-top-bottom')).toBeInTheDocument();
  });

  it('mark-done from the bottom action bar also navigates back', async () => {
    installHNFetchMock({
      items: { 734: makeStory(734, { title: 'BottomDone' }) },
    });

    renderThreadWithHistory({
      id: 734,
      entries: ['/top', '/item/734'],
    });
    await screen.findByText('BottomDone');

    await userEvent.click(screen.getByTestId('thread-done-bottom'));

    await waitFor(() => {
      expect(screen.getByTestId('location-pathname')).toHaveTextContent(
        '/top',
      );
    });
    expect(
      window.localStorage.getItem('newshacker:doneStoryIds'),
    ).toContain('"id":734');
  });

  // Thread-page voting. The upvote arrow lives in the action row
  // next to Pin/Favorite and only renders when the user is signed in.
  // /api/me drives isAuthenticated; /api/vote handles the actual cast.
  function installVoteFetchMock(
    username: string | null,
    voteResponse: () => Response = () => new Response(null, { status: 204 }),
  ): ReturnType<typeof vi.fn> {
    const hnMock = installHNFetchMock({
      items: { 800: makeStory(800, { title: 'Votable' }) },
    });
    const outer = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/me') {
          if (username) {
            return new Response(JSON.stringify({ username }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response(JSON.stringify({ error: 'nope' }), {
            status: 401,
          });
        }
        if (url === '/api/vote') {
          return voteResponse();
        }
        // installHNFetchMock's mock only reads the URL; init is unused
        // downstream, so we don't thread it through.
        return hnMock(input);
      },
    );
    vi.stubGlobal('fetch', outer);
    return outer;
  }

  it('does not render the thread upvote button when logged out', async () => {
    installVoteFetchMock(null);
    renderWithProviders(<Thread id={800} />);
    await waitFor(() => {
      expect(screen.getByText('Votable')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('thread-vote')).toBeNull();
  });

  it('renders the thread upvote button and toggles the voted state when signed in', async () => {
    const fetchMock = installVoteFetchMock('alice');
    renderWithProviders(<Thread id={800} />);
    await waitFor(() => {
      expect(screen.getByTestId('thread-vote')).toBeInTheDocument();
    });

    const vote = screen.getByTestId('thread-vote');
    expect(vote).toHaveAccessibleName(/^upvote$/i);
    expect(vote).toHaveAttribute('aria-pressed', 'false');
    expect(vote.className).not.toContain('thread__action--active');

    await userEvent.click(vote);
    expect(vote).toHaveAccessibleName(/^unvote$/i);
    expect(vote).toHaveAttribute('aria-pressed', 'true');
    expect(vote.className).toContain('thread__action--active');

    // The optimistic write sat in localStorage under alice's namespace.
    expect(
      window.localStorage.getItem('newshacker:votedStoryIds:alice'),
    ).toContain('800');

    // POST /api/vote was fired with id + how=up.
    await waitFor(() => {
      const voteCalls = fetchMock.mock.calls.filter(
        ([url]) => String(url) === '/api/vote',
      );
      expect(voteCalls.length).toBeGreaterThan(0);
    });
    const call = fetchMock.mock.calls.find(
      ([url]) => String(url) === '/api/vote',
    );
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      id: 800,
      how: 'up',
    });

    // A second tap toggles back to unvoted (how=un on the POST).
    await userEvent.click(vote);
    expect(vote).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => {
      const unvoteCalls = fetchMock.mock.calls.filter(([url, init]) => {
        if (String(url) !== '/api/vote') return false;
        const body = JSON.parse(String((init as RequestInit).body));
        return body.how === 'un';
      });
      expect(unvoteCalls.length).toBeGreaterThan(0);
    });
  });

  it('rolls back the optimistic vote when /api/vote rejects', async () => {
    installVoteFetchMock(
      'alice',
      () =>
        new Response(
          JSON.stringify({ error: 'Hacker News session expired' }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    );
    renderWithProviders(<Thread id={800} />);
    await waitFor(() => {
      expect(screen.getByTestId('thread-vote')).toBeInTheDocument();
    });

    const vote = screen.getByTestId('thread-vote');
    await userEvent.click(vote);

    // The optimistic flip happens synchronously inside the click, but
    // in jsdom userEvent awaits through microtasks long enough for the
    // /api/vote rejection to have rolled state back before we observe
    // it. So we only assert the final, rolled-back state — that the
    // button is un-pressed and nothing was persisted.
    await waitFor(() => {
      expect(vote).toHaveAttribute('aria-pressed', 'false');
    });
    expect(
      window.localStorage.getItem('newshacker:votedStoryIds:alice'),
    ).toBeNull();
  });

  it('opens an overflow menu with "Open on Hacker News" and "Share article" entries', async () => {
    installHNFetchMock({
      items: { 730: makeStory(730, { title: 'Mystery' }) },
    });

    const openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
    const shareSpy = vi.fn().mockResolvedValue(undefined);
    const hadShare = 'share' in window.navigator;
    Object.defineProperty(window.navigator, 'share', {
      value: shareSpy,
      configurable: true,
    });

    try {
      renderWithProviders(<Thread id={730} />);
      await waitFor(() => {
        expect(screen.getByText('Mystery')).toBeInTheDocument();
      });

      expect(screen.queryByTestId('story-row-menu')).toBeNull();

      const more = screen.getByTestId('thread-more');
      expect(more).toHaveAttribute('aria-haspopup', 'menu');
      expect(more).toHaveAttribute('aria-expanded', 'false');

      await userEvent.click(more);
      expect(more).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByTestId('story-row-menu')).toBeInTheDocument();

      await userEvent.click(screen.getByTestId('story-row-menu-open-on-hn'));
      expect(openSpy).toHaveBeenCalledWith(
        'https://news.ycombinator.com/item?id=730',
        '_blank',
        'noopener,noreferrer',
      );
      // Selecting an item closes the sheet.
      await waitFor(() => {
        expect(screen.queryByTestId('story-row-menu')).toBeNull();
      });

      await userEvent.click(more);
      await userEvent.click(screen.getByTestId('story-row-menu-share-article'));
      await waitFor(() => {
        expect(shareSpy).toHaveBeenCalledTimes(1);
      });
      expect(shareSpy.mock.calls[0]?.[0]).toMatchObject({
        title: 'Mystery',
        url: 'https://example.com/730',
      });
    } finally {
      if (hadShare) {
        Object.defineProperty(window.navigator, 'share', {
          value: undefined,
          configurable: true,
        });
      } else {
        // @ts-expect-error — clean up the stub we added.
        delete (window.navigator as Navigator & { share?: unknown }).share;
      }
    }
  });

  it('hides the "Share article" entry on self-posts (no external url)', async () => {
    installHNFetchMock({
      items: {
        740: makeStory(740, { title: 'Ask HN: anything?', url: undefined }),
      },
    });

    renderWithProviders(<Thread id={740} />);
    await waitFor(() => {
      expect(screen.getByText('Ask HN: anything?')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId('thread-more'));
    expect(screen.getByTestId('story-row-menu-open-on-hn')).toBeInTheDocument();
    expect(screen.queryByTestId('story-row-menu-share-article')).toBeNull();
  });

  it('auto-fetches and displays the summary card on mount', async () => {
    installHNFetchMock({
      items: {
        800: makeStory(800, { title: 'Linky', url: 'https://example.com/800' }),
      },
      summaries: {
        800: {
          summary: 'A concise one-sentence summary.',
        },
      },
    });

    renderWithProviders(<Thread id={800} />);

    await waitFor(() => {
      expect(screen.getByTestId('thread-summary-card')).toBeInTheDocument();
    });
    expect(
      await screen.findByText('A concise one-sentence summary.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('thread-summarize')).toBeNull();
  });

  it('shows skeleton lines while the summary is loading and marks the card busy', async () => {
    const hnMock = installHNFetchMock({
      items: {
        820: makeStory(820, { title: 'Slow', url: 'https://example.com/820' }),
      },
    });
    const { release } = gateFetchOn(
      hnMock,
      '/api/summary',
      new Response(JSON.stringify({ summary: 'Eventually here.' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    renderWithProviders(<Thread id={820} />);

    await screen.findByTestId('thread-summary-skeleton');
    expect(screen.getByTestId('thread-summary-card')).toHaveAttribute(
      'aria-busy',
      'true',
    );

    release();

    expect(
      await screen.findByText('Eventually here.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('thread-summary-skeleton')).toBeNull();
    expect(screen.getByTestId('thread-summary-card')).toHaveAttribute(
      'aria-busy',
      'false',
    );
  });

  it('shows an error + Retry in the summary card when the api fails', async () => {
    installHNFetchMock({
      items: {
        810: makeStory(810, { title: 'Flaky', url: 'https://example.com/810' }),
      },
      summaries: {
        810: { error: 'Summarization failed', status: 502 },
      },
    });

    renderWithProviders(<Thread id={810} />);

    await waitFor(() => {
      expect(screen.getByText(/could not summarize/i)).toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', { name: /retry/i }),
    ).toBeInTheDocument();
  });

  it('shows a timeout-specific message when the source site did not respond', async () => {
    installHNFetchMock({
      items: {
        811: makeStory(811, { title: 'Hugged', url: 'https://example.com/811' }),
      },
      summaries: {
        811: {
          error: "The article site didn't respond in time",
          reason: 'source_timeout',
          status: 504,
        },
      },
    });

    renderWithProviders(<Thread id={811} />);

    await waitFor(() => {
      expect(
        screen.getByText(/didn't respond in time/i),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(/try opening the link directly/i),
    ).toBeInTheDocument();
  });

  it('shows a temporarily-unavailable message when Jina quota is exhausted', async () => {
    // 503 summary_budget_exhausted is the user-facing surface of the
    // Jina 402 handling. Render friendly "try again later" copy rather
    // than the permanent "aren't available" or misleading
    // "article is unreachable" messages.
    installHNFetchMock({
      items: {
        813: makeStory(813, { title: 'Paywalled Quota', url: 'https://example.com/813' }),
      },
      summaries: {
        813: {
          error: 'Summaries are temporarily unavailable',
          reason: 'summary_budget_exhausted',
          status: 503,
        },
      },
    });

    renderWithProviders(<Thread id={813} />);

    await waitFor(() => {
      expect(
        screen.getByText(/temporarily unavailable/i),
      ).toBeInTheDocument();
    });
  });

  it('shows a rate-limited message when the summary endpoint 429s', async () => {
    // Regression guard for the per-IP cache-miss rate limit on
    // /api/summary. A 429 with `reason: 'rate_limited'` must render
    // the "Too many requests — try again later." copy, not the
    // generic "Summarization failed" fallback.
    installHNFetchMock({
      items: {
        820: makeStory(820, {
          title: 'Rate limited',
          url: 'https://example.com/820',
        }),
      },
      summaries: {
        820: {
          error: 'Too many requests',
          reason: 'rate_limited',
          status: 429,
        },
      },
    });

    renderWithProviders(<Thread id={820} />);

    await waitFor(() => {
      expect(
        screen.getByText(/too many requests — try again later/i),
      ).toBeInTheDocument();
    });
  });

  it('shows an unreachable-specific message when the source site blocks us', async () => {
    installHNFetchMock({
      items: {
        812: makeStory(812, { title: 'Blocked', url: 'https://example.com/812' }),
      },
      summaries: {
        812: {
          error: 'Could not access the article',
          reason: 'source_unreachable',
          status: 502,
        },
      },
    });

    renderWithProviders(<Thread id={812} />);

    await waitFor(() => {
      expect(
        screen.getByText(/couldn't reach the article site/i),
      ).toBeInTheDocument();
    });
  });

  it('renders a summary card for self-posts with a text body', async () => {
    // Self-posts are summarized directly from `story.text` — no Jina
    // round-trip — so the card should appear on the thread just like it
    // does for link posts.
    installHNFetchMock({
      items: {
        850: makeStory(850, {
          title: 'Ask HN: no url',
          url: undefined,
          text: 'a self post',
        }),
      },
      summaries: { 850: { summary: 'Self-post summary.' } },
    });

    renderWithProviders(<Thread id={850} />);
    await waitFor(() => {
      expect(screen.getByText('Ask HN: no url')).toBeInTheDocument();
    });

    const card = await screen.findByTestId('thread-summary-card');
    expect(card).toBeInTheDocument();
    expect(card).toHaveTextContent('Self-post summary.');
  });

  it('does not render a summary card when the story has neither url nor text', async () => {
    installHNFetchMock({
      items: {
        851: makeStory(851, {
          title: 'Empty story',
          url: undefined,
          text: undefined,
        }),
      },
    });

    renderWithProviders(<Thread id={851} />);
    await waitFor(() => {
      expect(screen.getByText('Empty story')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('thread-summary-card')).toBeNull();
  });

  it('does not render a summary card when a self-post body is effectively empty', async () => {
    // Regression: `<p> </p>` is truthy but the server returns 400
    // `no_article` after HTML strip + trim. Rendering the card anyway
    // would surface a retryable "Could not summarize" error for a
    // post that was never summarizable.
    installHNFetchMock({
      items: {
        852: makeStory(852, {
          title: 'Whitespace body',
          url: undefined,
          text: '<p>   </p>',
        }),
      },
    });

    renderWithProviders(<Thread id={852} />);
    await waitFor(() => {
      expect(screen.getByText('Whitespace body')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('thread-summary-card')).toBeNull();
  });

  it('shows domain (not author) in the meta line for link posts', async () => {
    installHNFetchMock({
      items: {
        600: makeStory(600, {
          title: 'A link post',
          url: 'https://example.com/600',
          by: 'alice',
          score: 42,
          descendants: 7,
        }),
      },
    });

    renderWithProviders(<Thread id={600} />);

    const meta = await screen.findByTestId('thread-meta');
    expect(meta).toHaveTextContent(
      /example\.com · \S+ · 42 points · 7 comments/,
    );
    // Author link is not in the meta for link posts.
    expect(meta.querySelector('.thread__author')).toBeNull();

    const domainLink = meta.querySelector('.thread__domain');
    expect(domainLink).not.toBeNull();
    expect(domainLink).toHaveTextContent('example.com');
    expect(domainLink).toHaveAttribute('href', 'https://example.com/');
    expect(domainLink).toHaveAttribute('target', '_blank');
    expect(domainLink).toHaveAttribute(
      'rel',
      expect.stringContaining('noopener'),
    );
  });

  it('shows author link (not domain) in the meta line for self posts', async () => {
    installHNFetchMock({
      items: {
        610: makeStory(610, {
          title: 'Ask HN',
          url: undefined,
          by: 'bob',
          score: 5,
          descendants: 0,
          text: 'a self post',
        }),
      },
    });

    renderWithProviders(<Thread id={610} />);

    const meta = await screen.findByTestId('thread-meta');
    const author = meta.querySelector('.thread__author');
    expect(author).not.toBeNull();
    expect(author).toHaveTextContent('bob');
    expect(meta).toHaveTextContent(/bob · \S+ · 5 points · 0 comments/);
  });

  it('auto-fetches and renders the comments summary card when the story has kids', async () => {
    installHNFetchMock({
      items: {
        950: makeStory(950, {
          title: 'Lots of discussion',
          kids: [951],
          descendants: 1,
        }),
        951: {
          id: 951,
          type: 'comment',
          by: 'alice',
          text: 'great article',
          time: 1,
        },
      },
      commentsSummaries: {
        950: { insights: ['Alpha insight.', 'Beta insight.'] },
      },
    });

    renderWithProviders(<Thread id={950} />);

    const card = await screen.findByTestId('thread-comments-summary-card');
    expect(card).toBeInTheDocument();
    expect(await screen.findByText('Alpha insight.')).toBeInTheDocument();
    expect(screen.getByText('Beta insight.')).toBeInTheDocument();
  });

  it('renders both the article and comments summary cards for self-posts (Ask HN) with kids', async () => {
    // Self-posts with body text get the article summary card too — it's
    // generated directly from `story.text` instead of a fetched article.
    installHNFetchMock({
      items: {
        960: makeStory(960, {
          title: 'Ask HN: thoughts?',
          url: undefined,
          text: 'what do you think',
          kids: [961],
          descendants: 1,
        }),
        961: {
          id: 961,
          type: 'comment',
          by: 'bob',
          text: 'here is a thought',
          time: 1,
        },
      },
      summaries: { 960: { summary: 'Seeking opinions.' } },
      commentsSummaries: {
        960: { insights: ['Community thinks carefully.'] },
      },
    });

    renderWithProviders(<Thread id={960} />);

    await screen.findByText('Ask HN: thoughts?');
    expect(
      await screen.findByTestId('thread-summary-card'),
    ).toBeInTheDocument();
    expect(await screen.findByText('Seeking opinions.')).toBeInTheDocument();

    expect(
      await screen.findByTestId('thread-comments-summary-card'),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('Community thinks carefully.'),
    ).toBeInTheDocument();
  });

  it('does not render the comments summary card for stories without kids', async () => {
    installHNFetchMock({
      items: {
        970: makeStory(970, {
          title: 'Lonely',
          kids: [],
          descendants: 0,
        }),
      },
    });

    renderWithProviders(<Thread id={970} />);

    await screen.findByText('Lonely');
    expect(screen.queryByTestId('thread-comments-summary-card')).toBeNull();
  });

  it('shows a skeleton while the comments summary loads and marks the card busy', async () => {
    const hnMock = installHNFetchMock({
      items: {
        980: makeStory(980, { kids: [981], descendants: 1 }),
        981: {
          id: 981,
          type: 'comment',
          by: 'x',
          text: 'body',
          time: 1,
        },
      },
    });
    const { release } = gateFetchOn(
      hnMock,
      '/api/comments-summary',
      new Response(JSON.stringify({ insights: ['Eventually here.'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    renderWithProviders(<Thread id={980} />);

    await screen.findByTestId('thread-comments-summary-skeleton');
    expect(
      screen.getByTestId('thread-comments-summary-card'),
    ).toHaveAttribute('aria-busy', 'true');

    release();

    expect(await screen.findByText('Eventually here.')).toBeInTheDocument();
    expect(
      screen.queryByTestId('thread-comments-summary-skeleton'),
    ).toBeNull();
    expect(
      screen.getByTestId('thread-comments-summary-card'),
    ).toHaveAttribute('aria-busy', 'false');
  });

  it('shows an error with Retry when the comments summary api fails', async () => {
    installHNFetchMock({
      items: {
        // Self-post (no url) so we don't get a second Retry button from
        // the article summary card, which would make the role query
        // ambiguous. The self-post gets a successful /api/summary fixture
        // so its card resolves into a normal summary state (no Retry),
        // leaving only the comments-summary card's Retry visible.
        990: makeStory(990, {
          kids: [991],
          descendants: 1,
          url: undefined,
          text: 'self',
        }),
        991: { id: 991, type: 'comment', by: 'x', text: 'hi', time: 1 },
      },
      summaries: { 990: { summary: 'self-post summary.' } },
      commentsSummaries: {
        990: { error: 'Summarization failed', status: 502 },
      },
    });

    renderWithProviders(<Thread id={990} />);

    await waitFor(() => {
      expect(
        screen.getByText(/could not summarize comments/i),
      ).toBeInTheDocument();
    });
    const card = screen.getByTestId('thread-comments-summary-card');
    expect(
      screen.getByRole('button', { name: /retry/i }),
    ).toBeInTheDocument();
    expect(card).toBeInTheDocument();
  });

  it('paginates top-level comments (only renders first page)', async () => {
    const totalKids = TOP_LEVEL_PAGE_SIZE + 5;
    const kidIds = Array.from({ length: totalKids }, (_, i) => 1000 + i);
    const items: Record<number, HNItem | null> = {
      500: makeStory(500, { kids: kidIds, descendants: totalKids }),
    };
    for (const kid of kidIds) {
      items[kid] = {
        id: kid,
        type: 'comment',
        by: `u${kid}`,
        text: `comment ${kid}`,
        time: 1,
      };
    }
    installHNFetchMock({ items });

    renderWithProviders(<Thread id={500} />);

    await waitFor(() => {
      expect(screen.getByText(/comment 1000/)).toBeInTheDocument();
    });
    // Last item on first page visible
    expect(
      screen.getByText(`comment ${1000 + TOP_LEVEL_PAGE_SIZE - 1}`),
    ).toBeInTheDocument();
    // Items beyond the first page are NOT rendered yet
    expect(
      screen.queryByText(`comment ${1000 + TOP_LEVEL_PAGE_SIZE}`),
    ).toBeNull();
    // Sentinel exists so IntersectionObserver can trigger next page
    expect(screen.getByTestId('comments-sentinel')).toBeInTheDocument();
  });
});
