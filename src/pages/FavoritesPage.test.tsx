import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { FavoritesPage } from './FavoritesPage';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { addFavoriteId } from '../lib/favorites';
import { ME_QUERY_KEY } from '../hooks/useAuth';
import { listQueue } from '../lib/hnFavoriteQueue';

describe('<FavoritesPage>', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('shows an empty state when nothing is favorited', () => {
    installHNFetchMock({ items: {} });
    renderWithProviders(<FavoritesPage />);
    expect(screen.getByText(/No favorites yet/i)).toBeInTheDocument();
  });

  it('shows favorited stories', async () => {
    installHNFetchMock({
      items: {
        1: makeStory(1, { title: 'Alpha' }),
        2: makeStory(2, { title: 'Beta' }),
      },
    });
    addFavoriteId(1);
    addFavoriteId(2);

    renderWithProviders(<FavoritesPage />);

    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });
  });

  it('Unfavorite removes the row and its favorite record', async () => {
    installHNFetchMock({
      items: { 5: makeStory(5, { title: 'Five' }) },
    });
    addFavoriteId(5);

    renderWithProviders(<FavoritesPage />);
    await waitFor(() => {
      expect(screen.getByText('Five')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /unfavorite/i }));
    });

    await waitFor(() => {
      expect(screen.queryByText('Five')).toBeNull();
    });

    // Remove now writes a tombstone (for sync); assert on the live
    // set rather than raw storage, which may hold tombstone entries.
    const stored = window.localStorage.getItem('newshacker:favoriteStoryIds');
    const parsed = stored
      ? (JSON.parse(stored) as Array<{ id: number; deleted?: true }>)
      : [];
    expect(parsed.filter((e) => !e.deleted)).toEqual([]);
  });

  it('enqueues the HN write-back when a signed-in user unfavorites', async () => {
    // Regression: the page used to call the raw store helper, so the
    // story stayed favorited on news.ycombinator.com forever.
    installHNFetchMock({
      items: { 5: makeStory(5, { title: 'Five' }) },
    });
    addFavoriteId(5);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    client.setQueryData(ME_QUERY_KEY, { username: 'alice' });

    renderWithProviders(<FavoritesPage />, { client });
    await waitFor(() => {
      expect(screen.getByText('Five')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /unfavorite/i }));
    });

    await waitFor(() => {
      expect(
        listQueue('alice').map((e) => ({ id: e.id, action: e.action })),
      ).toEqual([{ id: 5, action: 'unfavorite' }]);
    });
  });

  it('orders favorited stories newest first by favorite time', async () => {
    installHNFetchMock({
      items: {
        1: makeStory(1, { title: 'One' }),
        2: makeStory(2, { title: 'Two' }),
      },
    });
    const now = Date.now();
    addFavoriteId(1, now - 2000);
    addFavoriteId(2, now - 1000);

    renderWithProviders(<FavoritesPage />);
    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });
    const rows = screen.getAllByTestId('story-row');
    expect(rows[0]).toHaveTextContent('Two');
    expect(rows[1]).toHaveTextContent('One');
  });
});
