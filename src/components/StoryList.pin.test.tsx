import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { StoryList } from './StoryList';
import { AppHeader } from './AppHeader';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { addPinnedId } from '../lib/pinnedStories';
import {
  getObserversForTest,
  installIntersectionObserverMock,
  setVisibilityForTest,
  uninstallIntersectionObserverMock,
} from '../test/intersectionObserver';

describe('<StoryList> pin and sweep', () => {
  beforeEach(() => {
    window.localStorage.clear();
    installIntersectionObserverMock();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    uninstallIntersectionObserverMock();
  });

  it('tapping a pin pins (and untaps unpins) without firing a toast', async () => {
    const ids = [10, 20];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });

    // Story 10 starts in the feed body (rows are id-ordered by the mock).
    const story10Row = () => screen.getByText('Story 10').closest('li')!;
    const pin = within(story10Row()).getByTestId('pin-btn');
    expect(pin).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(pin);

    // Pinning a body row keeps it in place (SPEC.md *Pinned stories
    // pinned to the top*) — the row stays at its natural feed
    // position, just marked pressed. Story 10 already happened to be
    // row 0 of the id-ordered mock feed, so its position doesn't
    // change either way.
    await waitFor(() => {
      expect(
        within(story10Row()).getByTestId('pin-btn'),
      ).toHaveAttribute('aria-pressed', 'true');
    });
    const rows = screen.getAllByTestId('story-row');
    expect(within(rows[0]).getByTestId('story-title')).toHaveTextContent(
      'Story 10',
    );
    const stored = window.localStorage.getItem('newshacker:pinnedStoryIds');
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored as string) as Array<{ id: number }>;
    expect(parsed.map((e) => e.id)).toContain(10);

    // The pin button is the single source of truth for pinned state, so we
    // never fire a pin/unpin toast.
    const toastHost = screen.queryByTestId('toast-host');
    if (toastHost) {
      expect(within(toastHost).queryByText(/pinned/i)).toBeNull();
    }

    // Tapping again unpins, still no toast, persistence matches.
    fireEvent.click(within(story10Row()).getByTestId('pin-btn'));
    await waitFor(() => {
      expect(
        within(story10Row()).getByTestId('pin-btn'),
      ).toHaveAttribute('aria-pressed', 'false');
    });
    const after = window.localStorage.getItem('newshacker:pinnedStoryIds');
    const afterParsed = after
      ? (JSON.parse(after) as Array<{ id: number; deleted?: true }>)
      : [];
    expect(afterParsed.filter((e) => !e.deleted)).toEqual([]);
  });

  it('sweep button hides unpinned stories and keeps pinned ones', async () => {
    const ids = [1, 2, 3, 4];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });
    addPinnedId(2);

    renderWithProviders(
      <>
        <AppHeader />
        <StoryList feed="top" />
      </>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(4);
    });

    const sweep = screen.getByTestId('sweep-btn');
    await waitFor(() => {
      expect(sweep).not.toBeDisabled();
    });
    expect(sweep).toHaveAccessibleName(/hide unpinned/i);

    fireEvent.click(sweep);

    await waitFor(() => {
      expect(screen.queryByText('Story 1')).toBeNull();
      expect(screen.queryByText('Story 3')).toBeNull();
      expect(screen.queryByText('Story 4')).toBeNull();
    });
    expect(screen.getByText('Story 2')).toBeInTheDocument();
    // Once nothing is left to sweep, the button stays put but disables.
    // The disabled state propagates through the feed-bar context, so it
    // can settle a tick after the swept rows leave the DOM.
    await waitFor(() => {
      expect(screen.getByTestId('sweep-btn')).toBeDisabled();
    });
  });

  it('sweep plays a single slide+fade on every unpinned row before removing them', async () => {
    const ids = [1, 2, 3];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });
    addPinnedId(2);

    renderWithProviders(
      <>
        <AppHeader />
        <StoryList feed="top" />
      </>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });

    const sweep = screen.getByTestId('sweep-btn');
    await waitFor(() => {
      expect(sweep).not.toBeDisabled();
    });
    fireEvent.click(sweep);

    // The hide is deferred until the sweep-out animation finishes, so
    // the unpinned rows stay in the DOM for a moment wearing the
    // animation class. The pinned row never gets the class.
    const unpinned1 = screen.getByText('Story 1').closest('li')!;
    const pinned = screen.getByText('Story 2').closest('li')!;
    const unpinned3 = screen.getByText('Story 3').closest('li')!;
    expect(unpinned1.className).toContain('story-list__item--sweeping');
    expect(unpinned3.className).toContain('story-list__item--sweeping');
    expect(pinned.className).not.toContain('story-list__item--sweeping');

    // Animation completes → rows actually hide.
    await waitFor(() => {
      expect(screen.queryByText('Story 1')).toBeNull();
      expect(screen.queryByText('Story 3')).toBeNull();
    });
    expect(screen.getByText('Story 2')).toBeInTheDocument();
  });

  it('sweep commits on animationend from a swept row (not just the fallback timer)', async () => {
    const ids = [1, 2];
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
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });

    const sweep = screen.getByTestId('sweep-btn');
    await waitFor(() => {
      expect(sweep).not.toBeDisabled();
    });
    fireEvent.click(sweep);

    // Dispatch a matching-name animationend on one of the swept rows.
    // The handler filters by `animationName === 'story-list__sweep-out'`
    // and commits once, so the whole batch hides immediately even
    // before the fallback timer has had a chance to fire.
    const row = screen.getByText('Story 1').closest('li')!;
    act(() => {
      const ev = new Event('animationend', { bubbles: true }) as AnimationEvent;
      Object.defineProperty(ev, 'animationName', {
        value: 'story-list__sweep-out',
      });
      row.dispatchEvent(ev);
    });

    await waitFor(() => {
      expect(screen.queryByTestId('story-row')).toBeNull();
    });
  });

  it('ignores a second sweep tap while the first is still animating', async () => {
    // A sweep defers its hide until the slide+fade finishes. Tapping sweep
    // again before that settles must be a no-op — the in-flight batch owns the
    // animation, and re-running with a since-changed sweepable set would
    // clobber the pending ids and hide rows the first tap never selected. Here
    // rows 3 and 4 are off-screen (not sweepable) at the first tap, then scroll
    // into view mid-animation; without the guard the second tap would sweep
    // them too.
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

    const row = (id: number) => screen.getByText(`Story ${id}`).closest('li')!;
    // Push stories 3 and 4 off-screen so only 1 and 2 are sweepable.
    act(() => {
      setVisibilityForTest(row(3), 0);
      setVisibilityForTest(row(4), 0);
    });

    const sweep = screen.getByTestId('sweep-btn-bottom');
    await waitFor(() => expect(sweep).not.toBeDisabled());
    fireEvent.click(sweep);

    // Stories 1 and 2 are now mid-animation; 3 and 4 scroll into view.
    expect(row(1).className).toContain('story-list__item--sweeping');
    act(() => {
      setVisibilityForTest(row(3), 1);
      setVisibilityForTest(row(4), 1);
    });

    // Second tap before the first settles — must be dropped, so 3 and 4 never
    // join the animation.
    fireEvent.click(screen.getByTestId('sweep-btn-bottom'));
    expect(row(3).className).not.toContain('story-list__item--sweeping');
    expect(row(4).className).not.toContain('story-list__item--sweeping');

    // Commit the in-flight sweep via a matching animationend on a swept row.
    act(() => {
      const ev = new Event('animationend', { bubbles: true }) as AnimationEvent;
      Object.defineProperty(ev, 'animationName', {
        value: 'story-list__sweep-out',
      });
      row(1).dispatchEvent(ev);
    });

    // Only the first batch left; 3 and 4 survived because their tap was ignored.
    await waitFor(() => {
      expect(screen.queryByText('Story 1')).toBeNull();
      expect(screen.queryByText('Story 2')).toBeNull();
    });
    expect(screen.getByText('Story 3')).toBeInTheDocument();
    expect(screen.getByText('Story 4')).toBeInTheDocument();
  });

  it('ignores a sweep tap during the cooldown right after a sweep commits', async () => {
    // A sweep keeps ignoring taps for a short beat after it commits, not just
    // during the slide-out — otherwise a rapid second tap clears rows that only
    // just settled into view. Stories 3 and 4 are off-screen at the first tap,
    // scroll in once it has committed, and the immediate second tap must be
    // dropped by the cooldown.
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

    const row = (id: number) => screen.getByText(`Story ${id}`).closest('li')!;
    act(() => {
      setVisibilityForTest(row(3), 0);
      setVisibilityForTest(row(4), 0);
    });

    const sweep = screen.getByTestId('sweep-btn-bottom');
    await waitFor(() => expect(sweep).not.toBeDisabled());
    fireEvent.click(sweep);

    // Let the first sweep fully commit via animationend (cooldown starts here).
    act(() => {
      const ev = new Event('animationend', { bubbles: true }) as AnimationEvent;
      Object.defineProperty(ev, 'animationName', {
        value: 'story-list__sweep-out',
      });
      row(1).dispatchEvent(ev);
    });
    await waitFor(() => {
      expect(screen.queryByText('Story 1')).toBeNull();
      expect(screen.queryByText('Story 2')).toBeNull();
    });

    // 3 and 4 scroll into view; an immediate second tap (within the cooldown)
    // must be dropped, so they survive.
    act(() => {
      setVisibilityForTest(row(3), 1);
      setVisibilityForTest(row(4), 1);
    });
    fireEvent.click(screen.getByTestId('sweep-btn-bottom'));

    expect(row(3).className).not.toContain('story-list__item--sweeping');
    expect(row(4).className).not.toContain('story-list__item--sweeping');
    expect(screen.getByText('Story 3')).toBeInTheDocument();
    expect(screen.getByText('Story 4')).toBeInTheDocument();
  });

  it('committing the pending sweep on unmount so navigation mid-animation is not dropped', async () => {
    const ids = [1, 2];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });

    const { unmount } = renderWithProviders(
      <>
        <AppHeader />
        <StoryList feed="top" />
      </>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });

    const sweep = screen.getByTestId('sweep-btn');
    await waitFor(() => {
      expect(sweep).not.toBeDisabled();
    });
    fireEvent.click(sweep);

    // Tear the list down mid-animation — before the animationend and
    // before the fallback timer. The cleanup must commit the hide so
    // the intent the user expressed with their tap survives the
    // navigation.
    act(() => {
      unmount();
    });

    const stored = window.localStorage.getItem('newshacker:hiddenStoryIds');
    const parsed = stored
      ? (JSON.parse(stored) as Array<{ id: number; deleted?: true }>)
      : [];
    const liveIds = parsed.filter((e) => !e.deleted).map((e) => e.id);
    expect(liveIds).toContain(1);
    expect(liveIds).toContain(2);
  });

  it('sweep skips the animation and delay when prefers-reduced-motion is set', async () => {
    const ids = [1, 2];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });

    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;

    try {
      renderWithProviders(
        <>
          <AppHeader />
          <StoryList feed="top" />
        </>,
      );

      await waitFor(() => {
        expect(screen.getAllByTestId('story-row')).toHaveLength(2);
      });

      const sweep = screen.getByTestId('sweep-btn');
      await waitFor(() => {
        expect(sweep).not.toBeDisabled();
      });
      fireEvent.click(sweep);

      // Reduced-motion path hides immediately — rows gone on the very
      // next render, and no row ever wore the sweeping class.
      await waitFor(() => {
        expect(screen.queryByTestId('story-row')).toBeNull();
      });
      expect(
        document.querySelector('.story-list__item--sweeping'),
      ).toBeNull();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('bottom-bar undo button mirrors the toolbar undo — same state, same action', async () => {
    // Pin one story so the list isn't empty after the sweep — otherwise
    // StoryListImpl's empty-state branch returns early and the footer
    // (including the bottom Undo button) doesn't render.
    const ids = [1, 2, 3];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });
    addPinnedId(2);

    renderWithProviders(
      <>
        <AppHeader />
        <StoryList feed="top" />
      </>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });

    // Pre-sweep: both undo entry points are disabled and labeled the same.
    const bottomUndo = screen.getByTestId('undo-btn-bottom');
    expect(bottomUndo).toBeDisabled();
    expect(bottomUndo).toHaveAccessibleName(/nothing to undo/i);

    // Sweep to record a hide-batch, then assert the bottom undo enables
    // alongside the toolbar undo.
    const sweep = screen.getByTestId('sweep-btn');
    await waitFor(() => {
      expect(sweep).not.toBeDisabled();
    });
    fireEvent.click(sweep);
    await waitFor(() => {
      expect(screen.queryByText('Story 1')).toBeNull();
      expect(screen.queryByText('Story 3')).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId('undo-btn-bottom')).not.toBeDisabled();
    });
    expect(screen.getByTestId('undo-btn-bottom')).toHaveAccessibleName(
      /undo hide/i,
    );
    expect(screen.getByTestId('undo-btn')).not.toBeDisabled();

    // The bottom button restores the same way the toolbar one does.
    fireEvent.click(screen.getByTestId('undo-btn-bottom'));
    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });
    // Both undo entry points disable together once there's nothing left.
    expect(screen.getByTestId('undo-btn-bottom')).toBeDisabled();
    expect(screen.getByTestId('undo-btn')).toBeDisabled();
  });

  it('bottom-bar sweep button mirrors the header sweep — same state, same action', async () => {
    const ids = [1, 2, 3, 4];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });
    addPinnedId(3);

    renderWithProviders(
      <>
        <AppHeader />
        <StoryList feed="top" />
      </>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(4);
    });

    const bottomSweep = screen.getByTestId('sweep-btn-bottom');
    await waitFor(() => {
      expect(bottomSweep).not.toBeDisabled();
    });
    expect(bottomSweep).toHaveAccessibleName(/hide unpinned/i);

    fireEvent.click(bottomSweep);

    await waitFor(() => {
      expect(screen.queryByText('Story 1')).toBeNull();
      expect(screen.queryByText('Story 2')).toBeNull();
      expect(screen.queryByText('Story 4')).toBeNull();
    });
    expect(screen.getByText('Story 3')).toBeInTheDocument();
    // Both sweep entry points disable together once nothing is left to hide.
    expect(screen.getByTestId('sweep-btn-bottom')).toBeDisabled();
    expect(screen.getByTestId('sweep-btn')).toBeDisabled();
  });

  it('sweep only hides rows fully in the viewport', async () => {
    const ids = [1, 2, 3];
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
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });

    // Simulate scrolling so Story 3 is only partially visible (behind the
    // app header, below the fold, whatever) — its intersectionRatio drops
    // below the "fully visible" threshold.
    const rows = screen.getAllByTestId('story-row');
    const partialRow = rows.find((r) => r.textContent?.includes('Story 3'))!;
    const partialLi = partialRow.closest('li')!;
    act(() => {
      setVisibilityForTest(partialLi, 0.4);
    });

    const sweep = screen.getByTestId('sweep-btn');
    await waitFor(() => {
      expect(sweep).not.toBeDisabled();
    });

    fireEvent.click(sweep);

    await waitFor(() => {
      expect(screen.queryByText('Story 1')).toBeNull();
      expect(screen.queryByText('Story 2')).toBeNull();
    });
    // The partially-visible row must stick around.
    expect(screen.getByText('Story 3')).toBeInTheDocument();
  });

  it('disables sweep when no row is fully visible', async () => {
    const ids = [1, 2];
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
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });

    act(() => {
      for (const row of screen.getAllByTestId('story-row')) {
        setVisibilityForTest(row.closest('li')!, 0.5);
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId('sweep-btn')).toBeDisabled();
    });
  });

  it('observes the fully-visible cutoff as a threshold so it fires on crossings', async () => {
    // The callback treats ratio >= 0.999 as visible; the observer must watch
    // that same value, or a row dropping from ~0.9995 to behind the sticky
    // header would never get a follow-up callback (no [0, 1] boundary crossed).
    installHNFetchMock({ feeds: { topstories: [1] }, items: { 1: makeStory(1) } });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(1);
    });

    const observed = getObserversForTest();
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.some((o) => o.thresholds.includes(0.999))).toBe(true);
  });

  it('disables the sweep button when the whole list is empty', async () => {
    installHNFetchMock({ feeds: { topstories: [] } });
    renderWithProviders(
      <>
        <AppHeader />
        <StoryList feed="top" />
      </>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    });
    expect(screen.getByTestId('sweep-btn')).toBeDisabled();
  });

  it('disables the sweep button when every story is pinned', async () => {
    const ids = [11, 22];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });
    addPinnedId(11);
    addPinnedId(22);

    renderWithProviders(
      <>
        <AppHeader />
        <StoryList feed="top" />
      </>,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });
    expect(screen.getByTestId('sweep-btn')).toBeDisabled();
  });

  it('undo button is disabled on load and enabled after a sweep; clicking it restores the batch', async () => {
    const ids = [1, 2, 3];
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
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });

    const undo = screen.getByTestId('undo-btn');
    expect(undo).toBeDisabled();
    expect(undo).toHaveAccessibleName(/nothing to undo/i);

    const sweep = screen.getByTestId('sweep-btn');
    await waitFor(() => {
      expect(sweep).not.toBeDisabled();
    });
    fireEvent.click(sweep);

    await waitFor(() => {
      expect(screen.queryByTestId('story-row')).toBeNull();
    });

    await waitFor(() => {
      expect(screen.getByTestId('undo-btn')).not.toBeDisabled();
    });
    expect(screen.getByTestId('undo-btn')).toHaveAccessibleName(/undo hide/i);

    fireEvent.click(screen.getByTestId('undo-btn'));

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });
    expect(screen.getByTestId('undo-btn')).toBeDisabled();
    const stored = window.localStorage.getItem('newshacker:hiddenStoryIds');
    const parsed = stored
      ? (JSON.parse(stored) as Array<{ id: number; deleted?: true }>)
      : [];
    // Undo writes tombstones rather than removing entries outright so
    // the tombstones can propagate to other devices via /api/sync.
    // Assert on the live set, not the raw storage.
    expect(parsed.filter((e) => !e.deleted)).toEqual([]);
  });
});
