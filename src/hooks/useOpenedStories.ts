import { useCallback, useEffect, useState } from 'react';
import {
  OPENED_STORIES_CHANGE_EVENT,
  type OpenedKind,
  addOpenedId,
  getArticleOpenedIds,
  getCommentsOpenedIds,
  getOpenedIds,
  markArticleOpenedId,
  markCommentsOpenedId,
  removeOpenedId,
} from '../lib/openedStories';

interface Snapshot {
  openedIds: Set<number>;
  articleOpenedIds: Set<number>;
  commentsOpenedIds: Set<number>;
}

function snapshot(): Snapshot {
  return {
    openedIds: getOpenedIds(),
    articleOpenedIds: getArticleOpenedIds(),
    commentsOpenedIds: getCommentsOpenedIds(),
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

  const markOpened = useCallback((id: number, kind: OpenedKind) => {
    if (kind === 'article') markArticleOpenedId(id);
    else markCommentsOpenedId(id);
  }, []);
  const markBothOpened = useCallback((id: number) => addOpenedId(id), []);
  const unopen = useCallback((id: number) => removeOpenedId(id), []);

  return {
    openedIds: state.openedIds,
    articleOpenedIds: state.articleOpenedIds,
    commentsOpenedIds: state.commentsOpenedIds,
    markOpened,
    markBothOpened,
    unopen,
  };
}
