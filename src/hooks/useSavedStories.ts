import { useCallback, useEffect, useState } from 'react';
import {
  SAVED_STORIES_CHANGE_EVENT,
  addSavedId,
  getSavedIds,
  removeSavedId,
} from '../lib/savedStories';

export function useSavedStories() {
  const [savedIds, setSavedIds] = useState<Set<number>>(() => getSavedIds());

  useEffect(() => {
    const sync = () => setSavedIds(getSavedIds());
    window.addEventListener(SAVED_STORIES_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(SAVED_STORIES_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const save = useCallback((id: number) => addSavedId(id), []);
  const unsave = useCallback((id: number) => removeSavedId(id), []);
  const isSaved = useCallback(
    (id: number) => savedIds.has(id),
    [savedIds],
  );
  const toggleSaved = useCallback(
    (id: number) => {
      if (savedIds.has(id)) removeSavedId(id);
      else addSavedId(id);
    },
    [savedIds],
  );

  return { savedIds, save, unsave, isSaved, toggleSaved };
}
