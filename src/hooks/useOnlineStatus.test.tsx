import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useOnlineStatus } from './useOnlineStatus';

describe('useOnlineStatus', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setOnline(value: boolean) {
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value,
    });
  }

  it('initialises from navigator.onLine', () => {
    setOnline(true);
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);
  });

  it('flips to false on offline event', () => {
    setOnline(true);
    const { result } = renderHook(() => useOnlineStatus());
    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(result.current).toBe(false);
  });

  it('flips to true on online event', () => {
    setOnline(false);
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(false);
    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(result.current).toBe(true);
  });

  it('cleans up listeners on unmount', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useOnlineStatus());
    const onlineAdded = add.mock.calls.some(([event]) => event === 'online');
    expect(onlineAdded).toBe(true);
    unmount();
    const onlineRemoved = remove.mock.calls.some(([event]) => event === 'online');
    const offlineRemoved = remove.mock.calls.some(([event]) => event === 'offline');
    expect(onlineRemoved).toBe(true);
    expect(offlineRemoved).toBe(true);
  });
});
