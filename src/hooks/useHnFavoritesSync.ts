import { useEffect } from 'react';
import {
  startHnFavoritesSync,
  stopHnFavoritesSync,
} from '../lib/hnFavoritesSync';
import { useAuth } from './useAuth';

// Wire the hnFavoritesSync module to auth state. Mount once near the
// app root next to useCloudSync. Phase A: runs a one-shot bootstrap
// pull of the user's HN favorites on sign-in / app start. Phase B
// will extend the module with a write-back queue; the lifecycle here
// stays identical.
export function useHnFavoritesSync(): void {
  const { user } = useAuth();
  const username = user?.username ?? null;

  useEffect(() => {
    if (!username) {
      stopHnFavoritesSync();
      return;
    }
    void startHnFavoritesSync(username);
    return () => {
      stopHnFavoritesSync();
    };
  }, [username]);
}
