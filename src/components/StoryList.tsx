import { useCallback, useState } from 'react';
import type { Feed } from '../lib/feeds';
import { PAGE_SIZE, useStoryPage } from '../hooks/useStoryList';
import { useInfiniteScroll } from '../hooks/useInfiniteScroll';
import { StoryListItem } from './StoryListItem';
import { StoryRowSkeleton } from './Skeletons';
import { ErrorState, EmptyState } from './States';
import './StoryList.css';

interface Props {
  feed: Feed;
}

export function StoryList({ feed }: Props) {
  const [page, setPage] = useState(0);
  const { ids, items, slice, totalIds } = useStoryPage(feed, page);

  const canLoadMore = slice.length < totalIds;
  const isFetching = items.isFetching || ids.isFetching;

  const handleLoadMore = useCallback(() => {
    if (!isFetching && canLoadMore) setPage((p) => p + 1);
  }, [isFetching, canLoadMore]);

  const sentinelRef = useInfiniteScroll<HTMLDivElement>({
    enabled: canLoadMore && !isFetching,
    onLoadMore: handleLoadMore,
  });

  if (ids.isLoading || (items.isLoading && slice.length > 0)) {
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

  if (ids.isError || items.isError) {
    return (
      <ErrorState
        message="Could not load stories."
        onRetry={() => {
          ids.refetch();
          items.refetch();
        }}
      />
    );
  }

  const stories = (items.data ?? []).filter(
    (it): it is NonNullable<typeof it> => it != null && !it.deleted && !it.dead,
  );

  if (stories.length === 0) {
    return <EmptyState message="No stories yet." />;
  }

  return (
    <>
      <ol className="story-list">
        {stories.map((story, idx) => (
          <li key={story.id} className="story-list__item">
            <StoryListItem story={story} rank={idx + 1} />
          </li>
        ))}
      </ol>
      {canLoadMore ? (
        <div className="story-list__more">
          <div
            ref={sentinelRef}
            className="story-list__sentinel"
            aria-hidden="true"
          />
          <button
            type="button"
            className="load-more-btn"
            onClick={handleLoadMore}
            disabled={isFetching}
          >
            {isFetching ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}
    </>
  );
}

export { PAGE_SIZE };
