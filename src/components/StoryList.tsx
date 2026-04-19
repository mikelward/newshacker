import { useCallback, useEffect, useMemo } from 'react';
import type { Feed } from '../lib/feeds';
import { PAGE_SIZE, useFeedItems } from '../hooks/useStoryList';
import { useInfiniteScroll } from '../hooks/useInfiniteScroll';
import { useDismissedStories } from '../hooks/useDismissedStories';
import { useOpenedStories } from '../hooks/useOpenedStories';
import { useSavedStories } from '../hooks/useSavedStories';
import { StoryListItem } from './StoryListItem';
import { StoryRowSkeleton } from './Skeletons';
import { ErrorState, EmptyState } from './States';
import { useShareStory } from '../hooks/useShareStory';
import { markCommentsOpenedId } from '../lib/openedStories';
import { useFeedBar } from '../hooks/useFeedBar';
import './StoryList.css';

interface Props {
  feed: Feed;
}

export function StoryList({ feed }: Props) {
  const feedItems = useFeedItems(feed);
  const { dismissedIds, dismiss, undismiss } = useDismissedStories();
  const { articleOpenedIds, commentsOpenedIds } = useOpenedStories();
  const { savedIds, save, unsave } = useSavedStories();
  const shareStory = useShareStory();
  const { setSweep, showDismissed } = useFeedBar();

  const { items, hasMore, isFetchingMore, loadMore, refetch, isError } =
    feedItems;

  const sentinelRef = useInfiniteScroll<HTMLDivElement>({
    enabled: hasMore && !isFetchingMore,
    onLoadMore: loadMore,
  });

  const visibleStories = useMemo(
    () =>
      items.filter(
        (it): it is NonNullable<typeof it> =>
          it != null &&
          !it.deleted &&
          !it.dead &&
          (showDismissed || !dismissedIds.has(it.id)),
      ),
    [items, dismissedIds, showDismissed],
  );

  const sweepableIds = useMemo(
    () =>
      visibleStories
        .map((s) => s.id)
        .filter((id) => !savedIds.has(id) && !dismissedIds.has(id)),
    [visibleStories, savedIds, dismissedIds],
  );

  const handleSweep = useCallback(() => {
    if (sweepableIds.length === 0) return;
    for (const id of sweepableIds) dismiss(id);
  }, [sweepableIds, dismiss]);

  useEffect(() => {
    setSweep(handleSweep, sweepableIds.length);
    return () => setSweep(null, 0);
  }, [setSweep, handleSweep, sweepableIds.length]);

  const handleOpenThread = useCallback(
    (id: number) => {
      markCommentsOpenedId(id);
      if (dismissedIds.has(id)) undismiss(id);
    },
    [dismissedIds, undismiss],
  );

  const hasAnyItems = items.length > 0;
  if (!hasAnyItems && feedItems.isLoading) {
    return (
      <ol className="story-list" aria-busy="true" aria-label="Loading stories">
        {Array.from({ length: 6 }).map((_, i) => (
          <li key={i} className="story-list__item">
            <StoryRowSkeleton />
          </li>
        ))}
      </ol>
    );
  }

  if (isError) {
    return (
      <ErrorState message="Could not load stories." onRetry={refetch} />
    );
  }

  if (visibleStories.length === 0 && !hasMore) {
    return <EmptyState message="No stories yet." />;
  }

  return (
    <>
      <ol className="story-list">
        {visibleStories.map((story, idx) => (
          <li
            key={story.id}
            className="story-list__item"
            data-story-id={story.id}
          >
            <StoryListItem
              story={story}
              rank={idx + 1}
              articleOpened={articleOpenedIds.has(story.id)}
              commentsOpened={commentsOpenedIds.has(story.id)}
              saved={savedIds.has(story.id)}
              dismissed={dismissedIds.has(story.id)}
              onDismiss={dismiss}
              onSave={save}
              onUnsave={unsave}
              onShare={shareStory}
              onOpenThread={handleOpenThread}
            />
          </li>
        ))}
      </ol>
      {hasMore ? (
        <div className="story-list__more">
          <div
            ref={sentinelRef}
            className="story-list__sentinel"
            aria-hidden="true"
          />
          <button
            type="button"
            className="load-more-btn"
            onClick={loadMore}
            disabled={isFetchingMore}
          >
            {isFetchingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}
    </>
  );
}

export { PAGE_SIZE };
