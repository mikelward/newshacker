import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { StoryList, StoryListImpl } from './StoryList';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import type { FeedItemsState } from '../hooks/useStoryList';
import {
  DEFAULT_HOT_THRESHOLDS,
  setStoredHotThresholds,
} from '../lib/hotThresholds';
import { _resetNetworkStatusForTests } from '../lib/networkStatus';

describe('<StoryList>', () => {
  beforeEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('renders 30 items by default and reveals another 30 per More click', async () => {
    // Mirrors HN's web home page: the initial paint is exactly one page
    // (30 stories). Additional pages are only fetched when the reader
    // taps More — no auto-prefetch, no infinite scroll.
    const ids = Array.from({ length: 120 }, (_, i) => i + 1);
    const items = Object.fromEntries(ids.map((id) => [id, makeStory(id)]));
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(30);
    });

    const more = screen.getByRole('button', { name: /^more$/i });
    // Footer bar mirrors the thread action bar: Back to top (left) →
    // More (middle) → Hide unpinned (right edge). See SPEC § Bottom
    // action bar (list views).
    const backToTop = screen.getByTestId('back-to-top');
    const sweep = screen.getByTestId('sweep-btn-bottom');
    expect(backToTop).toBeInTheDocument();
    expect(
      more.compareDocumentPosition(backToTop) &
        Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    expect(
      more.compareDocumentPosition(sweep) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await userEvent.click(more);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(60);
    });

    await userEvent.click(screen.getByRole('button', { name: /^more$/i }));

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(90);
    });
  });

  it('tags the feed footer with the --feed modifier so Back to top shrinks and More stretches', async () => {
    // Regression: the feed footer carries `.story-list__footer--feed`
    // so the CSS override can shrink Back to top to natural width and
    // leave More (the primary action on a feed) as the row's growing
    // button. Library footers intentionally omit the modifier and let
    // the default `.back-to-top-btn { flex: 1 }` fill the row instead.
    const ids = Array.from({ length: 40 }, (_, i) => i + 1);
    const items = Object.fromEntries(ids.map((id) => [id, makeStory(id)]));
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(<StoryList feed="top" />);

    const footer = (await screen.findByTestId('back-to-top')).closest(
      '.story-list__footer',
    );
    expect(footer).not.toBeNull();
    expect(footer!.classList.contains('story-list__footer--feed')).toBe(true);
  });

  it('grays out the footer button after the last page is revealed', async () => {
    // 45 ids: page 0 shows 30 with an enabled More; one tap reveals the
    // remaining 15 and exhausts the feed, so the button flips to the
    // disabled end-of-feed state.
    const ids = Array.from({ length: 45 }, (_, i) => i + 1);
    const items = Object.fromEntries(ids.map((id) => [id, makeStory(id)]));
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(30);
    });
    const more = screen.getByRole('button', { name: /^more$/i });
    expect(more).toBeEnabled();
    await userEvent.click(more);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(45);
    });
    expect(
      screen.queryByRole('button', { name: /^more$/i }),
    ).not.toBeInTheDocument();
    const endBtn = screen.getByRole('button', { name: /no more stories/i });
    expect(endBtn).toBeDisabled();
  });

  it('grays out the footer button when the feed is exhausted instead of hiding it', async () => {
    // A short feed has nothing more to load, but the footer button stays
    // visible as a disabled "No more stories" affordance so reaching the
    // end is explicit feedback rather than a vanished control.
    const ids = Array.from({ length: 12 }, (_, i) => i + 1);
    const items = Object.fromEntries(ids.map((id) => [id, makeStory(id)]));
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(12);
    });
    // No tappable "More" — the next-page action isn't available.
    expect(
      screen.queryByRole('button', { name: /^more$/i }),
    ).not.toBeInTheDocument();
    // …but the grayed end-of-feed button is present and disabled.
    const endBtn = screen.getByRole('button', { name: /no more stories/i });
    expect(endBtn).toBeDisabled();
  });

  it('refetches the feed on mount when a populated cache would otherwise be considered fresh', async () => {
    // Regression: after a browser reload, PersistQueryClient hydrates the
    // React Query cache from localStorage. With the app-wide staleTime of
    // 5 minutes, the seeded data is still "fresh", so without an
    // explicit refetchOnMount override the UI would paint yesterday's
    // story list indefinitely. This test seeds stale data under that same
    // staleTime and asserts the fresh list replaces it.
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 60_000, staleTime: 5 * 60_000 },
      },
    });
    client.setQueryData(
      ['storyIds', 'top'],
      [1, 2],
    );
    client.setQueryData(['feedItems', 'top'], {
      pages: [
        [
          makeStory(1, { title: 'Stale One' }),
          makeStory(2, { title: 'Stale Two' }),
        ],
      ],
      pageParams: [0],
    });

    installHNFetchMock({
      feeds: { topstories: [3, 4] },
      items: {
        3: makeStory(3, { title: 'Fresh Three' }),
        4: makeStory(4, { title: 'Fresh Four' }),
      },
    });

    renderWithProviders(<StoryList feed="top" />, { client });

    await waitFor(() => {
      expect(screen.getByText('Fresh Three')).toBeInTheDocument();
    });
    expect(screen.queryByText('Stale One')).not.toBeInTheDocument();
  });

  it('filters out deleted and dead items', async () => {
    const ids = [1, 2, 3];
    const items = {
      1: makeStory(1, { title: 'Good' }),
      2: makeStory(2, { deleted: true }),
      3: makeStory(3, { dead: true }),
    };
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(1);
    });
    expect(screen.getByText('Good')).toBeInTheDocument();
  });

  it('the row Hot pill honors the user\'s Hot customize panel overrides via StoryListImpl\'s hoisted useHotThresholds', async () => {
    // Big-story-only row: score 250, descendants 150, 30h old so the
    // velocity branch (250 / 30h ≈ 8.3/h) misses the 15/h default.
    // Under default thresholds the Top branch flags it, under
    // `topEnabled: false` it shouldn't.
    const story = makeStory(1, {
      title: 'big-story-from-top',
      score: 250,
      descendants: 150,
      time: Math.floor(Date.now() / 1000) - 30 * 60 * 60,
    });
    installHNFetchMock({ feeds: { topstories: [1] }, items: { 1: story } });

    setStoredHotThresholds(
      { ...DEFAULT_HOT_THRESHOLDS, topEnabled: false },
      Date.now(),
    );
    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getByText('big-story-from-top')).toBeInTheDocument();
    });
    // Pill is suppressed because the user disabled the Top branch.
    expect(screen.queryByTestId('story-hot')).toBeNull();
  });

  it('long-press menu marks an opened row unread', async () => {
    const ids = [1];
    const items = {
      1: makeStory(1, { title: 'Opened story', descendants: 7 }),
    };
    installHNFetchMock({ feeds: { topstories: ids }, items });
    window.localStorage.setItem(
      'newshacker:openedStoryIds',
      JSON.stringify([
        {
          id: 1,
          at: Date.now(),
          articleAt: Date.now(),
          commentsAt: Date.now(),
          seenCommentCount: 5,
        },
      ]),
    );

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getByText('Opened story')).toBeInTheDocument();
    });
    vi.useFakeTimers();
    const row = screen.getByTestId('story-row');
    const evt = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.assign(evt, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 100,
      clientY: 100,
      button: 0,
      isPrimary: true,
    });
    act(() => {
      row.dispatchEvent(evt);
      vi.advanceTimersByTime(600);
    });
    const markUnread = screen.getByTestId('story-row-menu-mark-unread');
    fireEvent.click(markUnread);
    const stored = window.localStorage.getItem('newshacker:openedStoryIds');
    expect(stored).toBe('[]');
    vi.useRealTimers();
  });
});

describe('<StoryListImpl> feed refresh status', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // StoryListImpl pulls in useAuth (/api/me) and the off-feed pinned
    // refresh; a stub fetch keeps those from hitting the network.
    installHNFetchMock({});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  function makeFeedItems(
    overrides: Partial<FeedItemsState> = {},
  ): FeedItemsState {
    return {
      items: [makeStory(1)],
      allIds: [1],
      totalIds: 1,
      isPending: false,
      isError: false,
      isFetchingMore: false,
      hasMore: false,
      isRefreshing: false,
      refreshFailed: false,
      loadMore: () => {},
      refetch: async () => undefined,
      dataUpdatedAt: 0,
      ...overrides,
    };
  }

  it('shows a checking indicator while a background refresh is in flight', async () => {
    renderWithProviders(
      <StoryListImpl
        feedItems={makeFeedItems({ isRefreshing: true })}
        sourceFeed="top"
        hotThresholds={DEFAULT_HOT_THRESHOLDS}
      />,
    );
    const status = await screen.findByTestId('feed-refresh');
    expect(status).toHaveTextContent(/checking for new stories/i);
    expect(
      screen.queryByRole('button', { name: /retry/i }),
    ).not.toBeInTheDocument();
  });

  it('surfaces a retry affordance when the refresh failed over cached data', async () => {
    // Regression for the silent-staleness bug: opening the app after a
    // while showed weeks-old rows with no hint the refresh had failed.
    const refetch = vi.fn(async () => undefined);
    renderWithProviders(
      <StoryListImpl
        feedItems={makeFeedItems({ refreshFailed: true, refetch })}
        sourceFeed="top"
        hotThresholds={DEFAULT_HOT_THRESHOLDS}
      />,
    );
    const status = await screen.findByTestId('feed-refresh');
    expect(status).toHaveTextContent(/couldn’t load new stories/i);
    // The stale rows are still on screen — we don't blank the feed.
    expect(screen.getByTestId('story-row')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('drops the Retry button and says Offline when the refresh failed offline', async () => {
    // A Retry while offline is guaranteed to fail, and the reconnect path
    // (refetchOnReconnect + the tracker's recovery probe) already refetches
    // automatically — so the footer states the situation instead of
    // offering a dead button. Mirrors the thread page's
    // no-retry-while-offline rule.
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: false,
    });
    _resetNetworkStatusForTests();
    try {
      renderWithProviders(
        <StoryListImpl
          feedItems={makeFeedItems({ refreshFailed: true })}
          sourceFeed="top"
          hotThresholds={DEFAULT_HOT_THRESHOLDS}
        />,
      );
      const status = await screen.findByTestId('feed-refresh');
      expect(status).toHaveTextContent(/offline — showing cached stories/i);
      expect(
        screen.queryByRole('button', { name: /retry/i }),
      ).not.toBeInTheDocument();
      // The cached rows stay on screen.
      expect(screen.getByTestId('story-row')).toBeInTheDocument();
    } finally {
      Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        value: true,
      });
      _resetNetworkStatusForTests();
    }
  });

  it('renders no status strip when the feed is fresh', async () => {
    renderWithProviders(
      <StoryListImpl
        feedItems={makeFeedItems()}
        sourceFeed="top"
        hotThresholds={DEFAULT_HOT_THRESHOLDS}
      />,
    );
    await screen.findByTestId('story-row');
    expect(screen.queryByTestId('feed-refresh')).not.toBeInTheDocument();
  });

  // Regression: while `feedItems.isPending` is true and no items have
  // arrived, the skeleton stays on screen — without this guard the
  // "No stories yet." empty state would flash on first paint during
  // PersistQueryClientProvider rehydration (when `isLoading` is false
  // because the query is paused-but-not-fetching) and during any
  // other paused-with-no-data window.
  it('shows the loading skeleton (not the empty state) while the feed is pending with no items', () => {
    renderWithProviders(
      <StoryListImpl
        feedItems={makeFeedItems({
          items: [],
          allIds: [],
          totalIds: 0,
          isPending: true,
        })}
        sourceFeed="top"
        hotThresholds={DEFAULT_HOT_THRESHOLDS}
      />,
    );
    expect(screen.queryByText(/No stories yet\./)).toBeNull();
    expect(
      screen.getByLabelText('Loading stories'),
    ).toHaveAttribute('aria-busy', 'true');
  });
});
