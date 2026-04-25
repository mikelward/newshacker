import { useCallback, useEffect, useState } from 'react';
import {
  PINNED_STORIES_CHANGE_EVENT,
  addPinnedId,
  getPinnedIds,
  removePinnedId,
} from '../lib/pinnedStories';
import { removeDoneId } from '../lib/doneStories';
import { removeHiddenId } from '../lib/hiddenStories';

// Pinning a story enforces the spec's mutual-exclusion shields:
// Pin ↔ Hide (shield rule — a row can't be both at once) and
// Pin ↔ Done (Done is the exit lifecycle from Pin, so a story
// in both lists means we lost the lifecycle ordering). Both
// removals are tombstoned via the lib helpers so a subsequent
// cloud sync push propagates the cleanup to other devices —
// matching the symmetry `useDoneStories.markDone` already had
// for the Pin clear. Hidden ↔ Done coexistence is *allowed*
// (see the comment in `useDoneStories.markDone`), so this
// helper only touches Pin's two siblings.
function pinOne(id: number): void {
  removeDoneId(id);
  removeHiddenId(id);
  addPinnedId(id);
}

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

  const pin = useCallback((id: number) => pinOne(id), []);
  const unpin = useCallback((id: number) => removePinnedId(id), []);
  const isPinned = useCallback(
    (id: number) => pinnedIds.has(id),
    [pinnedIds],
  );
  const togglePinned = useCallback(
    (id: number) => {
      if (pinnedIds.has(id)) removePinnedId(id);
      else pinOne(id);
    },
    [pinnedIds],
  );

  return { pinnedIds, pin, unpin, isPinned, togglePinned };
}
