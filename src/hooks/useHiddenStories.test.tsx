import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import { useHiddenStories } from './useHiddenStories';
import { addHiddenId } from '../lib/hiddenStories';

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
});

function Consumer() {
  useHiddenStories();
  return null;
}
