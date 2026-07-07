import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { StoryList } from './StoryList';
import { AppHeader } from './AppHeader';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { addPinnedId } from '../lib/pinnedStories';
import { PULL_TO_REFRESH_TRIGGER_PX } from './PullToRefresh';
import {
  installIntersectionObserverMock,
  setVisibilityForTest,
  uninstallIntersectionObserverMock,
} from '../test/intersectionObserver';

// Drive a real pull-to-refresh gesture — the explicit "show me the latest"
// action that full-materializes the frozen feed set.
function pullToRefresh() {
  const wrap = screen.getByTestId('pull-to-refresh');
  const y = 100 + PULL_TO_REFRESH_TRIGGER_PX * 2 + 20;
  for (const [type, clientY] of [
    ['pointerdown', 100],
    ['pointermove', y],
    ['pointerup', y],
  ] as const) {
    const evt = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(evt, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 100,
      clientY,
      button: 0,
      isPrimary: true,
    });
    act(() => {
      wrap.dispatchEvent(evt);
    });
  }
}

function currentTitles(): string[] {
  return screen
    .getAllByTestId('story-row')
    .map((row) => row.querySelector('.story-row__title-text')?.textContent ?? '');
}

describe('<StoryList> pinned-to-top block', () => {
  beforeEach(() => {
    window.localStorage.clear();
    installIntersectionObserverMock();
    Object.defineProperty(Element.prototype, 'setPointerCapture', {
      value: vi.fn(),
      configurable: true,
    });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
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
      expect(sweep).not.toBeDisabled();
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

  it('pull-to-refresh consolidates an in-body pin into the top block — even when the data is byte-identical', async () => {
    // Consolidation is a *full materialize* moment: pull-to-refresh (the
    // explicit "show me the latest" gesture) lifts every in-body pin into
    // the top block. This must hold even when the refetch returns the exact
    // same ids and items — React Query's structural sharing keeps the
    // `items` array reference stable, so the materialize is keyed off the
    // fetch landing (dataUpdatedAt), not array identity. (Regression guard
    // for the Codex "identical refetch" note.)
    const ids = [10, 20, 30];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: [...ids] }, items });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });

    // Pin Story 20 in body — stays at its natural index 1 (no jump).
    const story20Row = () => screen.getByText('Story 20').closest('li')!;
    fireEvent.click(within(story20Row()).getByTestId('pin-btn'));
    await waitFor(() => {
      expect(within(story20Row()).getByTestId('pin-btn')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
    expect(currentTitles()).toEqual(['Story 10', 'Story 20', 'Story 30']);

    // Pull to refresh: same ids, same items — yet Story 20 consolidates to
    // the top block.
    pullToRefresh();
    await waitFor(() => {
      expect(currentTitles()).toEqual(['Story 20', 'Story 10', 'Story 30']);
    });
  });

  it('a background refetch does not reflow the frozen set — an in-body pin holds until pull-to-refresh', async () => {
    // The frozen model: a background refetch (focus / mount / invalidate)
    // refreshes row *content* but must not reorder the set. A pin made in
    // the body keeps its natural position across such a refetch — only an
    // explicit pull-to-refresh (or a ≥6h return) consolidates it to the
    // top. This is the deliberate reversal of the old "any refetch
    // consolidates" rule.
    const ids = [10, 20, 30];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: [...ids] }, items });

    const { client } = renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });

    const story20Row = () => screen.getByText('Story 20').closest('li')!;
    fireEvent.click(within(story20Row()).getByTestId('pin-btn'));
    await waitFor(() => {
      expect(within(story20Row()).getByTestId('pin-btn')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
    expect(currentTitles()).toEqual(['Story 10', 'Story 20', 'Story 30']);

    // A background refetch lands — the set must stay frozen (no reorder).
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['storyIds', 'top'] });
      await client.invalidateQueries({ queryKey: ['feedItems', 'top'] });
    });
    expect(currentTitles()).toEqual(['Story 10', 'Story 20', 'Story 30']);

    // Now pull-to-refresh: the pin consolidates to the top block.
    pullToRefresh();
    await waitFor(() => {
      expect(currentTitles()).toEqual(['Story 20', 'Story 10', 'Story 30']);
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
});
