import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { SavedPage } from './SavedPage';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { addSavedId } from '../lib/savedStories';

describe('<SavedPage>', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('shows an empty state when nothing is saved', () => {
    installHNFetchMock({ items: {} });
    renderWithProviders(<SavedPage />);
    expect(screen.getByText(/Nothing saved yet/i)).toBeInTheDocument();
  });

  it('shows saved stories', async () => {
    installHNFetchMock({
      items: {
        1: makeStory(1, { title: 'Alpha' }),
        2: makeStory(2, { title: 'Beta' }),
      },
    });
    addSavedId(1);
    addSavedId(2);

    renderWithProviders(<SavedPage />);

    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });
  });

  it('unsave removes the row and its saved record', async () => {
    installHNFetchMock({
      items: { 5: makeStory(5, { title: 'Five' }) },
    });
    addSavedId(5);

    renderWithProviders(<SavedPage />);
    await waitFor(() => {
      expect(screen.getByText('Five')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(screen.getByTestId('star-btn'));
    });

    await waitFor(() => {
      expect(screen.queryByText('Five')).toBeNull();
    });

    expect(window.localStorage.getItem('newshacker:savedStoryIds')).toBe(
      '[]',
    );
  });

  it('orders saved stories newest first by save time', async () => {
    installHNFetchMock({
      items: {
        1: makeStory(1, { title: 'One' }),
        2: makeStory(2, { title: 'Two' }),
      },
    });
    const now = Date.now();
    addSavedId(1, now - 2000);
    addSavedId(2, now - 1000);

    renderWithProviders(<SavedPage />);
    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });
    const rows = screen.getAllByTestId('story-row');
    expect(rows[0]).toHaveTextContent('Two');
    expect(rows[1]).toHaveTextContent('One');
  });
});
