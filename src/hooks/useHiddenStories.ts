import { useCallback, useEffect, useState } from 'react';
import {
  HIDDEN_STORIES_CHANGE_EVENT,
  addHiddenId,
  getHiddenIds,
  removeHiddenId,
} from '../lib/hiddenStories';
import { removePinnedId } from '../lib/pinnedStories';

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

  // Hide enforces the Pin ↔ Hide shield: a row can't be both
  // hidden and pinned. Without this clear, a future caller that
  // bypasses the row-level UI guard (cloud sync, scripted
  // mutation, etc.) could leave the stores drifted into the
  // pin∩hide pair the rest of the codebase exists to prevent.
  // The Pin removal is tombstoned via the lib helper so the
  // cleanup propagates on the next cloud-sync push. Hide ↔ Done
  // coexistence is allowed (see useDoneStories.markDone's
  // comment) — this only touches Pin.
  const hide = useCallback((id: number) => {
    removePinnedId(id);
    addHiddenId(id);
  }, []);
  const unhide = useCallback((id: number) => removeHiddenId(id), []);
  const isHidden = useCallback(
    (id: number) => hiddenIds.has(id),
    [hiddenIds],
  );

  return { hiddenIds, hide, unhide, isHidden };
}
