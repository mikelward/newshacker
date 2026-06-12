import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import { useHiddenStories } from './useHiddenStories';
import { addHiddenId } from '../lib/hiddenStories';
import { addPinnedId, getPinnedIds } from '../lib/pinnedStories';
import { addDoneId, getDoneIds } from '../lib/doneStories';

describe('useHiddenStories', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('reads existing ids from storage on mount', () => {
    addHiddenId(42);
    const { result } = renderHook(() => useHiddenStories());
    expect(result.current.isHidden(42)).toBe(true);
    expect(result.current.isHidden(1)).toBe(false);
  });

  it('hide() updates state and persists', () => {
    const { result } = renderHook(() => useHiddenStories());
    act(() => {
      result.current.hide(7);
    });
    expect(result.current.hiddenIds.has(7)).toBe(true);
    const { result: second } = renderHook(() => useHiddenStories());
    expect(second.current.isHidden(7)).toBe(true);
  });

  it('unhide() removes the id', () => {
    addHiddenId(3);
    const { result } = renderHook(() => useHiddenStories());
    act(() => {
      result.current.unhide(3);
    });
    expect(result.current.isHidden(3)).toBe(false);
  });

  it('keeps multiple hook instances in sync via events', () => {
    const a = renderHook(() => useHiddenStories());
    const b = renderHook(() => useHiddenStories());
    act(() => {
      a.result.current.hide(9);
    });
    expect(b.result.current.isHidden(9)).toBe(true);
  });

  it('cleans up event listeners on unmount', () => {
    const { unmount } = render(<Consumer />);
    expect(() => unmount()).not.toThrow();
  });

  // Pin ↔ Hide is the SPEC's "shield" rule: a row can't be in
  // both lists at once. Enforced at the store layer so a future
  // caller that bypasses the UI guard can't drift the stores.
  it('hide() removes the id from pinned if it was there', () => {
    addPinnedId(5);
    const { result } = renderHook(() => useHiddenStories());
    act(() => {
      result.current.hide(5);
    });
    expect(result.current.isHidden(5)).toBe(true);
    expect(getPinnedIds().has(5)).toBe(false);
  });

  // The bulk Sweep path hides many rows at once. hideMany must hide
  // every id and enforce the same Pin ↔ Hide shield as hide().
  it('hideMany() hides every id and clears their pins', () => {
    addPinnedId(2);
    const { result } = renderHook(() => useHiddenStories());
    act(() => {
      result.current.hideMany([1, 2, 3]);
    });
    expect(result.current.hiddenIds).toEqual(new Set([1, 2, 3]));
    expect(getPinnedIds().has(2)).toBe(false);
    const { result: second } = renderHook(() => useHiddenStories());
    expect(second.current.hiddenIds).toEqual(new Set([1, 2, 3]));
  });

  // The whole reason hideMany exists: a bulk sweep should touch each
  // store once, not once per row. Two batched writes (pins + hidden)
  // → two change events, regardless of how many rows are swept.
  it('hideMany() fires one change event per store, not one per id', () => {
    let hiddenEvents = 0;
    let pinnedEvents = 0;
    const onHidden = () => (hiddenEvents += 1);
    const onPinned = () => (pinnedEvents += 1);
    window.addEventListener('newshacker:hiddenStoriesChanged', onHidden);
    window.addEventListener('newshacker:pinnedStoriesChanged', onPinned);
    const { result } = renderHook(() => useHiddenStories());
    try {
      act(() => {
        result.current.hideMany([1, 2, 3, 4, 5]);
      });
    } finally {
      window.removeEventListener(
        'newshacker:hiddenStoriesChanged',
        onHidden,
      );
      window.removeEventListener(
        'newshacker:pinnedStoriesChanged',
        onPinned,
      );
    }
    expect(hiddenEvents).toBe(1);
    expect(pinnedEvents).toBe(1);
  });

  // Hide ↔ Done coexistence is *allowed* (per useDoneStories
  // markDone's comment: "Done's list filter supersedes [hidden]
  // anyway"). Hide must NOT clear Done — that would lose the
  // completion log entry for a story the reader read and then
  // hid.
  it('hide() leaves the done state alone', () => {
    addDoneId(7);
    const { result } = renderHook(() => useHiddenStories());
    act(() => {
      result.current.hide(7);
    });
    expect(result.current.isHidden(7)).toBe(true);
    expect(getDoneIds().has(7)).toBe(true);
  });
});

function Consumer() {
  useHiddenStories();
  return null;
}
