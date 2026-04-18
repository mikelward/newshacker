import { useCallback, useEffect, useState } from 'react';
import {
  DISMISSED_STORIES_CHANGE_EVENT,
  addDismissedId,
  getDismissedIds,
  removeDismissedId,
} from '../lib/dismissedStories';

export function useDismissedStories() {
  const [dismissedIds, setDismissedIds] = useState<Set<number>>(() =>
    getDismissedIds(),
  );

  useEffect(() => {
    const sync = () => setDismissedIds(getDismissedIds());
    window.addEventListener(DISMISSED_STORIES_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(DISMISSED_STORIES_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const dismiss = useCallback((id: number) => addDismissedId(id), []);
  const undismiss = useCallback((id: number) => removeDismissedId(id), []);
  const isDismissed = useCallback(
    (id: number) => dismissedIds.has(id),
    [dismissedIds],
  );

  return { dismissedIds, dismiss, undismiss, isDismissed };
}
