import { useCallback, useEffect, useState } from 'react';
import {
  PINNED_STORIES_CHANGE_EVENT,
  addPinnedId,
  getPinnedIds,
  removePinnedId,
} from '../lib/pinnedStories';

export function usePinnedStories() {
  const [pinnedIds, setPinnedIds] = useState<Set<number>>(() => getPinnedIds());

  useEffect(() => {
    const sync = () => setPinnedIds(getPinnedIds());
    window.addEventListener(PINNED_STORIES_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(PINNED_STORIES_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const pin = useCallback((id: number) => addPinnedId(id), []);
  const unpin = useCallback((id: number) => removePinnedId(id), []);
  const isPinned = useCallback(
    (id: number) => pinnedIds.has(id),
    [pinnedIds],
  );
  const togglePinned = useCallback(
    (id: number) => {
      if (pinnedIds.has(id)) removePinnedId(id);
      else addPinnedId(id);
    },
    [pinnedIds],
  );

  return { pinnedIds, pin, unpin, isPinned, togglePinned };
}
