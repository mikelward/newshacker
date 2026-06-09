import { useEffect, useMemo, useState } from 'react';
import {
  FAVORITES_CHANGE_EVENT,
  getFavoriteEntries,
} from '../lib/favorites';
import { useFavorites } from '../hooks/useFavorites';
import { LibraryStoryList } from '../components/LibraryStoryList';
import { HeartFilledIcon } from '../components/icons';

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

  // Route through useFavorites().unfavorite, not the raw store helper:
  // this is a user-originated unfavorite, so for signed-in users it
  // must also enqueue the write-back that unfavorites the story on HN.
  const { unfavorite } = useFavorites();

  const rightAction = useMemo(
    () => ({
      label: 'Unfavorite',
      icon: <HeartFilledIcon />,
      onToggle: unfavorite,
    }),
    [unfavorite],
  );

  return (
    <LibraryStoryList
      queryKey="favorites"
      ids={ids}
      emptyMessage="No favorites yet. Tap Favorite on a story page to keep it here for good."
      rightAction={rightAction}
    />
  );
}
