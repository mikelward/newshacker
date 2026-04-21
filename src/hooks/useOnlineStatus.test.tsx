import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useOnlineStatus } from './useOnlineStatus';
import {
  _resetNetworkStatusForTests,
  reportFetchFailure,
  reportFetchSuccess,
} from '../lib/networkStatus';

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value,
  });
}

describe('useOnlineStatus', () => {
  beforeEach(() => {
    setNavigatorOnline(true);
    _resetNetworkStatusForTests();
  });
  afterEach(() => {
    setNavigatorOnline(true);
    _resetNetworkStatusForTests();
  });

  it('initialises from navigator.onLine', () => {
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);
  });

  it('flips to false on window offline event', () => {
    const { result } = renderHook(() => useOnlineStatus());
    act(() => {
      setNavigatorOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(result.current).toBe(false);
  });

  it('flips to true on window online event', () => {
    setNavigatorOnline(false);
    _resetNetworkStatusForTests();
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(false);
    act(() => {
      setNavigatorOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(result.current).toBe(true);
  });

  it('flips offline immediately when a fetch fails with a network error', () => {
    // The whole point of this indirection: the OS takes seconds to
    // flip navigator.onLine when you walk into a tunnel, but any
    // in-flight request fails instantly. The pill should react to the
    // latter, not wait for the former.
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);
    act(() => {
      reportFetchFailure(new TypeError('Failed to fetch'));
    });
    expect(result.current).toBe(false);
  });

  it('flips back online when the next fetch succeeds', () => {
    const { result } = renderHook(() => useOnlineStatus());
    act(() => {
      reportFetchFailure(new TypeError('Failed to fetch'));
    });
    expect(result.current).toBe(false);
    act(() => {
      reportFetchSuccess();
    });
    expect(result.current).toBe(true);
  });

  it('ignores AbortError — a caller cancelling is not a connectivity signal', () => {
    const { result } = renderHook(() => useOnlineStatus());
    act(() => {
      reportFetchFailure(new DOMException('aborted', 'AbortError'));
    });
    expect(result.current).toBe(true);
  });

  it('stops updating after unmount', () => {
    const { result, unmount } = renderHook(() => useOnlineStatus());
    unmount();
    act(() => {
      reportFetchFailure(new TypeError('Failed to fetch'));
    });
    expect(result.current).toBe(true);
  });
});
