import { useCallback, useEffect, useState } from 'react';
import {
  DONE_STORIES_CHANGE_EVENT,
  clearDoneIds,
  getDoneEntries,
  removeDoneId,
} from '../lib/doneStories';
import { LibraryStoryList } from '../components/LibraryStoryList';
import './HistoryToolbar.css';

function readDoneIdsNewestFirst(): number[] {
  return getDoneEntries()
    .sort((a, b) => b.at - a.at)
    .map((e) => e.id);
}

export function DonePage() {
  const [ids, setIds] = useState<number[]>(() => readDoneIdsNewestFirst());

  useEffect(() => {
    const sync = () => setIds(readDoneIdsNewestFirst());
    window.addEventListener(DONE_STORIES_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(DONE_STORIES_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const handleUnmarkDone = useCallback((id: number) => {
    removeDoneId(id);
  }, []);

  const handleForgetAll = useCallback(() => {
    const count = ids.length;
    if (count === 0) return;
    const noun = count === 1 ? 'story' : 'stories';
    const ok = window.confirm(
      `Forget all ${count} done ${noun}? They can reappear in your feeds.`,
    );
    if (!ok) return;
    clearDoneIds();
  }, [ids.length]);

  return (
    <>
      {ids.length > 0 ? (
        <div className="history-toolbar">
          <button
            type="button"
            className="nh-action-btn"
            onClick={handleForgetAll}
          >
            Forget all done
          </button>
        </div>
      ) : null}
      <LibraryStoryList
        queryKey="done"
        ids={ids}
        emptyMessage="Nothing marked done yet. Tap the check on a thread when you've finished reading it."
        recover={{
          label: () => 'Unmark done',
          onRecover: handleUnmarkDone,
        }}
      />
    </>
  );
}
