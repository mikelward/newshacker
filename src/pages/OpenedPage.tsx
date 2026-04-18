import { useEffect, useState } from 'react';
import {
  OPENED_STORIES_CHANGE_EVENT,
  getOpenedEntries,
} from '../lib/openedStories';
import { SavedStoryList } from '../components/SavedStoryList';

function readIdsNewestFirst(): number[] {
  return getOpenedEntries()
    .sort((a, b) => b.at - a.at)
    .map((e) => e.id);
}

export function OpenedPage() {
  const [ids, setIds] = useState<number[]>(() => readIdsNewestFirst());

  useEffect(() => {
    const sync = () => setIds(readIdsNewestFirst());
    window.addEventListener(OPENED_STORIES_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(OPENED_STORIES_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  return (
    <SavedStoryList
      queryKey="opened"
      ids={ids}
      emptyMessage="You haven't opened any stories yet."
    />
  );
}
