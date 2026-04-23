import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { StoryList } from './StoryList';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { setFeedFilters } from '../lib/feedFilters';
import { markCommentsOpenedId } from '../lib/openedStories';

describe('<StoryList> header-bar filters', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('unreadOnly hides stories the reader has already opened', async () => {
    const ids = [1, 2, 3];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}`, score: 50 })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });
    markCommentsOpenedId(2);
    setFeedFilters({ unreadOnly: true, hotOnly: false });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });

    const titles = screen.getAllByTestId('story-title').map((el) => el.textContent);
    expect(titles.some((t) => t?.includes('Story 2'))).toBe(false);
    expect(titles.some((t) => t?.includes('Story 1'))).toBe(true);
    expect(titles.some((t) => t?.includes('Story 3'))).toBe(true);
  });

  it('hotOnly hides stories that do not meet the hot thresholds', async () => {
    // Story 1: score 200 (hot, any age). Story 2: score 5 (not hot).
    // Story 3: score 40 with recent time (hot via fast-rise rule).
    const nowS = Math.floor(Date.now() / 1000);
    const items = {
      1: makeStory(1, { title: 'Big old story', score: 200, time: nowS - 60 * 60 * 10 }),
      2: makeStory(2, { title: 'Small story', score: 5, time: nowS - 60 * 30 }),
      3: makeStory(3, { title: 'Fast riser', score: 40, time: nowS - 60 * 30 }),
    };
    installHNFetchMock({ feeds: { topstories: [1, 2, 3] }, items });
    setFeedFilters({ unreadOnly: false, hotOnly: true });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });
    const titles = screen.getAllByTestId('story-title').map((el) => el.textContent);
    expect(titles.some((t) => t?.includes('Big old story'))).toBe(true);
    expect(titles.some((t) => t?.includes('Fast riser'))).toBe(true);
    expect(titles.some((t) => t?.includes('Small story'))).toBe(false);
  });

  it('with both filters off, all score>1 stories show', async () => {
    const ids = [1, 2];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { score: 50 })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });
  });

  it('combined unread + hot only shows unread hot stories', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const items = {
      1: makeStory(1, { title: 'Hot read', score: 200, time: nowS - 60 * 60 * 5 }),
      2: makeStory(2, { title: 'Hot unread', score: 200, time: nowS - 60 * 60 * 5 }),
      3: makeStory(3, { title: 'Cold unread', score: 5, time: nowS - 60 * 60 * 5 }),
    };
    installHNFetchMock({ feeds: { topstories: [1, 2, 3] }, items });
    markCommentsOpenedId(1);
    setFeedFilters({ unreadOnly: true, hotOnly: true });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(1);
    });
    expect(screen.getByTestId('story-title').textContent).toContain('Hot unread');
  });
});
