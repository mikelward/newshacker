import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useHomeFeed } from './useHomeFeed';
import { HOME_FEED_STORAGE_KEY } from '../lib/homeFeed';

describe('useHomeFeed', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns the stored value and persists changes', () => {
    const { result } = renderHook(() => useHomeFeed());
    expect(result.current.homeFeed).toBe('top');

    act(() => result.current.setHomeFeed('hot'));
    expect(result.current.homeFeed).toBe('hot');
    expect(window.localStorage.getItem(HOME_FEED_STORAGE_KEY)).toBe('hot');

    act(() => result.current.setHomeFeed('top'));
    expect(result.current.homeFeed).toBe('top');
    expect(window.localStorage.getItem(HOME_FEED_STORAGE_KEY)).toBeNull();
  });

  it('syncs across hook instances via the change event', () => {
    const a = renderHook(() => useHomeFeed());
    const b = renderHook(() => useHomeFeed());

    act(() => a.result.current.setHomeFeed('hot'));
    expect(b.result.current.homeFeed).toBe('hot');
  });

  it('reads the stored value on mount', () => {
    window.localStorage.setItem(HOME_FEED_STORAGE_KEY, 'hot');
    const { result } = renderHook(() => useHomeFeed());
    expect(result.current.homeFeed).toBe('hot');
  });
});
