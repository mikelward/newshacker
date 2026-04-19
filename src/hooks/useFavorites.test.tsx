import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import { useFavorites } from './useFavorites';
import { addFavoriteId } from '../lib/favorites';

describe('useFavorites', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('reads existing ids from storage on mount', () => {
    addFavoriteId(42);
    const { result } = renderHook(() => useFavorites());
    expect(result.current.isFavorite(42)).toBe(true);
    expect(result.current.isFavorite(1)).toBe(false);
  });

  it('favorite() updates state and persists', () => {
    const { result } = renderHook(() => useFavorites());
    act(() => {
      result.current.favorite(7);
    });
    expect(result.current.favoriteIds.has(7)).toBe(true);
    const { result: second } = renderHook(() => useFavorites());
    expect(second.current.isFavorite(7)).toBe(true);
  });

  it('unfavorite() removes the id', () => {
    addFavoriteId(3);
    const { result } = renderHook(() => useFavorites());
    act(() => {
      result.current.unfavorite(3);
    });
    expect(result.current.isFavorite(3)).toBe(false);
  });

  it('toggleFavorite() adds when absent and removes when present', () => {
    const { result } = renderHook(() => useFavorites());
    act(() => {
      result.current.toggleFavorite(11);
    });
    expect(result.current.isFavorite(11)).toBe(true);
    act(() => {
      result.current.toggleFavorite(11);
    });
    expect(result.current.isFavorite(11)).toBe(false);
  });

  it('keeps multiple hook instances in sync via events', () => {
    const a = renderHook(() => useFavorites());
    const b = renderHook(() => useFavorites());
    act(() => {
      a.result.current.favorite(9);
    });
    expect(b.result.current.isFavorite(9)).toBe(true);
  });

  it('cleans up event listeners on unmount', () => {
    const { unmount } = render(<Consumer />);
    expect(() => unmount()).not.toThrow();
  });
});

function Consumer() {
  useFavorites();
  return null;
}
