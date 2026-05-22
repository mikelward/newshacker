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

describe('<StoryList> pinned-to-top block', () => {
  beforeEach(() => {
    window.localStorage.clear();
    installIntersectionObserverMock();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    uninstallIntersectionObserverMock();
  });

  it("prepends pinned stories that dropped off HN's top list", async () => {
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

  it('moves an in-feed pinned story to the top instead of duplicating it', async () => {
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
    // Rendered once, not duplicated...
    expect(screen.getAllByText('Eight')).toHaveLength(1);
    // ...and at the top, not at its natural feed position.
    const rows = screen.getAllByTestId('story-row');
    expect(within(rows[0]).getByTestId('story-title')).toHaveTextContent(
      'Eight',
    );
  });

  it('shows a pinned story on a not-yet-loaded page at the top before More', async () => {
    // The reported bug: a pinned story still in HN's id list but on the
    // second page (index >= PAGE_SIZE) used to stay hidden until the
    // reader tapped More. It should be reachable at the top immediately.
    const topIds = Array.from({ length: 31 }, (_, i) => i + 1); // ids 1..31
    const pageTwoId = 31; // index 30 — first item of page two
    addPinnedId(pageTwoId);
    const items: Record<number, ReturnType<typeof makeStory>> = {};
    for (const id of topIds) {
      items[id] = makeStory(id, {
        title: id === pageTwoId ? 'Page Two Pin' : `Story ${id}`,
      });
    }
    installHNFetchMock({ feeds: { topstories: topIds }, items });

    renderWithProviders(<StoryList feed="top" />);

    // Without tapping More, the pinned page-two story is at the top.
    await waitFor(() => {
      expect(screen.getByText('Page Two Pin')).toBeInTheDocument();
    });
    const rows = screen.getAllByTestId('story-row');
    expect(within(rows[0]).getByTestId('story-title')).toHaveTextContent(
      'Page Two Pin',
    );
    // Page one (30 stories) plus the pinned page-two story = 31 rows,
    // and the pin is not duplicated lower down.
    expect(rows).toHaveLength(31);
    expect(screen.getAllByText('Page Two Pin')).toHaveLength(1);
  });

  it('orders multiple off-feed pins oldest-pinned first', async () => {
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
      'Pin A',
      'Pin C',
      'Pin B',
      'Feed One',
      'Feed Two',
    ]);
  });

  it('does not prepend when there are no pins', async () => {
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

  it('renders pins even when the feed has no visible stories', async () => {
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
