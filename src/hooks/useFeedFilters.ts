import { useCallback, useEffect, useState } from 'react';
import {
  FEED_FILTERS_CHANGE_EVENT,
  FEED_FILTERS_STORAGE_KEY,
  type FeedFilters,
  getFeedFilters,
  setFeedFilters,
} from '../lib/feedFilters';

export interface UseFeedFiltersResult extends FeedFilters {
  toggleUnreadOnly: () => void;
  toggleHotOnly: () => void;
  setUnreadOnly: (value: boolean) => void;
  setHotOnly: (value: boolean) => void;
}

export function useFeedFilters(): UseFeedFiltersResult {
  const [state, setState] = useState<FeedFilters>(() => getFeedFilters());

  useEffect(() => {
    // Prefer the CustomEvent's `detail` payload (carried by
    // setFeedFilters) so the in-memory UI state still flips even when
    // localStorage.setItem throws (private mode, quota). Fall back to
    // re-reading storage for the cross-tab `storage` event, which
    // has no same-value detail. Ignore cross-tab events for other
    // keys (React Query's persisted cache also lives in localStorage)
    // and skip setState when the read hasn't changed, to avoid
    // unnecessary re-renders.
    const sameSnapshot = (a: FeedFilters, b: FeedFilters) =>
      a.unreadOnly === b.unreadOnly && a.hotOnly === b.hotOnly;

    const onFilterChange = (e: Event) => {
      const detail = (e as CustomEvent<FeedFilters>).detail;
      const next = detail && typeof detail === 'object'
        ? detail
        : getFeedFilters();
      setState((prev) => (sameSnapshot(prev, next) ? prev : next));
    };

    const onStorage = (e: StorageEvent) => {
      // StorageEvent.key is null on storage.clear(); treat that as a
      // possible reset of our key too.
      if (e.key !== null && e.key !== FEED_FILTERS_STORAGE_KEY) return;
      const next = getFeedFilters();
      setState((prev) => (sameSnapshot(prev, next) ? prev : next));
    };

    window.addEventListener(FEED_FILTERS_CHANGE_EVENT, onFilterChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(FEED_FILTERS_CHANGE_EVENT, onFilterChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const toggleUnreadOnly = useCallback(() => {
    setFeedFilters((prev) => ({ ...prev, unreadOnly: !prev.unreadOnly }));
  }, []);
  const toggleHotOnly = useCallback(() => {
    setFeedFilters((prev) => ({ ...prev, hotOnly: !prev.hotOnly }));
  }, []);
  const setUnreadOnly = useCallback((value: boolean) => {
    setFeedFilters((prev) => ({ ...prev, unreadOnly: value }));
  }, []);
  const setHotOnly = useCallback((value: boolean) => {
    setFeedFilters((prev) => ({ ...prev, hotOnly: value }));
  }, []);

  return {
    ...state,
    toggleUnreadOnly,
    toggleHotOnly,
    setUnreadOnly,
    setHotOnly,
  };
}
