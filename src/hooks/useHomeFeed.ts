import { useCallback } from 'react';
import { type HomeFeed, homeFeedStore } from '../lib/homeFeed';
import { usePersistentValue } from './usePersistentValue';

export function useHomeFeed() {
  const homeFeed = usePersistentValue(homeFeedStore);
  const setHomeFeed = useCallback((f: HomeFeed) => homeFeedStore.set(f), []);
  return { homeFeed, setHomeFeed };
}
