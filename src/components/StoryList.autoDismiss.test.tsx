import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { StoryList, StoryListImpl } from './StoryList';
import { useFeedItems } from '../hooks/useStoryList';
import { DEFAULT_HOT_THRESHOLDS } from '../lib/hotThresholds';
import { getHiddenIds } from '../lib/hiddenStories';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { addPinnedId } from '../lib/pinnedStories';
import {
  HIDE_ON_SCROLL_CHANGE_EVENT,
  HIDE_ON_SCROLL_STORAGE_KEY,
  STICKY_BOTTOM_BAR_STORAGE_KEY,
} from '../lib/feedSettings';
import {
  installIntersectionObserverMock,
  setVisibilityForTest,
  uninstallIntersectionObserverMock,
} from '../test/intersectionObserver';

// Auto-dismiss-on-scroll (newshacker:hideOnScroll): an unpinned row is hidden
// the moment it scrolls off the top after having been fully visible. The IO mock
// reports an observed row as fully visible (ratio 1) on observe, then
// `setVisibilityForTest(li, 0)` simulates it scrolling fully out of view.

const liByText = (title: string): HTMLLIElement =>
  screen.getByText(title).closest('li') as HTMLLIElement;

function setup(ids: number[], { enabled }: { enabled: boolean }) {
  if (enabled) window.localStorage.setItem(HIDE_ON_SCROLL_STORAGE_KEY, '1');
  const items = Object.fromEntries(
    ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
  );
  installHNFetchMock({ feeds: { topstories: ids }, items });
  return renderWithProviders(<StoryList feed="top" />);
}

describe('<StoryList> auto-dismiss on scroll', () => {
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

  it('leaves rows alone when the setting is off (default)', async () => {
    setup([10, 20], { enabled: false });
    await waitFor(() =>
      expect(screen.getAllByTestId('story-row')).toHaveLength(2),
    );
    act(() => setVisibilityForTest(liByText('Story 10'), 0));
    await Promise.resolve();
    expect(screen.getByText('Story 10')).toBeInTheDocument();
  });

  it('hides an unpinned row once it scrolls off the top', async () => {
    setup([10, 20], { enabled: true });
    await waitFor(() =>
      expect(screen.getAllByTestId('story-row')).toHaveLength(2),
    );
    act(() => setVisibilityForTest(liByText('Story 10'), 0));
    await waitFor(() => expect(screen.queryByText('Story 10')).toBeNull());
    // The row the reader hasn't passed yet stays.
    expect(screen.getByText('Story 20')).toBeInTheDocument();
  });

  it('does not auto-dismiss in readOnly mode (the /tuning Preview)', async () => {
    // The /tuning Preview mounts StoryListImpl with readOnly and must never
    // mutate the reader's hidden store, even with hideOnScroll enabled.
    function ReadOnlyPreview() {
      const feedItems = useFeedItems('top');
      return (
        <StoryListImpl
          feedItems={feedItems}
          readOnly
          includeHidden
          sourceFeed="top"
          hotThresholds={DEFAULT_HOT_THRESHOLDS}
        />
      );
    }
    window.localStorage.setItem(HIDE_ON_SCROLL_STORAGE_KEY, '1');
    const items = Object.fromEntries(
      [10, 20].map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: [10, 20] }, items });
    renderWithProviders(<ReadOnlyPreview />);
    await waitFor(() =>
      expect(screen.getAllByTestId('story-row')).toHaveLength(2),
    );

    act(() => setVisibilityForTest(liByText('Story 10'), 0));
    await Promise.resolve();
    // Row stays and, crucially, the hidden store is untouched.
    expect(screen.getByText('Story 10')).toBeInTheDocument();
    expect(getHiddenIds().size).toBe(0);
  });

  const enable = () =>
    act(() => {
      window.localStorage.setItem(HIDE_ON_SCROLL_STORAGE_KEY, '1');
      window.dispatchEvent(new CustomEvent(HIDE_ON_SCROLL_CHANGE_EVENT));
    });

  it('does not retroactively hide rows scrolled past while the setting was off', async () => {
    setup([10, 20], { enabled: false });
    await waitFor(() =>
      expect(screen.getAllByTestId('story-row')).toHaveLength(2),
    );
    // Scroll Story 10 off the top WHILE off — it stays (not dismissed) but is now
    // above the viewport, out of inViewIds, and was never marked seen.
    act(() => setVisibilityForTest(liByText('Story 10'), 0));
    await Promise.resolve();
    expect(screen.getByText('Story 10')).toBeInTheDocument();

    // Enable — seeding from inViewIds excludes the already-passed Story 10.
    enable();
    // Replay its top-exit (as an observer recreation would): still not hidden.
    act(() => setVisibilityForTest(liByText('Story 10'), 0));
    await Promise.resolve();
    expect(screen.getByText('Story 10')).toBeInTheDocument();
  });

  it('applies to rows already fully visible when the setting is enabled', async () => {
    setup([10, 20], { enabled: false });
    await waitFor(() =>
      expect(screen.getAllByTestId('story-row')).toHaveLength(2),
    );
    // Story 10 is fully visible at the moment the reader enables the setting.
    enable();
    // Scrolling it off the top now dismisses it — the setting applies to what's
    // already on screen, not only to rows that enter view later.
    act(() => setVisibilityForTest(liByText('Story 10'), 0));
    await waitFor(() => expect(screen.queryByText('Story 10')).toBeNull());
  });

  it('shields a pinned row from auto-dismiss', async () => {
    addPinnedId(10);
    setup([10, 20], { enabled: true });
    await waitFor(() =>
      expect(screen.getAllByTestId('story-row')).toHaveLength(2),
    );
    act(() => setVisibilityForTest(liByText('Story 10'), 0));
    await Promise.resolve();
    expect(screen.getByText('Story 10')).toBeInTheDocument();
  });

  it('restores the whole scroll burst with one Undo', async () => {
    setup([10, 20, 30], { enabled: true });
    await waitFor(() =>
      expect(screen.getAllByTestId('story-row')).toHaveLength(3),
    );

    act(() => setVisibilityForTest(liByText('Story 10'), 0));
    await waitFor(() => expect(screen.queryByText('Story 10')).toBeNull());
    act(() => setVisibilityForTest(liByText('Story 20'), 0));
    await waitFor(() => expect(screen.queryByText('Story 20')).toBeNull());

    // One Undo restores BOTH dismissed-by-scroll rows (same 2s batch).
    fireEvent.click(screen.getByTestId('undo-btn-bottom'));
    await waitFor(() => {
      expect(screen.getByText('Story 10')).toBeInTheDocument();
      expect(screen.getByText('Story 20')).toBeInTheDocument();
    });
  });

  it('scrolls back up to the topmost restored row when it is off-screen above the fold', async () => {
    const scrollToSpy = vi.fn();
    vi.stubGlobal('scrollTo', scrollToSpy);
    // The reader has scrolled down; restored rows remount above the fold
    // (negative rect.top), so Undo pulls the viewport back up. The stub reports
    // every element's bottom as 0, so the sticky-chrome inset is 0 and the
    // target is rect.top + scrollY − inset = -500 + 1000.
    Object.defineProperty(window, 'scrollY', { value: 1000, configurable: true });
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        top: -500,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);

    try {
      setup([10, 20, 30], { enabled: true });
      await waitFor(() =>
        expect(screen.getAllByTestId('story-row')).toHaveLength(3),
      );

      act(() => setVisibilityForTest(liByText('Story 10'), 0));
      await waitFor(() => expect(screen.queryByText('Story 10')).toBeNull());
      act(() => setVisibilityForTest(liByText('Story 20'), 0));
      await waitFor(() => expect(screen.queryByText('Story 20')).toBeNull());

      scrollToSpy.mockClear();
      fireEvent.click(screen.getByTestId('undo-btn-bottom'));
      await waitFor(() =>
        expect(screen.getByText('Story 10')).toBeInTheDocument(),
      );
      await waitFor(() =>
        expect(scrollToSpy).toHaveBeenCalledWith({
          top: 500,
          behavior: 'smooth',
        }),
      );
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('does not scroll on Undo when the restored row is already on screen', async () => {
    const scrollToSpy = vi.fn();
    vi.stubGlobal('scrollTo', scrollToSpy);
    // Restored row sits below the (zero-inset) sticky chrome — fully on screen —
    // so the "only if off-screen" guard leaves the viewport alone.
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        top: 120,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);

    try {
      setup([10, 20], { enabled: true });
      await waitFor(() =>
        expect(screen.getAllByTestId('story-row')).toHaveLength(2),
      );

      act(() => setVisibilityForTest(liByText('Story 10'), 0));
      await waitFor(() => expect(screen.queryByText('Story 10')).toBeNull());

      scrollToSpy.mockClear();
      fireEvent.click(screen.getByTestId('undo-btn-bottom'));
      await waitFor(() =>
        expect(screen.getByText('Story 10')).toBeInTheDocument(),
      );
      expect(scrollToSpy).not.toHaveBeenCalled();
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('consumes the undo-scroll request so a later auto-dismiss does not re-scroll', async () => {
    const scrollToSpy = vi.fn();
    vi.stubGlobal('scrollTo', scrollToSpy);
    Object.defineProperty(window, 'scrollY', { value: 1000, configurable: true });
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        top: -500,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);

    try {
      setup([10, 20, 30], { enabled: true });
      await waitFor(() =>
        expect(screen.getAllByTestId('story-row')).toHaveLength(3),
      );

      act(() => setVisibilityForTest(liByText('Story 10'), 0));
      await waitFor(() => expect(screen.queryByText('Story 10')).toBeNull());

      fireEvent.click(screen.getByTestId('undo-btn-bottom'));
      await waitFor(() =>
        expect(screen.getByText('Story 10')).toBeInTheDocument(),
      );
      await waitFor(() => expect(scrollToSpy).toHaveBeenCalled());

      // The request is one-shot: a later auto-dismiss (which changes the rendered
      // list again) must NOT trigger another undo-scroll.
      scrollToSpy.mockClear();
      act(() => setVisibilityForTest(liByText('Story 30'), 0));
      await waitFor(() => expect(screen.queryByText('Story 30')).toBeNull());
      expect(scrollToSpy).not.toHaveBeenCalled();
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('does not let two feeds share an undo batch (unique burst keys)', async () => {
    window.localStorage.setItem(HIDE_ON_SCROLL_STORAGE_KEY, '1');
    const items = {
      10: makeStory(10, { title: 'Top 10' }),
      20: makeStory(20, { title: 'Top 20' }),
      30: makeStory(30, { title: 'New 30' }),
      40: makeStory(40, { title: 'New 40' }),
    };
    installHNFetchMock({
      feeds: { topstories: [10, 20], newstories: [30, 40] },
      items,
    });
    renderWithProviders(
      <>
        <StoryList feed="top" />
        <StoryList feed="new" />
      </>,
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('story-row')).toHaveLength(4),
    );

    // Dismiss one story on each feed — separate StoryListImpl mounts whose
    // per-list batch counters both start at 0.
    act(() => setVisibilityForTest(liByText('Top 10'), 0));
    await waitFor(() => expect(screen.queryByText('Top 10')).toBeNull());
    act(() => setVisibilityForTest(liByText('New 30'), 0));
    await waitFor(() => expect(screen.queryByText('New 30')).toBeNull());

    // One Undo restores only the most recent burst (New 30); Top 10 — a
    // different feed's earlier burst — must stay hidden.
    fireEvent.click(screen.getAllByTestId('undo-btn-bottom')[0]);
    await waitFor(() => expect(screen.getByText('New 30')).toBeInTheDocument());
    expect(screen.queryByText('Top 10')).toBeNull();
  });
});

describe('<StoryList> sticky bottom toolbar', () => {
  beforeEach(() => {
    window.localStorage.clear();
    installIntersectionObserverMock();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    uninstallIntersectionObserverMock();
  });

  const footer = () =>
    document.querySelector('.story-list__footer--feed') as HTMLElement;

  it('flows at the end of the list by default (not sticky)', async () => {
    setup([10, 20], { enabled: false });
    await waitFor(() =>
      expect(screen.getAllByTestId('story-row')).toHaveLength(2),
    );
    expect(footer()).not.toHaveClass('story-list__footer--sticky');
  });

  it('pins to the viewport foot when the setting is on', async () => {
    window.localStorage.setItem(STICKY_BOTTOM_BAR_STORAGE_KEY, '1');
    setup([10, 20], { enabled: false });
    await waitFor(() =>
      expect(screen.getAllByTestId('story-row')).toHaveLength(2),
    );
    expect(footer()).toHaveClass('story-list__footer--sticky');
  });
});
