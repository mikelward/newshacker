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
    expect(result.current.openedIds.has(42)).toBe(true);
    expect(result.current.openedIds.has(1)).toBe(false);
  });

  it('markOpened("article") only marks the article half', () => {
    const { result } = renderHook(() => useOpenedStories());
    act(() => {
      result.current.markOpened(7, 'article');
    });
    expect(result.current.articleOpenedIds.has(7)).toBe(true);
    expect(result.current.commentsOpenedIds.has(7)).toBe(false);
    expect(result.current.openedIds.has(7)).toBe(true);
  });

  it('markOpened("comments") only marks the comments half', () => {
    const { result } = renderHook(() => useOpenedStories());
    act(() => {
      result.current.markOpened(8, 'comments');
    });
    expect(result.current.commentsOpenedIds.has(8)).toBe(true);
    expect(result.current.articleOpenedIds.has(8)).toBe(false);
    expect(result.current.openedIds.has(8)).toBe(true);
  });

  it('marking both halves separately keeps both set', () => {
    const { result } = renderHook(() => useOpenedStories());
    act(() => {
      result.current.markOpened(3, 'article');
      result.current.markOpened(3, 'comments');
    });
    expect(result.current.articleOpenedIds.has(3)).toBe(true);
    expect(result.current.commentsOpenedIds.has(3)).toBe(true);
  });

  it('markBothOpened() persists across hook instances', () => {
    const { result } = renderHook(() => useOpenedStories());
    act(() => {
      result.current.markBothOpened(7);
    });
    const { result: second } = renderHook(() => useOpenedStories());
    expect(second.current.articleOpenedIds.has(7)).toBe(true);
    expect(second.current.commentsOpenedIds.has(7)).toBe(true);
  });

  it('unopen() removes both halves', () => {
    addOpenedId(3);
    const { result } = renderHook(() => useOpenedStories());
    act(() => {
      result.current.unopen(3);
    });
    expect(result.current.openedIds.has(3)).toBe(false);
    expect(result.current.articleOpenedIds.has(3)).toBe(false);
    expect(result.current.commentsOpenedIds.has(3)).toBe(false);
  });

  it('keeps multiple hook instances in sync via events', () => {
    const a = renderHook(() => useOpenedStories());
    const b = renderHook(() => useOpenedStories());
    act(() => {
      a.result.current.markOpened(9, 'article');
    });
    expect(b.result.current.articleOpenedIds.has(9)).toBe(true);
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
