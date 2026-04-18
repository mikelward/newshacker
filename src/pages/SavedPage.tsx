import { useCallback, useEffect, useState } from 'react';
import {
  SAVED_STORIES_CHANGE_EVENT,
  getSavedEntries,
  removeSavedId,
} from '../lib/savedStories';
import { SavedStoryList } from '../components/SavedStoryList';

function readSavedIdsNewestFirst(): number[] {
  return getSavedEntries()
    .sort((a, b) => b.at - a.at)
    .map((e) => e.id);
}

export function SavedPage() {
  const [ids, setIds] = useState<number[]>(() => readSavedIdsNewestFirst());

  useEffect(() => {
    const sync = () => setIds(readSavedIdsNewestFirst());
    window.addEventListener(SAVED_STORIES_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(SAVED_STORIES_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const handleUnsave = useCallback((id: number) => {
    removeSavedId(id);
  }, []);

  return (
    <SavedStoryList
      queryKey="saved"
      ids={ids}
      emptyMessage="Nothing saved yet. Swipe a story left, or tap Save on the story page, to keep it here."
      recover={{
        label: () => 'Unsave',
        onRecover: handleUnsave,
      }}
    />
  );
}
