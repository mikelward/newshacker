import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { StoryList } from './StoryList';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';

describe('<StoryList>', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
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
    await userEvent.click(more);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(60);
    });

    await userEvent.click(screen.getByRole('button', { name: /^more$/i }));

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(90);
    });
  });

  it('hides the More button when the feed has 30 or fewer stories', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => i + 1);
    const items = Object.fromEntries(ids.map((id) => [id, makeStory(id)]));
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(12);
    });
    expect(screen.queryByRole('button', { name: /^more$/i })).not.toBeInTheDocument();
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
});
