import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { PinnedPage } from './PinnedPage';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { addPinnedId } from '../lib/pinnedStories';

describe('<PinnedPage>', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('shows an empty state when nothing is pinned', () => {
    installHNFetchMock({ items: {} });
    renderWithProviders(<PinnedPage />);
    expect(screen.getByText(/Nothing pinned yet/i)).toBeInTheDocument();
  });

  it('shows pinned stories', async () => {
    installHNFetchMock({
      items: {
        1: makeStory(1, { title: 'Alpha' }),
        2: makeStory(2, { title: 'Beta' }),
      },
    });
    addPinnedId(1);
    addPinnedId(2);

    renderWithProviders(<PinnedPage />);

    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });
  });

  it('tapping the pin button unpins and removes the row', async () => {
    installHNFetchMock({
      items: { 5: makeStory(5, { title: 'Five' }) },
    });
    addPinnedId(5);

    renderWithProviders(<PinnedPage />);
    await waitFor(() => {
      expect(screen.getByText('Five')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(screen.getByTestId('pin-btn'));
    });

    await waitFor(() => {
      expect(screen.queryByText('Five')).toBeNull();
    });

    const stored = window.localStorage.getItem('newshacker:pinnedStoryIds');
    const parsed = stored
      ? (JSON.parse(stored) as Array<{ id: number; deleted?: true }>)
      : [];
    expect(parsed.filter((e) => !e.deleted)).toEqual([]);
  });

  it('orders pinned stories newest first by pin time', async () => {
    installHNFetchMock({
      items: {
        1: makeStory(1, { title: 'One' }),
        2: makeStory(2, { title: 'Two' }),
      },
    });
    const now = Date.now();
    addPinnedId(1, now - 2000);
    addPinnedId(2, now - 1000);

    renderWithProviders(<PinnedPage />);
    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });
    const rows = screen.getAllByTestId('story-row');
    expect(rows[0]).toHaveTextContent('Two');
    expect(rows[1]).toHaveTextContent('One');
  });
});
