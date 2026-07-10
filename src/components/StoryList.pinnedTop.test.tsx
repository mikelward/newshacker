import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { StoryList } from './StoryList';
import { AppHeader } from './AppHeader';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { addPinnedId } from '../lib/pinnedStories';
import {
  installIntersectionObserverMock,
  setVisibilityForTest,
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

  it('pinning an in-feed row keeps it at its natural position (no jump to the top block)', async () => {
    // Regression: tapping pin on a body row used to yank it into the
    // top block under the reader's eye. The new behavior leaves it in
    // place — pinned, but at its natural feed position. Consolidation
    // is deferred to the next refetch, not the pin itself.
    const ids = [1, 2, 3, 4];
    const items = Object.fromEntries(
      ids.map((id) => [
        id,
        makeStory(id, { title: `Story ${id}` }),
      ]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(
      <>
        <AppHeader />
        <StoryList feed="top" />
      </>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(4);
    });

    // Pin the middle row. It must stay at index 2 (natural position),
    // not jump to index 0.
    const beforeRows = screen.getAllByTestId('story-row');
    const middleRow = beforeRows[2];
    expect(within(middleRow).getByTestId('story-title')).toHaveTextContent(
      'Story 3',
    );
    fireEvent.click(within(middleRow).getByTestId('pin-btn'));

    await waitFor(() => {
      expect(
        within(screen.getAllByTestId('story-row')[2]).getByTestId('pin-btn'),
      ).toHaveAttribute('aria-pressed', 'true');
    });
    const afterPinRows = screen.getAllByTestId('story-row');
    expect(afterPinRows).toHaveLength(4);
    const afterPinTitles = afterPinRows.map(
      (row) => row.querySelector('.story-row__title-text')?.textContent ?? '',
    );
    expect(afterPinTitles).toEqual([
      'Story 1',
      'Story 2',
      'Story 3',
      'Story 4',
    ]);
  });

  it('Sweep no longer consolidates in-body pins — nothing reorders under the reader', async () => {
    // New behavior (matching Readmo): a Sweep hides the unpinned rows
    // but leaves an in-session body pin exactly where it sits — it does
    // not snap up into the top block. To make "did it move?" observable,
    // keep an *unpinned* row above the pin alive through the Sweep by
    // marking it not-fully-visible (so it isn't sweepable). If the pin
    // consolidated it would jump above that survivor; it must not.
    const ids = [1, 2, 3, 4];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(
      <>
        <AppHeader />
        <StoryList feed="top" />
      </>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(4);
    });

    // Story 1 scrolls above the fold — not fully visible, so Sweep skips
    // it and it survives above the pin.
    const row1 = screen.getByText('Story 1').closest('li')!;
    act(() => {
      setVisibilityForTest(row1, 0);
    });

    // Pin Story 4 (the last body row). It stays at its natural index 3.
    const story4Row = () => screen.getByText('Story 4').closest('li')!;
    fireEvent.click(within(story4Row()).getByTestId('pin-btn'));
    await waitFor(() => {
      expect(within(story4Row()).getByTestId('pin-btn')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    // Sweep: Stories 2 and 3 (visible, unpinned) fade out. Story 1
    // (not fully visible) and Story 4 (pinned) survive.
    const sweep = screen.getByTestId('sweep-btn');
    await waitFor(() => {
      expect(sweep).not.toHaveAttribute('aria-disabled', 'true');
    });
    fireEvent.click(sweep);

    await waitFor(() => {
      expect(screen.queryByText('Story 2')).toBeNull();
      expect(screen.queryByText('Story 3')).toBeNull();
    });

    // Story 4 stayed in the body *below* the surviving Story 1 — it did
    // NOT consolidate into the top block above it.
    const titles = screen
      .getAllByTestId('story-row')
      .map(
        (row) => row.querySelector('.story-row__title-text')?.textContent ?? '',
      );
    expect(titles).toEqual(['Story 1', 'Story 4']);
  });

  it('a refetch consolidates an in-body pin into the top block — even when the data is byte-identical', async () => {
    // The moment consolidation now happens: a feed refetch (PTR /
    // focus / mount) releases every in-session hold so the pins surface
    // at the top. This must hold even when the refetch returns the exact
    // same ids and items — React Query's structural sharing keeps the
    // `items` array reference stable in that case, so consolidation is
    // keyed off the query's fetch timestamp, not array identity. (This
    // is the regression guard for the Codex "identical refetch" note.)
    // The pinned row also stays within the loaded window across the
    // refetch, yet still consolidates — the old rule only lifted it when
    // it *left* the window.
    const ids = [10, 20, 30];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: [...ids] }, items });

    const { client } = renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });

    // Pin Story 20 in body — stays at its natural index 1.
    const story20Row = () => screen.getByText('Story 20').closest('li')!;
    fireEvent.click(within(story20Row()).getByTestId('pin-btn'));
    await waitFor(() => {
      expect(within(story20Row()).getByTestId('pin-btn')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
    const titlesAfterPin = screen
      .getAllByTestId('story-row')
      .map(
        (row) => row.querySelector('.story-row__title-text')?.textContent ?? '',
      );
    expect(titlesAfterPin).toEqual(['Story 10', 'Story 20', 'Story 30']);

    // Refetch with no data change at all (same ids, same items). The
    // hold must still release and Story 20 snap to the top block.
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['storyIds', 'top'] });
      await client.invalidateQueries({ queryKey: ['feedItems', 'top'] });
    });

    await waitFor(() => {
      const titles = screen
        .getAllByTestId('story-row')
        .map(
          (row) =>
            row.querySelector('.story-row__title-text')?.textContent ?? '',
        );
      expect(titles).toEqual(['Story 20', 'Story 10', 'Story 30']);
    });
  });

  it('a pre-existing pin from a past session still surfaces in the top block on a fresh mount', async () => {
    // The in-session "stay in body" behavior only applies to the pin
    // the reader just made — pins carried over from a previous load
    // (or another device, via sync) should land at the top on first
    // paint exactly as before.
    addPinnedId(3);
    const ids = [1, 2, 3, 4];
    const items = Object.fromEntries(
      ids.map((id) => [
        id,
        makeStory(id, { title: `Story ${id}` }),
      ]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(4);
    });
    const titles = screen
      .getAllByTestId('story-row')
      .map(
        (row) => row.querySelector('.story-row__title-text')?.textContent ?? '',
      );
    expect(titles).toEqual(['Story 3', 'Story 1', 'Story 2', 'Story 4']);
  });

  it('unpinning a row pinned in-session drops the in-body marker, so re-pinning also stays in place', async () => {
    // Otherwise the second pin would silently route through a stale
    // "in body" marker the first pin left behind, and the row would
    // jump to the top block — the very behavior this change exists
    // to prevent.
    const ids = [10, 20, 30];
    const items = Object.fromEntries(
      ids.map((id) => [
        id,
        makeStory(id, { title: `Story ${id}` }),
      ]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });

    const story20 = () => screen.getByText('Story 20').closest('li')!;
    // Pin → unpin → pin sequence. After the final pin the row should
    // still be at index 1 (natural feed position), not lifted to top.
    fireEvent.click(within(story20()).getByTestId('pin-btn'));
    await waitFor(() => {
      expect(
        within(story20()).getByTestId('pin-btn'),
      ).toHaveAttribute('aria-pressed', 'true');
    });
    fireEvent.click(within(story20()).getByTestId('pin-btn'));
    await waitFor(() => {
      expect(
        within(story20()).getByTestId('pin-btn'),
      ).toHaveAttribute('aria-pressed', 'false');
    });
    fireEvent.click(within(story20()).getByTestId('pin-btn'));
    await waitFor(() => {
      expect(
        within(story20()).getByTestId('pin-btn'),
      ).toHaveAttribute('aria-pressed', 'true');
    });

    const titles = screen
      .getAllByTestId('story-row')
      .map(
        (row) => row.querySelector('.story-row__title-text')?.textContent ?? '',
      );
    expect(titles).toEqual(['Story 10', 'Story 20', 'Story 30']);
  });

  it('drops the stay-in-body marker when a pinned row leaves the loaded feed, so a later return goes to the top block', async () => {
    // Regression: pin a visible row → in-body marker set. Feed refresh
    // drops the row from `items` → it surfaces in the top block (good).
    // But the raw marker must also be GC'd, otherwise a *later* return
    // of that id to `items` (loadMore landed a fresh page, cross-device
    // sync brought the row back) silently re-routes the pin into the
    // body via the stale marker. The intent was "just pinned, here and
    // now"; once the row leaves the body it's no longer "here".
    const ids = [10, 20, 30];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    const fixtures: {
      feeds: { topstories: number[] };
      items: Record<number, ReturnType<typeof makeStory>>;
    } = { feeds: { topstories: [...ids] }, items };
    installHNFetchMock(fixtures);

    const { client } = renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });

    // Pin Story 20 in body — stays at its natural index 1 position.
    const story20Row = () => screen.getByText('Story 20').closest('li')!;
    fireEvent.click(within(story20Row()).getByTestId('pin-btn'));
    await waitFor(() => {
      expect(
        within(story20Row()).getByTestId('pin-btn'),
      ).toHaveAttribute('aria-pressed', 'true');
    });
    const titlesAfterPin = screen
      .getAllByTestId('story-row')
      .map(
        (row) => row.querySelector('.story-row__title-text')?.textContent ?? '',
      );
    expect(titlesAfterPin).toEqual(['Story 10', 'Story 20', 'Story 30']);

    // Refresh: HN no longer ranks Story 20 in the loaded window. It
    // moves to the top block (still pinned, just no longer in body).
    fixtures.feeds.topstories = [10, 30];
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['storyIds', 'top'] });
      await client.invalidateQueries({ queryKey: ['feedItems', 'top'] });
    });
    await waitFor(() => {
      const titles = screen
        .getAllByTestId('story-row')
        .map(
          (row) =>
            row.querySelector('.story-row__title-text')?.textContent ?? '',
        );
      expect(titles).toEqual(['Story 20', 'Story 10', 'Story 30']);
    });

    // Refresh again: Story 20 returns to the loaded feed window. The
    // stale "stay in body" marker must have been GC'd; 20 stays in the
    // top block instead of jumping back to its natural feed position.
    fixtures.feeds.topstories = [10, 20, 30];
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['storyIds', 'top'] });
      await client.invalidateQueries({ queryKey: ['feedItems', 'top'] });
    });
    await waitFor(() => {
      const titles = screen
        .getAllByTestId('story-row')
        .map(
          (row) =>
            row.querySelector('.story-row__title-text')?.textContent ?? '',
        );
      expect(titles).toEqual(['Story 20', 'Story 10', 'Story 30']);
    });
  });
});
