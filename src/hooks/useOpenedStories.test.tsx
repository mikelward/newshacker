import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import { useOpenedStories } from './useOpenedStories';
import { addOpenedId } from '../lib/openedStories';

describe('useOpenedStories', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('reads existing ids from storage on mount', () => {
    addOpenedId(42);
    const { result } = renderHook(() => useOpenedStories());
    expect(result.current.isOpened(42)).toBe(true);
    expect(result.current.isOpened(1)).toBe(false);
  });

  it('markOpened() updates state and persists', () => {
    const { result } = renderHook(() => useOpenedStories());
    act(() => {
      result.current.markOpened(7);
    });
    expect(result.current.openedIds.has(7)).toBe(true);
    const { result: second } = renderHook(() => useOpenedStories());
    expect(second.current.isOpened(7)).toBe(true);
  });

  it('unopen() removes the id', () => {
    addOpenedId(3);
    const { result } = renderHook(() => useOpenedStories());
    act(() => {
      result.current.unopen(3);
    });
    expect(result.current.isOpened(3)).toBe(false);
  });

  it('keeps multiple hook instances in sync via events', () => {
    const a = renderHook(() => useOpenedStories());
    const b = renderHook(() => useOpenedStories());
    act(() => {
      a.result.current.markOpened(9);
    });
    expect(b.result.current.isOpened(9)).toBe(true);
  });

  it('cleans up event listeners on unmount', () => {
    const { unmount } = render(<Consumer />);
    expect(() => unmount()).not.toThrow();
  });
});

function Consumer() {
  useOpenedStories();
  return null;
}
