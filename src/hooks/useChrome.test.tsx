import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useChrome } from './useChrome';
import { CHROME_STORAGE_KEY } from '../lib/chrome';

describe('useChrome', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-chrome');
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-chrome');
  });

  it('returns the stored chrome and persists changes', () => {
    const { result } = renderHook(() => useChrome());
    expect(result.current.chrome).toBe('mono');

    act(() => result.current.setChrome('duo'));
    expect(result.current.chrome).toBe('duo');
    expect(window.localStorage.getItem(CHROME_STORAGE_KEY)).toBe('duo');
    expect(document.documentElement.getAttribute('data-chrome')).toBe('duo');

    act(() => result.current.setChrome('mono'));
    expect(result.current.chrome).toBe('mono');
    expect(window.localStorage.getItem(CHROME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute('data-chrome')).toBe(false);
  });

  it('syncs across hook instances via the change event', () => {
    const a = renderHook(() => useChrome());
    const b = renderHook(() => useChrome());

    act(() => a.result.current.setChrome('classic'));
    expect(b.result.current.chrome).toBe('classic');
  });

  it('reads the stored value on mount', () => {
    window.localStorage.setItem(CHROME_STORAGE_KEY, 'classic');
    const { result } = renderHook(() => useChrome());
    expect(result.current.chrome).toBe('classic');
  });

  it('repaints data-chrome on a cross-tab storage event', () => {
    // Regression: the storage listener updated React state but never
    // applied the <html data-chrome> attribute, so the receiving tab's
    // picker flipped while the page chrome stayed stale until reload.
    const { result } = renderHook(() => useChrome());
    window.localStorage.setItem(CHROME_STORAGE_KEY, 'classic');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: CHROME_STORAGE_KEY }));
    });
    expect(result.current.chrome).toBe('classic');
    expect(document.documentElement.getAttribute('data-chrome')).toBe(
      'classic',
    );
  });
});
