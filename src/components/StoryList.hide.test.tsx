import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { StoryList } from './StoryList';
import { AppHeader } from './AppHeader';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { addHiddenId } from '../lib/hiddenStories';

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
});
