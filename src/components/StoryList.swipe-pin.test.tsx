import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { StoryList } from './StoryList';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';

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

    const stored = window.localStorage.getItem('hnews:pinnedStoryIds');
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
});
