import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BackToTopButton } from '../components/BackToTopButton';
import { EmptyState } from '../components/States';
import { StoryListItem } from '../components/StoryListItem';
import { useDoneStories } from '../hooks/useDoneStories';
import { useHiddenStories } from '../hooks/useHiddenStories';
import { useHotThresholds } from '../hooks/useHotThresholds';
import { useOpenedStories } from '../hooks/useOpenedStories';
import { usePinnedStories } from '../hooks/usePinnedStories';
import { useShareStory } from '../hooks/useShareStory';
import type { ItemRoot } from '../hooks/useItemTree';
import { isHotStory } from '../lib/format';
import type { HNItem } from '../lib/hn';
import { markCommentsOpenedId } from '../lib/openedStories';
import { getOfflineCacheStatus } from '../lib/offlineCacheStatus';
import { prefetchPinnedStory } from '../lib/pinnedStoryPrefetch';
import './OfflinePage.css';

interface OfflineStoryEntry {
  story: HNItem;
  cachedAt: number;
}

function isOfflineStory(item: HNItem): boolean {
  return item.type === 'story' && !item.deleted && !item.dead;
}

export function OfflinePage() {
  const queryClient = useQueryClient();
  const [cacheVersion, setCacheVersion] = useState(0);
  const { hiddenIds, hide } = useHiddenStories();
  const { doneIds } = useDoneStories();
  const { articleOpenedIds, commentsOpenedIds, seenCommentCounts, unopen } =
    useOpenedStories();
  const { pinnedIds, pin, unpin } = usePinnedStories();
  const shareStory = useShareStory();
  const { prefs: hotThresholds } = useHotThresholds();

  useEffect(() => {
    return queryClient.getQueryCache().subscribe((event) => {
      const key = event.query.queryKey;
      if (key[0] !== 'itemRoot') return;
      setCacheVersion((version) => version + 1);
    });
  }, [queryClient]);

  const entries = useMemo<OfflineStoryEntry[]>(() => {
    void cacheVersion;
    return queryClient
      .getQueryCache()
      .getAll()
      .flatMap((query): OfflineStoryEntry[] => {
        const key = query.queryKey;
        if (key[0] !== 'itemRoot' || typeof key[1] !== 'number') return [];
        const root = query.state.data as ItemRoot | null | undefined;
        if (!root || !isOfflineStory(root.item)) return [];
        if (hiddenIds.has(root.item.id) || doneIds.has(root.item.id)) return [];
        if (getOfflineCacheStatus(queryClient, root.item.id).root !== 'present') {
          return [];
        }
        return [{ story: root.item, cachedAt: query.state.dataUpdatedAt }];
      })
      .sort((a, b) => b.cachedAt - a.cachedAt);
  }, [cacheVersion, doneIds, hiddenIds, queryClient]);

  const handleOpenThread = useCallback(
    (id: number) => {
      const entry = entries.find((candidate) => candidate.story.id === id);
      markCommentsOpenedId(id, Date.now(), entry?.story.descendants ?? 0);
    },
    [entries],
  );

  const handleMarkUnread = useCallback((id: number) => unopen(id), [unopen]);
  const handlePin = useCallback(
    (id: number) => {
      pin(id);
      const entry = entries.find((candidate) => candidate.story.id === id);
      if (!entry) return;
      void queryClient.invalidateQueries({
        queryKey: ['itemRoot', id],
        exact: true,
        refetchType: 'none',
      });
      prefetchPinnedStory(queryClient, entry.story);
    },
    [entries, pin, queryClient],
  );
  const computeFlag = (story: HNItem) =>
    isHotStory(story, new Date(), hotThresholds) ? ('hot' as const) : null;

  if (entries.length === 0) {
    return (
      <EmptyState message="No offline stories yet. Pin or open stories while online to keep them available here." />
    );
  }

  return (
    <>
      <div className="offline-page__intro" role="note">
        Stories cached on this device, newest cache first.
      </div>
      <ol className="story-list">
        {entries.map(({ story }, idx) => (
          <li key={story.id} className="story-list__item">
            <StoryListItem
              story={story}
              rank={idx + 1}
              flag={computeFlag(story)}
              articleOpened={articleOpenedIds.has(story.id)}
              commentsOpened={commentsOpenedIds.has(story.id)}
              seenCommentCount={seenCommentCounts.get(story.id)}
              pinned={pinnedIds.has(story.id)}
              onHide={hide}
              onPin={handlePin}
              onUnpin={unpin}
              onShare={shareStory}
              onMarkUnread={handleMarkUnread}
              onOpenThread={handleOpenThread}
            />
          </li>
        ))}
      </ol>
      <div className="story-list__footer">
        <BackToTopButton />
      </div>
    </>
  );
}
