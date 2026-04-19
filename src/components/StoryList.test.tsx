import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('renders 90 items then silently prefetches page 2 to 120, with Load more for page 3', async () => {
    const ids = Array.from({ length: 180 }, (_, i) => i + 1);
    const items = Object.fromEntries(ids.map((id) => [id, makeStory(id)]));
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(<StoryList feed="top" />);

    // Page 1 (90 items) lands first, then the silent prefetch bumps the
    // visible list to 120. waitFor settles on the final count.
    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(120);
    });

    const loadMore = screen.getByRole('button', { name: /load more/i });
    await userEvent.click(loadMore);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(150);
    });
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
