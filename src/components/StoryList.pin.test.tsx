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

    const rows = screen.getAllByTestId('story-row');
    const target = rows[0];
    const pin = within(target).getByTestId('pin-btn');
    expect(pin).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(pin);

    expect(pin).toHaveAttribute('aria-pressed', 'true');
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
    fireEvent.click(pin);
    expect(pin).toHaveAttribute('aria-pressed', 'false');
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
    expect(screen.getByTestId('sweep-btn')).toBeDisabled();
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
