import { useCallback, useEffect, useState } from 'react';
import {
  FEED_FILTERS_CHANGE_EVENT,
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
    const sync = () => setState(getFeedFilters());
    window.addEventListener(FEED_FILTERS_CHANGE_EVENT, sync);
    // Cross-tab sync via the native `storage` event.
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(FEED_FILTERS_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
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
