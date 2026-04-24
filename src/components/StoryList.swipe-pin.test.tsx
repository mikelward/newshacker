import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { StoryList } from './StoryList';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { addPinnedId, getPinnedEntries } from '../lib/pinnedStories';

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

describe('<StoryList> pin-on-left-swipe', () => {
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

  it('pins a story after a left swipe past the threshold and persists the id', async () => {
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

    // Left swipe: start high X, move to low X.
    dispatchPointer(target, 'pointerdown', 280, 50);
    dispatchPointer(target, 'pointermove', 120, 50);
    dispatchPointer(target, 'pointerup', 120, 50);

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    const stored = window.localStorage.getItem('newshacker:pinnedStoryIds');
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored as string) as Array<{
      id: number;
      at: number;
    }>;
    expect(parsed.map((e) => e.id)).toContain(20);

    // Unlike dismiss, pin should NOT remove the row from the feed.
    expect(screen.getAllByTestId('story-row')).toHaveLength(3);

    // The pinned row's pin button reflects pinned state — no toast fires.
    const toastHost = screen.queryByTestId('toast-host');
    if (toastHost) {
      expect(within(toastHost).queryByText(/pinned/i)).toBeNull();
    }
    const pinnedRow = screen
      .getAllByTestId('story-row')
      .find((r) => r.textContent?.includes('Story 20'))!;
    expect(within(pinnedRow).getByTestId('pin-btn')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  // Regression: swipe-left on an already-pinned row must be a
  // no-op. Before the shield was made symmetric, onSwipeLeft still
  // fired `onPin` on pinned rows, and `addPinnedId` re-wrote the
  // entry with a fresh timestamp — effectively reordering the
  // pinned list to the top every time the reader grazed a pinned
  // row. Now the handler is suppressed on pinned rows (matching
  // the swipe-right→Hide suppression); the gesture rubber-bands
  // and the stored timestamp is untouched.
  it('swipe-left on a pinned row does not re-timestamp the pin', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const ids = [10, 20, 30];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });
    const originalPinnedAt = 1_700_000_000_000;
    addPinnedId(20, originalPinnedAt);

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });

    const target = screen.getAllByTestId('story-row')[1]; // Story 20 (pinned)
    dispatchPointer(target, 'pointerdown', 280, 50);
    dispatchPointer(target, 'pointermove', 120, 50);
    dispatchPointer(target, 'pointerup', 120, 50);

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    const entry = getPinnedEntries().find((e) => e.id === 20);
    expect(entry?.at).toBe(originalPinnedAt);
  });
});
