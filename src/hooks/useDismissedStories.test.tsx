import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import { useDismissedStories } from './useDismissedStories';
import { addDismissedId } from '../lib/dismissedStories';

describe('useDismissedStories', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('reads existing ids from storage on mount', () => {
    addDismissedId(42);
    const { result } = renderHook(() => useDismissedStories());
    expect(result.current.isDismissed(42)).toBe(true);
    expect(result.current.isDismissed(1)).toBe(false);
  });

  it('dismiss() updates state and persists', () => {
    const { result } = renderHook(() => useDismissedStories());
    act(() => {
      result.current.dismiss(7);
    });
    expect(result.current.dismissedIds.has(7)).toBe(true);
    const { result: second } = renderHook(() => useDismissedStories());
    expect(second.current.isDismissed(7)).toBe(true);
  });

  it('undismiss() removes the id', () => {
    addDismissedId(3);
    const { result } = renderHook(() => useDismissedStories());
    act(() => {
      result.current.undismiss(3);
    });
    expect(result.current.isDismissed(3)).toBe(false);
  });

  it('keeps multiple hook instances in sync via events', () => {
    const a = renderHook(() => useDismissedStories());
    const b = renderHook(() => useDismissedStories());
    act(() => {
      a.result.current.dismiss(9);
    });
    expect(b.result.current.isDismissed(9)).toBe(true);
  });

  it('cleans up event listeners on unmount', () => {
    const { unmount } = render(<Consumer />);
    expect(() => unmount()).not.toThrow();
  });
});

function Consumer() {
  useDismissedStories();
  return null;
}
