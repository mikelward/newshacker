import { useCallback, useEffect, useState } from 'react';
import {
  DISMISSED_STORIES_CHANGE_EVENT,
  clearDismissedIds,
  getDismissedEntries,
  removeDismissedId,
} from '../lib/dismissedStories';
import {
  OPENED_STORIES_CHANGE_EVENT,
  getOpenedIds,
} from '../lib/openedStories';
import { LibraryStoryList } from '../components/LibraryStoryList';
import './HistoryToolbar.css';

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

  const handleForgetAll = useCallback(() => {
    const count = ids.length;
    if (count === 0) return;
    const noun = count === 1 ? 'story' : 'stories';
    const ok = window.confirm(
      `Forget all ${count} ignored ${noun}? They can reappear in your feeds.`,
    );
    if (!ok) return;
    clearDismissedIds();
  }, [ids.length]);

  return (
    <>
      {ids.length > 0 ? (
        <div className="history-toolbar">
          <button
            type="button"
            className="history-toolbar__forget"
            onClick={handleForgetAll}
          >
            Forget all ignored
          </button>
        </div>
      ) : null}
      <LibraryStoryList
        queryKey="ignored"
        ids={ids}
        emptyMessage="Nothing ignored. Stories you swipe away or scroll past without opening appear here."
        recover={{
          label: () => 'Un-ignore',
          onRecover: handleUnignore,
        }}
      />
    </>
  );
}
