import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import { usePinnedStories } from './usePinnedStories';
import { addPinnedId } from '../lib/pinnedStories';

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
});

function Consumer() {
  usePinnedStories();
  return null;
}
