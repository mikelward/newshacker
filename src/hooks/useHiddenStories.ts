import { useCallback, useEffect, useState } from 'react';
import {
  HIDDEN_STORIES_CHANGE_EVENT,
  addHiddenId,
  addHiddenIds,
  getHiddenIds,
  removeHiddenId,
} from '../lib/hiddenStories';
import { removePinnedId, removePinnedIds } from '../lib/pinnedStories';

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
  // Batched hide for bulk Sweep: one pin-store write + one hidden-store
  // write + one change event for the whole batch, instead of a pair per
  // row. Enforces the same Pin ↔ Hide shield as `hide`.
  const hideMany = useCallback((ids: readonly number[]) => {
    if (ids.length === 0) return;
    removePinnedIds(ids);
    addHiddenIds(ids);
  }, []);
  const unhide = useCallback((id: number) => removeHiddenId(id), []);
  const isHidden = useCallback(
    (id: number) => hiddenIds.has(id),
    [hiddenIds],
  );

  return { hiddenIds, hide, hideMany, unhide, isHidden };
}
