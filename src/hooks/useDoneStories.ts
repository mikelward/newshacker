import { useCallback, useEffect, useState } from 'react';
import {
  DONE_STORIES_CHANGE_EVENT,
  addDoneId,
  getDoneIds,
  removeDoneId,
} from '../lib/doneStories';
import { removePinnedId } from '../lib/pinnedStories';

export function useDoneStories() {
  const [doneIds, setDoneIds] = useState<Set<number>>(() => getDoneIds());

  useEffect(() => {
    const sync = () => setDoneIds(getDoneIds());
    window.addEventListener(DONE_STORIES_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(DONE_STORIES_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  // Marking a story done also unpins it — Pin is the active reading
  // queue, Done is the completion log, and a story can't be in both.
  // Favorites are orthogonal (a keepsake) and left untouched. Hidden
  // is also left alone; Done's list filter supersedes it anyway.
  const markDone = useCallback((id: number) => {
    addDoneId(id);
    removePinnedId(id);
  }, []);
  const unmarkDone = useCallback((id: number) => {
    removeDoneId(id);
  }, []);
  const isDone = useCallback((id: number) => doneIds.has(id), [doneIds]);
  const toggleDone = useCallback(
    (id: number) => {
      if (doneIds.has(id)) {
        removeDoneId(id);
      } else {
        addDoneId(id);
        removePinnedId(id);
      }
    },
    [doneIds],
  );

  return { doneIds, markDone, unmarkDone, isDone, toggleDone };
}
