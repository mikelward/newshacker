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
    expect(result.current.chrome).toBe('default');

    act(() => result.current.setChrome('mono-a'));
    expect(result.current.chrome).toBe('mono-a');
    expect(window.localStorage.getItem(CHROME_STORAGE_KEY)).toBe('mono-a');
    expect(document.documentElement.getAttribute('data-chrome')).toBe('mono-a');

    act(() => result.current.setChrome('default'));
    expect(result.current.chrome).toBe('default');
    expect(window.localStorage.getItem(CHROME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute('data-chrome')).toBe(false);
  });

  it('syncs across hook instances via the change event', () => {
    const a = renderHook(() => useChrome());
    const b = renderHook(() => useChrome());

    act(() => a.result.current.setChrome('mono-b'));
    expect(b.result.current.chrome).toBe('mono-b');
  });
});
