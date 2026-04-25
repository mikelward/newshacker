import { useCallback, useEffect, useState } from 'react';
import {
  HOME_FEED_CHANGE_EVENT,
  type HomeFeed,
  getStoredHomeFeed,
  setStoredHomeFeed,
} from '../lib/homeFeed';

export function useHomeFeed() {
  const [homeFeed, setHomeFeedState] = useState<HomeFeed>(() =>
    getStoredHomeFeed(),
  );

  useEffect(() => {
    const sync = () => setHomeFeedState(getStoredHomeFeed());
    window.addEventListener(HOME_FEED_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(HOME_FEED_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const setHomeFeed = useCallback((f: HomeFeed) => setStoredHomeFeed(f), []);

  return { homeFeed, setHomeFeed };
}
