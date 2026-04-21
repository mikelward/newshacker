import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import { useDoneStories } from './useDoneStories';
import { addDoneId } from '../lib/doneStories';
import { addPinnedId, getPinnedIds } from '../lib/pinnedStories';

describe('useDoneStories', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('reads existing ids from storage on mount', () => {
    addDoneId(42);
    const { result } = renderHook(() => useDoneStories());
    expect(result.current.isDone(42)).toBe(true);
    expect(result.current.isDone(1)).toBe(false);
  });

  it('markDone() updates state and persists', () => {
    const { result } = renderHook(() => useDoneStories());
    act(() => {
      result.current.markDone(7);
    });
    expect(result.current.doneIds.has(7)).toBe(true);
    const { result: second } = renderHook(() => useDoneStories());
    expect(second.current.isDone(7)).toBe(true);
  });

  it('unmarkDone() removes the id', () => {
    addDoneId(3);
    const { result } = renderHook(() => useDoneStories());
    act(() => {
      result.current.unmarkDone(3);
    });
    expect(result.current.isDone(3)).toBe(false);
  });

  it('toggleDone() flips the id both ways', () => {
    const { result } = renderHook(() => useDoneStories());
    act(() => {
      result.current.toggleDone(5);
    });
    expect(result.current.isDone(5)).toBe(true);
    act(() => {
      result.current.toggleDone(5);
    });
    expect(result.current.isDone(5)).toBe(false);
  });

  it('keeps multiple hook instances in sync via events', () => {
    const a = renderHook(() => useDoneStories());
    const b = renderHook(() => useDoneStories());
    act(() => {
      a.result.current.markDone(9);
    });
    expect(b.result.current.isDone(9)).toBe(true);
  });

  it('cleans up event listeners on unmount', () => {
    const { unmount } = render(<Consumer />);
    expect(() => unmount()).not.toThrow();
  });

  describe('markDone side-effect on Pinned', () => {
    it('unpins the story when marking done', () => {
      addPinnedId(42);
      expect(getPinnedIds().has(42)).toBe(true);
      const { result } = renderHook(() => useDoneStories());
      act(() => {
        result.current.markDone(42);
      });
      expect(result.current.isDone(42)).toBe(true);
      expect(getPinnedIds().has(42)).toBe(false);
    });

    it('is a no-op on pin if the story was never pinned', () => {
      const { result } = renderHook(() => useDoneStories());
      act(() => {
        result.current.markDone(42);
      });
      expect(result.current.isDone(42)).toBe(true);
      // Pinned list stays empty — no stray tombstones materializing.
      expect(getPinnedIds().size).toBe(0);
    });

    it('toggleDone(on) also unpins', () => {
      addPinnedId(7);
      const { result } = renderHook(() => useDoneStories());
      act(() => {
        result.current.toggleDone(7);
      });
      expect(result.current.isDone(7)).toBe(true);
      expect(getPinnedIds().has(7)).toBe(false);
    });

    it('unmarkDone does NOT re-pin', () => {
      addDoneId(7);
      const { result } = renderHook(() => useDoneStories());
      act(() => {
        result.current.unmarkDone(7);
      });
      expect(result.current.isDone(7)).toBe(false);
      expect(getPinnedIds().has(7)).toBe(false);
    });
  });
});

function Consumer() {
  useDoneStories();
  return null;
}
