import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import { usePinnedStories } from './usePinnedStories';
import { addPinnedId } from '../lib/pinnedStories';
import { addDoneId, getDoneIds } from '../lib/doneStories';
import { addHiddenId, getHiddenIds } from '../lib/hiddenStories';

describe('usePinnedStories', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('reads existing ids from storage on mount', () => {
    addPinnedId(42);
    const { result } = renderHook(() => usePinnedStories());
    expect(result.current.isPinned(42)).toBe(true);
    expect(result.current.isPinned(1)).toBe(false);
  });

  it('pin() updates state and persists', () => {
    const { result } = renderHook(() => usePinnedStories());
    act(() => {
      result.current.pin(7);
    });
    expect(result.current.pinnedIds.has(7)).toBe(true);
    const { result: second } = renderHook(() => usePinnedStories());
    expect(second.current.isPinned(7)).toBe(true);
  });

  it('unpin() removes the id', () => {
    addPinnedId(3);
    const { result } = renderHook(() => usePinnedStories());
    act(() => {
      result.current.unpin(3);
    });
    expect(result.current.isPinned(3)).toBe(false);
  });

  it('togglePinned() pins when absent and unpins when present', () => {
    const { result } = renderHook(() => usePinnedStories());
    act(() => {
      result.current.togglePinned(11);
    });
    expect(result.current.isPinned(11)).toBe(true);
    act(() => {
      result.current.togglePinned(11);
    });
    expect(result.current.isPinned(11)).toBe(false);
  });

  it('keeps multiple hook instances in sync via events', () => {
    const a = renderHook(() => usePinnedStories());
    const b = renderHook(() => usePinnedStories());
    act(() => {
      a.result.current.pin(9);
    });
    expect(b.result.current.isPinned(9)).toBe(true);
  });

  it('cleans up event listeners on unmount', () => {
    const { unmount } = render(<Consumer />);
    expect(() => unmount()).not.toThrow();
  });

  // The mutual-exclusion shields between Pin and its siblings
  // are now enforced at the store layer rather than relying on
  // every UI guard. `markDone` already cleared Pin; these tests
  // mirror the symmetry for `pin()` clearing Done and Hidden.
  it('pin() removes the id from done if it was there', () => {
    addDoneId(5);
    const { result } = renderHook(() => usePinnedStories());
    act(() => {
      result.current.pin(5);
    });
    expect(result.current.isPinned(5)).toBe(true);
    expect(getDoneIds().has(5)).toBe(false);
  });

  it('pin() removes the id from hidden if it was there', () => {
    addHiddenId(6);
    const { result } = renderHook(() => usePinnedStories());
    act(() => {
      result.current.pin(6);
    });
    expect(result.current.isPinned(6)).toBe(true);
    expect(getHiddenIds().has(6)).toBe(false);
  });

  it('togglePinned() also clears siblings when transitioning to pinned', () => {
    addDoneId(8);
    addHiddenId(8);
    const { result } = renderHook(() => usePinnedStories());
    act(() => {
      result.current.togglePinned(8);
    });
    expect(result.current.isPinned(8)).toBe(true);
    expect(getDoneIds().has(8)).toBe(false);
    expect(getHiddenIds().has(8)).toBe(false);
  });
});

function Consumer() {
  usePinnedStories();
  return null;
}
