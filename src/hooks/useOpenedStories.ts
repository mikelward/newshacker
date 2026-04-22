import { useCallback, useEffect, useState } from 'react';
import {
  OPENED_STORIES_CHANGE_EVENT,
  type OpenedKind,
  addOpenedId,
  getArticleOpenedIds,
  getCommentsOpenedIds,
  getOpenedIds,
  getSeenCommentCounts,
  markArticleOpenedId,
  markCommentsOpenedId,
  removeOpenedId,
} from '../lib/openedStories';

interface Snapshot {
  openedIds: Set<number>;
  articleOpenedIds: Set<number>;
  commentsOpenedIds: Set<number>;
  seenCommentCounts: Map<number, number>;
}

function snapshot(): Snapshot {
  return {
    openedIds: getOpenedIds(),
    articleOpenedIds: getArticleOpenedIds(),
    commentsOpenedIds: getCommentsOpenedIds(),
    seenCommentCounts: getSeenCommentCounts(),
  };
}

export function useOpenedStories() {
  const [state, setState] = useState<Snapshot>(() => snapshot());

  useEffect(() => {
    const sync = () => setState(snapshot());
    window.addEventListener(OPENED_STORIES_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(OPENED_STORIES_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const markOpened = useCallback(
    (id: number, kind: OpenedKind, commentsCount?: number) => {
      if (kind === 'article') markArticleOpenedId(id);
      else markCommentsOpenedId(id, Date.now(), commentsCount);
    },
    [],
  );
  const markBothOpened = useCallback(
    (id: number, commentsCount?: number) =>
      addOpenedId(id, Date.now(), commentsCount),
    [],
  );
  const unopen = useCallback((id: number) => removeOpenedId(id), []);

  return {
    openedIds: state.openedIds,
    articleOpenedIds: state.articleOpenedIds,
    commentsOpenedIds: state.commentsOpenedIds,
    seenCommentCounts: state.seenCommentCounts,
    markOpened,
    markBothOpened,
    unopen,
  };
}
