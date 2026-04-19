import { useCallback, useEffect, useState } from 'react';
import {
  FAVORITES_CHANGE_EVENT,
  addFavoriteId,
  getFavoriteIds,
  removeFavoriteId,
} from '../lib/favorites';

export function useFavorites() {
  const [favoriteIds, setFavoriteIds] = useState<Set<number>>(() =>
    getFavoriteIds(),
  );

  useEffect(() => {
    const sync = () => setFavoriteIds(getFavoriteIds());
    window.addEventListener(FAVORITES_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(FAVORITES_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const favorite = useCallback((id: number) => addFavoriteId(id), []);
  const unfavorite = useCallback((id: number) => removeFavoriteId(id), []);
  const isFavorite = useCallback(
    (id: number) => favoriteIds.has(id),
    [favoriteIds],
  );
  const toggleFavorite = useCallback(
    (id: number) => {
      if (favoriteIds.has(id)) removeFavoriteId(id);
      else addFavoriteId(id);
    },
    [favoriteIds],
  );

  return { favoriteIds, favorite, unfavorite, isFavorite, toggleFavorite };
}
