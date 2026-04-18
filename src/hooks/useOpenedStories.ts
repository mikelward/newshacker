import { useCallback, useEffect, useState } from 'react';
import {
  OPENED_STORIES_CHANGE_EVENT,
  addOpenedId,
  getOpenedIds,
  removeOpenedId,
} from '../lib/openedStories';

export function useOpenedStories() {
  const [openedIds, setOpenedIds] = useState<Set<number>>(() => getOpenedIds());

  useEffect(() => {
    const sync = () => setOpenedIds(getOpenedIds());
    window.addEventListener(OPENED_STORIES_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(OPENED_STORIES_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const markOpened = useCallback((id: number) => addOpenedId(id), []);
  const unopen = useCallback((id: number) => removeOpenedId(id), []);
  const isOpened = useCallback(
    (id: number) => openedIds.has(id),
    [openedIds],
  );

  return { openedIds, markOpened, unopen, isOpened };
}
