import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { StoryList } from './StoryList';
import { AppHeader } from './AppHeader';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { addHiddenId } from '../lib/hiddenStories';
import { addPinnedId, getPinnedIds } from '../lib/pinnedStories';

function dispatchPointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientX: number,
  clientY: number,
) {
  const evt = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(evt, {
    pointerId: 1,
    pointerType: 'touch',
    clientX,
    clientY,
    button: 0,
    isPrimary: true,
  });
  act(() => {
    target.dispatchEvent(evt);
  });
}

describe('<StoryList> hidden-story handling', () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(Element.prototype, 'setPointerCapture', {
      value: vi.fn(),
      configurable: true,
    });
    Element.prototype.getBoundingClientRect = function () {
      return {
        width: 300,
        height: 72,
        top: 0,
        left: 0,
        right: 300,
        bottom: 72,
        x: 0,
        y: 0,
        toJSON() {},
      } as DOMRect;
    };
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('filters out stories whose ids are already in localStorage', async () => {
    const ids = [1, 2, 3];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });
    addHiddenId(2);

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });
    expect(screen.queryByText('Story 2')).toBeNull();
    expect(screen.getByText('Story 1')).toBeInTheDocument();
    expect(screen.getByText('Story 3')).toBeInTheDocument();
  });

  it('hides a story after a swipe past the threshold and persists the id', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const ids = [10, 20, 30];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });

    const rows = screen.getAllByTestId('story-row');
    const target = rows[1]; // Story 20

    dispatchPointer(target, 'pointerdown', 20, 50);
    dispatchPointer(target, 'pointermove', 180, 50);
    dispatchPointer(target, 'pointerup', 180, 50);

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    await waitFor(() => {
      expect(screen.queryByText('Story 20')).toBeNull();
    });
    expect(screen.getAllByTestId('story-row')).toHaveLength(2);

    const stored = window.localStorage.getItem('newshacker:hiddenStoryIds');
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored as string) as Array<{ id: number; at: number }>;
    expect(parsed.map((e) => e.id)).toContain(20);
  });

  it('undo restores the single story hidden by a swipe', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const ids = [10, 20, 30];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(
      <>
        <AppHeader />
        <StoryList feed="top" />
      </>,
      { route: '/top' },
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });

    expect(screen.getByTestId('undo-btn')).toBeDisabled();

    const target = screen.getAllByTestId('story-row')[1]; // Story 20

    dispatchPointer(target, 'pointerdown', 20, 50);
    dispatchPointer(target, 'pointermove', 180, 50);
    dispatchPointer(target, 'pointerup', 180, 50);

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    await waitFor(() => {
      expect(screen.queryByText('Story 20')).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId('undo-btn')).not.toBeDisabled();
    });

    fireEvent.click(screen.getByTestId('undo-btn'));

    await waitFor(() => {
      expect(screen.getByText('Story 20')).toBeInTheDocument();
    });
    expect(screen.getByTestId('undo-btn')).toBeDisabled();
    const stored = window.localStorage.getItem('newshacker:hiddenStoryIds');
    const parsed = stored
      ? (JSON.parse(stored) as Array<{ id: number; deleted?: true }>)
      : [];
    // Undo writes a tombstone for sync propagation; check the live set.
    const live = parsed.filter((e) => !e.deleted).map((e) => e.id);
    expect(live).not.toContain(20);
  });

  // Regression: Pin is a shield against Hide. A pinned row can't be
  // hidden by swipe-right — the story stays visible, still pinned,
  // and the undo button stays disabled because no hide ever happened.
  // Pinned exits via Done or Unpin, not via the hide gestures.
  it('swipe-right on a pinned row is a no-op; the pin is preserved', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const ids = [10, 20, 30];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });
    addPinnedId(20);

    renderWithProviders(
      <>
        <AppHeader />
        <StoryList feed="top" />
      </>,
      { route: '/top' },
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });
    expect(getPinnedIds().has(20)).toBe(true);
    expect(screen.getByTestId('undo-btn')).toBeDisabled();

    const target = screen.getAllByTestId('story-row')[1]; // Story 20 (pinned)
    dispatchPointer(target, 'pointerdown', 20, 50);
    dispatchPointer(target, 'pointermove', 180, 50);
    dispatchPointer(target, 'pointerup', 180, 50);

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    // Row is still there, still pinned, nothing hidden, nothing to undo.
    expect(screen.getByText('Story 20')).toBeInTheDocument();
    expect(getPinnedIds().has(20)).toBe(true);
    const stored = window.localStorage.getItem('newshacker:hiddenStoryIds');
    expect(stored).toBeFalsy();
    expect(screen.getByTestId('undo-btn')).toBeDisabled();
  });

  // The swipe gesture on a pinned row still tracks the finger and
  // snaps back on release — "rubber-band" feedback rather than
  // silent absorption. This is what makes the shield feel
  // responsive: the reader sees the row acknowledge the gesture,
  // then refuse it. The refusal comes for free from
  // useSwipeToDismiss's existing path — on release, `onSwipeRight`
  // is `undefined` for pinned rows (see StoryListItem), so the
  // commit branch is skipped and the hook runs its own snap-back
  // (`setOffset(0)` + the CSS transition).
  it('rubber-bands on swipe-right on a pinned row: tracks finger during drag, snaps back on release', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const ids = [10, 20, 30];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });
    addPinnedId(20);

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });

    const target = screen.getAllByTestId('story-row')[1]; // Story 20 (pinned)

    dispatchPointer(target, 'pointerdown', 20, 50);
    dispatchPointer(target, 'pointermove', 180, 50);
    // Mid-drag: the row should be translated by roughly the finger
    // delta (160px) and carry the dragging class — that's the
    // visible rubber-band response.
    const midDragStyle = target.getAttribute('style') ?? '';
    expect(midDragStyle).toMatch(/translate3d\(160px/);
    expect(target.className).toContain('story-row--dragging');

    dispatchPointer(target, 'pointerup', 180, 50);
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    // After release: offset snaps to 0, dragging class is gone.
    const postStyle = target.getAttribute('style') ?? '';
    expect(postStyle).not.toMatch(/translate3d\(160px/);
    expect(target.className).not.toContain('story-row--dragging');
  });

  // Regression for the originally reported bug: legacy storage can
  // carry a pin ∩ hidden pair from before the shield rule. Off-feed
  // pinned rendering must filter that pair out so it doesn't render
  // on the home feed. The one-shot migration (see hiddenStories.ts)
  // also drops the pin, but this filter is defense-in-depth for the
  // brief window before the migration runs and for any sync-induced
  // collision. We stub the migration marker to skip the migration
  // here so the test exercises the filter path in isolation.
  it("off-feed pinned doesn't render a story that's also hidden", async () => {
    const feedIds = [1, 2, 3];
    const items = Object.fromEntries(
      [...feedIds, 42].map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: feedIds }, items });
    window.localStorage.setItem(
      'newshacker:pinHideCollisionMigrated',
      'true',
    );
    addPinnedId(42);
    addHiddenId(42);
    // Both stores now carry 42 — the collision the filter must resolve.
    expect(getPinnedIds().has(42)).toBe(true);

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });
    expect(screen.queryByText('Story 42')).toBeNull();
  });
});
