import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import { useSavedStories } from './useSavedStories';
import { addSavedId } from '../lib/savedStories';

describe('useSavedStories', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('reads existing ids from storage on mount', () => {
    addSavedId(42);
    const { result } = renderHook(() => useSavedStories());
    expect(result.current.isSaved(42)).toBe(true);
    expect(result.current.isSaved(1)).toBe(false);
  });

  it('save() updates state and persists', () => {
    const { result } = renderHook(() => useSavedStories());
    act(() => {
      result.current.save(7);
    });
    expect(result.current.savedIds.has(7)).toBe(true);
    const { result: second } = renderHook(() => useSavedStories());
    expect(second.current.isSaved(7)).toBe(true);
  });

  it('unsave() removes the id', () => {
    addSavedId(3);
    const { result } = renderHook(() => useSavedStories());
    act(() => {
      result.current.unsave(3);
    });
    expect(result.current.isSaved(3)).toBe(false);
  });

  it('toggleSaved() saves when absent and unsaves when present', () => {
    const { result } = renderHook(() => useSavedStories());
    act(() => {
      result.current.toggleSaved(11);
    });
    expect(result.current.isSaved(11)).toBe(true);
    act(() => {
      result.current.toggleSaved(11);
    });
    expect(result.current.isSaved(11)).toBe(false);
  });

  it('keeps multiple hook instances in sync via events', () => {
    const a = renderHook(() => useSavedStories());
    const b = renderHook(() => useSavedStories());
    act(() => {
      a.result.current.save(9);
    });
    expect(b.result.current.isSaved(9)).toBe(true);
  });

  it('cleans up event listeners on unmount', () => {
    const { unmount } = render(<Consumer />);
    expect(() => unmount()).not.toThrow();
  });
});

function Consumer() {
  useSavedStories();
  return null;
}
