import { useCallback, useEffect, useState } from 'react';
import {
  FAVORITES_CHANGE_EVENT,
  addFavoriteId,
  getFavoriteIds,
  removeFavoriteId,
} from '../lib/favorites';
import { enqueueHnFavoriteAction } from '../lib/hnFavoritesSync';
import { useAuth } from './useAuth';

export function useFavorites() {
  const [favoriteIds, setFavoriteIds] = useState<Set<number>>(() =>
    getFavoriteIds(),
  );
  const { user } = useAuth();
  const username = user?.username ?? null;

  useEffect(() => {
    const sync = () => setFavoriteIds(getFavoriteIds());
    window.addEventListener(FAVORITES_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(FAVORITES_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  // User-originated favorite/unfavorite. The local store is updated
  // synchronously (optimistic UI) and, for signed-in users, the
  // action is enqueued for HN. Bootstrap merges from HN go through
  // replaceFavoriteEntries directly, bypassing this path — so merge-
  // induced local changes don't echo back to HN.
  const favorite = useCallback(
    (id: number) => {
      addFavoriteId(id);
      if (username) enqueueHnFavoriteAction(username, 'favorite', id);
    },
    [username],
  );
  const unfavorite = useCallback(
    (id: number) => {
      removeFavoriteId(id);
      if (username) enqueueHnFavoriteAction(username, 'unfavorite', id);
    },
    [username],
  );
  const isFavorite = useCallback(
    (id: number) => favoriteIds.has(id),
    [favoriteIds],
  );
  const toggleFavorite = useCallback(
    (id: number) => {
      if (favoriteIds.has(id)) {
        removeFavoriteId(id);
        if (username) enqueueHnFavoriteAction(username, 'unfavorite', id);
      } else {
        addFavoriteId(id);
        if (username) enqueueHnFavoriteAction(username, 'favorite', id);
      }
    },
    [favoriteIds, username],
  );

  return { favoriteIds, favorite, unfavorite, isFavorite, toggleFavorite };
}
