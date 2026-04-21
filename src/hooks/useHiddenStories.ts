import { useCallback, useEffect, useState } from 'react';
import {
  HIDDEN_STORIES_CHANGE_EVENT,
  addHiddenId,
  getHiddenIds,
  removeHiddenId,
} from '../lib/hiddenStories';

export function useHiddenStories() {
  const [hiddenIds, setHiddenIds] = useState<Set<number>>(() =>
    getHiddenIds(),
  );

  useEffect(() => {
    const sync = () => setHiddenIds(getHiddenIds());
    window.addEventListener(HIDDEN_STORIES_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(HIDDEN_STORIES_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const hide = useCallback((id: number) => addHiddenId(id), []);
  const unhide = useCallback((id: number) => removeHiddenId(id), []);
  const isHidden = useCallback(
    (id: number) => hiddenIds.has(id),
    [hiddenIds],
  );

  return { hiddenIds, hide, unhide, isHidden };
}
