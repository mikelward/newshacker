import { useEffect, useState } from 'react';
import {
  PINNED_STORIES_CHANGE_EVENT,
  getPinnedEntries,
} from '../lib/pinnedStories';
import {
  HIDDEN_STORIES_CHANGE_EVENT,
  getHiddenIds,
} from '../lib/hiddenStories';
import { LibraryStoryList } from '../components/LibraryStoryList';

// A story can land in both the pinned and hidden lists — not from local use
// (Pin shields a row from Hide and vice versa), but from cross-device sync,
// where `applyServerState` merges the two lists independently. Hide is the
// stronger, more recent signal, so a colliding story shows on /hidden (with a
// working Unhide) and is withheld here until the hidden entry's 7-day TTL
// expires, at which point the permanent pin resurfaces (getHiddenIds prunes by
// TTL at read time). Without this filter the row would render on /pinned with
// an inert Unpin button, since LibraryStoryList withholds onUnpin for hidden
// rows to avoid re-creating the collision.
function readVisiblePinnedIdsOldestFirst(): number[] {
  const hidden = getHiddenIds();
  return getPinnedEntries()
    .filter((e) => !hidden.has(e.id))
    .sort((a, b) => a.at - b.at)
    .map((e) => e.id);
}

export function PinnedPage() {
  const [ids, setIds] = useState<number[]>(() =>
    readVisiblePinnedIdsOldestFirst(),
  );

  useEffect(() => {
    const sync = () => setIds(readVisiblePinnedIdsOldestFirst());
    window.addEventListener(PINNED_STORIES_CHANGE_EVENT, sync);
    window.addEventListener(HIDDEN_STORIES_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(PINNED_STORIES_CHANGE_EVENT, sync);
      window.removeEventListener(HIDDEN_STORIES_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  return (
    <LibraryStoryList
      queryKey="pinned"
      ids={ids}
      emptyMessage="Nothing pinned yet. Tap the pin on a row, swipe a story left, or pin from the story page to keep it here."
    />
  );
}
