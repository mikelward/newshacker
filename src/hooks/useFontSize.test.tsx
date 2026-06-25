import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useFontSize } from './useFontSize';
import { FONT_SIZE_STORAGE_KEY } from '../lib/fontSize';

describe('useFontSize', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-font-size');
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-font-size');
  });

  it('returns the stored font size and persists changes', () => {
    const { result } = renderHook(() => useFontSize());
    expect(result.current.fontSize).toBe('medium');

    act(() => result.current.setFontSize('large'));
    expect(result.current.fontSize).toBe('large');
    expect(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)).toBe('large');
    expect(document.documentElement.getAttribute('data-font-size')).toBe(
      'large',
    );

    act(() => result.current.setFontSize('medium'));
    expect(result.current.fontSize).toBe('medium');
    expect(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute('data-font-size')).toBe(false);
  });

  it('syncs across hook instances via the change event', () => {
    const a = renderHook(() => useFontSize());
    const b = renderHook(() => useFontSize());

    act(() => a.result.current.setFontSize('small'));
    expect(b.result.current.fontSize).toBe('small');
  });

  it('reads the stored value on mount', () => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, 'large');
    const { result } = renderHook(() => useFontSize());
    expect(result.current.fontSize).toBe('large');
  });

  it('repaints data-font-size on a cross-tab storage event', () => {
    // Regression: the storage listener updated React state but never
    // applied the <html data-font-size> attribute, so the receiving tab's
    // picker flipped while the page text stayed stale until reload.
    const { result } = renderHook(() => useFontSize());
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, 'large');
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: FONT_SIZE_STORAGE_KEY }),
      );
    });
    expect(result.current.fontSize).toBe('large');
    expect(document.documentElement.getAttribute('data-font-size')).toBe(
      'large',
    );
  });
});
