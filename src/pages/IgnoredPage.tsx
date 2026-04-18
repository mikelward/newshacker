import { useCallback, useEffect, useState } from 'react';
import {
  DISMISSED_STORIES_CHANGE_EVENT,
  getDismissedEntries,
  removeDismissedId,
} from '../lib/dismissedStories';
import {
  OPENED_STORIES_CHANGE_EVENT,
  getOpenedIds,
} from '../lib/openedStories';
import { SavedStoryList } from '../components/SavedStoryList';

function readIgnoredIdsNewestFirst(): number[] {
  const opened = getOpenedIds();
  return getDismissedEntries()
    .filter((e) => !opened.has(e.id))
    .sort((a, b) => b.at - a.at)
    .map((e) => e.id);
}

export function IgnoredPage() {
  const [ids, setIds] = useState<number[]>(() => readIgnoredIdsNewestFirst());

  useEffect(() => {
    const sync = () => setIds(readIgnoredIdsNewestFirst());
    window.addEventListener(DISMISSED_STORIES_CHANGE_EVENT, sync);
    window.addEventListener(OPENED_STORIES_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(DISMISSED_STORIES_CHANGE_EVENT, sync);
      window.removeEventListener(OPENED_STORIES_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const handleUnignore = useCallback((id: number) => {
    removeDismissedId(id);
  }, []);

  return (
    <SavedStoryList
      queryKey="ignored"
      ids={ids}
      emptyMessage="Nothing ignored. Stories you scroll past without opening appear here."
      recover={{
        label: () => 'Un-ignore',
        onRecover: handleUnignore,
      }}
    />
  );
}
