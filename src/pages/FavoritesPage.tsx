import { useCallback, useEffect, useState } from 'react';
import {
  FAVORITES_CHANGE_EVENT,
  getFavoriteEntries,
  removeFavoriteId,
} from '../lib/favorites';
import { LibraryStoryList } from '../components/LibraryStoryList';

function readFavoriteIdsNewestFirst(): number[] {
  return getFavoriteEntries()
    .sort((a, b) => b.at - a.at)
    .map((e) => e.id);
}

export function FavoritesPage() {
  const [ids, setIds] = useState<number[]>(() => readFavoriteIdsNewestFirst());

  useEffect(() => {
    const sync = () => setIds(readFavoriteIdsNewestFirst());
    window.addEventListener(FAVORITES_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(FAVORITES_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const handleUnfavorite = useCallback((id: number) => {
    removeFavoriteId(id);
  }, []);

  return (
    <LibraryStoryList
      queryKey="favorites"
      ids={ids}
      emptyMessage="No favorites yet. Tap Favorite on a story page to keep it here for good."
      recover={{
        label: () => 'Unfavorite',
        onRecover: handleUnfavorite,
      }}
    />
  );
}
