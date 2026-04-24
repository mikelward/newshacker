import { useEffect, useState } from 'react';
import {
  PINNED_STORIES_CHANGE_EVENT,
  getPinnedEntries,
} from '../lib/pinnedStories';
import { LibraryStoryList } from '../components/LibraryStoryList';

function readPinnedIdsNewestFirst(): number[] {
  return getPinnedEntries()
    .sort((a, b) => b.at - a.at)
    .map((e) => e.id);
}

export function PinnedPage() {
  const [ids, setIds] = useState<number[]>(() => readPinnedIdsNewestFirst());

  useEffect(() => {
    const sync = () => setIds(readPinnedIdsNewestFirst());
    window.addEventListener(PINNED_STORIES_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(PINNED_STORIES_CHANGE_EVENT, sync);
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
