import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { StoryList } from './StoryList';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { addPinnedId } from '../lib/pinnedStories';
import {
  installIntersectionObserverMock,
  uninstallIntersectionObserverMock,
} from '../test/intersectionObserver';

describe('<StoryList> off-feed pinned prepending', () => {
  beforeEach(() => {
    window.localStorage.clear();
    installIntersectionObserverMock();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    uninstallIntersectionObserverMock();
  });

  it('prepends pinned stories that dropped off HN\'s top list', async () => {
    const topIds = [1, 2, 3];
    // Pin a story that is no longer in the feed id list (e.g. dropped off
    // the HN front page). It should appear at the top of the list so the
    // reader can still reach it from the home view.
    addPinnedId(999);
    installHNFetchMock({
      feeds: { topstories: topIds },
      items: {
        1: makeStory(1, { title: 'Top One' }),
        2: makeStory(2, { title: 'Top Two' }),
        3: makeStory(3, { title: 'Top Three' }),
        999: makeStory(999, { title: 'Old Pin' }),
      },
    });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(4);
    });

    const rows = screen.getAllByTestId('story-row');
    expect(within(rows[0]).getByTestId('story-title')).toHaveTextContent(
      'Old Pin',
    );
    expect(within(rows[0]).getByTestId('pin-btn')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(rows[1]).getByTestId('story-title')).toHaveTextContent(
      'Top One',
    );
  });

  it('does not duplicate a pinned story that is already in the feed', async () => {
    const topIds = [7, 8, 9];
    addPinnedId(8);
    installHNFetchMock({
      feeds: { topstories: topIds },
      items: {
        7: makeStory(7, { title: 'Seven' }),
        8: makeStory(8, { title: 'Eight' }),
        9: makeStory(9, { title: 'Nine' }),
      },
    });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });
    expect(screen.getAllByText('Eight')).toHaveLength(1);
  });

  it('orders multiple off-feed pins newest-pinned first', async () => {
    addPinnedId(101, 1_000);
    addPinnedId(102, 3_000);
    addPinnedId(103, 2_000);
    installHNFetchMock({
      feeds: { topstories: [1, 2] },
      items: {
        1: makeStory(1, { title: 'Feed One' }),
        2: makeStory(2, { title: 'Feed Two' }),
        101: makeStory(101, { title: 'Pin A' }),
        102: makeStory(102, { title: 'Pin B' }),
        103: makeStory(103, { title: 'Pin C' }),
      },
    });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(5);
    });

    const titles = screen
      .getAllByTestId('story-row')
      .map(
        (row) => row.querySelector('.story-row__title-text')?.textContent ?? '',
      );
    expect(titles).toEqual([
      'Pin B',
      'Pin C',
      'Pin A',
      'Feed One',
      'Feed Two',
    ]);
  });

  it('does not prepend when there are no off-feed pins', async () => {
    installHNFetchMock({
      feeds: { topstories: [1, 2] },
      items: {
        1: makeStory(1, { title: 'One' }),
        2: makeStory(2, { title: 'Two' }),
      },
    });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });
  });

  it('renders off-feed pins even when the feed has no visible stories', async () => {
    addPinnedId(555);
    installHNFetchMock({
      feeds: { topstories: [] },
      items: {
        555: makeStory(555, { title: 'Only Pin' }),
      },
    });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(1);
    });
    expect(screen.getByText('Only Pin')).toBeInTheDocument();
    expect(screen.queryByTestId('empty-state')).toBeNull();
  });
});
