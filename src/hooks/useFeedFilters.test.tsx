import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useFeedFilters } from './useFeedFilters';
import { setFeedFilters } from '../lib/feedFilters';

describe('useFeedFilters', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('reads existing filters from storage on mount', () => {
    setFeedFilters({ unreadOnly: true, hotOnly: false });
    const { result } = renderHook(() => useFeedFilters());
    expect(result.current.unreadOnly).toBe(true);
    expect(result.current.hotOnly).toBe(false);
  });

  it('toggleUnreadOnly() flips unreadOnly and persists', () => {
    const { result } = renderHook(() => useFeedFilters());
    expect(result.current.unreadOnly).toBe(false);
    act(() => {
      result.current.toggleUnreadOnly();
    });
    expect(result.current.unreadOnly).toBe(true);
    act(() => {
      result.current.toggleUnreadOnly();
    });
    expect(result.current.unreadOnly).toBe(false);
  });

  it('toggleHotOnly() flips hotOnly without touching unreadOnly', () => {
    const { result } = renderHook(() => useFeedFilters());
    act(() => {
      result.current.toggleUnreadOnly();
    });
    act(() => {
      result.current.toggleHotOnly();
    });
    expect(result.current.unreadOnly).toBe(true);
    expect(result.current.hotOnly).toBe(true);
  });

  it('keeps multiple hook instances in sync via events', () => {
    const a = renderHook(() => useFeedFilters());
    const b = renderHook(() => useFeedFilters());
    act(() => {
      a.result.current.toggleHotOnly();
    });
    expect(b.result.current.hotOnly).toBe(true);
  });

  it('ignores storage events fired for unrelated keys', () => {
    const { result } = renderHook(() => useFeedFilters());
    expect(result.current.hotOnly).toBe(false);
    act(() => {
      // Simulate React Query's persister writing to its own key. The
      // hook should not re-read our state on this event.
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'REACT_QUERY_OFFLINE_CACHE',
          newValue: '{}',
        }),
      );
    });
    expect(result.current.hotOnly).toBe(false);
    expect(result.current.unreadOnly).toBe(false);
  });

  it('flips in-memory state from the event detail even when the storage write fails', () => {
    const setItem = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error('QuotaExceeded');
    };
    try {
      const { result } = renderHook(() => useFeedFilters());
      expect(result.current.unreadOnly).toBe(false);
      act(() => {
        result.current.toggleUnreadOnly();
      });
      // Storage write failed, but the event carried `next` in detail, so
      // the hook's sync listener adopted it for this session.
      expect(result.current.unreadOnly).toBe(true);
    } finally {
      window.localStorage.setItem = setItem;
    }
  });
});
