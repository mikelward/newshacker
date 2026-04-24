import { useCallback, useEffect, useState } from 'react';
import {
  HIDDEN_STORIES_CHANGE_EVENT,
  clearHiddenIds,
  getHiddenEntries,
  removeHiddenId,
} from '../lib/hiddenStories';
import {
  OPENED_STORIES_CHANGE_EVENT,
  getOpenedIds,
} from '../lib/openedStories';
import { LibraryStoryList } from '../components/LibraryStoryList';
import './HistoryToolbar.css';

function readHiddenIdsNewestFirst(): number[] {
  const opened = getOpenedIds();
  return getHiddenEntries()
    .filter((e) => !opened.has(e.id))
    .sort((a, b) => b.at - a.at)
    .map((e) => e.id);
}

export function HiddenPage() {
  const [ids, setIds] = useState<number[]>(() => readHiddenIdsNewestFirst());

  useEffect(() => {
    const sync = () => setIds(readHiddenIdsNewestFirst());
    window.addEventListener(HIDDEN_STORIES_CHANGE_EVENT, sync);
    window.addEventListener(OPENED_STORIES_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(HIDDEN_STORIES_CHANGE_EVENT, sync);
      window.removeEventListener(OPENED_STORIES_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const handleUnhide = useCallback((id: number) => {
    removeHiddenId(id);
  }, []);

  const handleForgetAll = useCallback(() => {
    const count = ids.length;
    if (count === 0) return;
    const noun = count === 1 ? 'story' : 'stories';
    const ok = window.confirm(
      `Forget all ${count} hidden ${noun}? They can reappear in your feeds.`,
    );
    if (!ok) return;
    clearHiddenIds();
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
            Forget all hidden
          </button>
        </div>
      ) : null}
      <LibraryStoryList
        queryKey="hidden"
        ids={ids}
        emptyMessage="Nothing hidden. Stories you swipe away or scroll past without opening appear here."
        recover={{
          label: () => 'Unhide',
          onRecover: handleUnhide,
        }}
      />
    </>
  );
}
