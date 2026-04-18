import { useCallback, useEffect, useState } from 'react';
import {
  OPENED_STORIES_CHANGE_EVENT,
  clearOpenedIds,
  getOpenedEntries,
} from '../lib/openedStories';
import { SavedStoryList } from '../components/SavedStoryList';
import './HistoryToolbar.css';

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

  const handleForgetAll = useCallback(() => {
    const count = ids.length;
    if (count === 0) return;
    const noun = count === 1 ? 'story' : 'stories';
    const ok = window.confirm(
      `Forget all ${count} opened ${noun}? They'll no longer be marked as read.`,
    );
    if (!ok) return;
    clearOpenedIds();
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
            Forget all opened
          </button>
        </div>
      ) : null}
      <SavedStoryList
        queryKey="opened"
        ids={ids}
        emptyMessage="You haven't opened any stories yet."
      />
    </>
  );
}
