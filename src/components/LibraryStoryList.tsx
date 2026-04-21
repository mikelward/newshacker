import { useQuery } from '@tanstack/react-query';
import { getItems } from '../lib/hn';
import { useDismissedStories } from '../hooks/useDismissedStories';
import { useOpenedStories } from '../hooks/useOpenedStories';
import { usePinnedStories } from '../hooks/usePinnedStories';
import { PullToRefresh } from './PullToRefresh';
import { StoryListItem } from './StoryListItem';
import { StoryRowSkeleton } from './Skeletons';
import { EmptyState, ErrorState } from './States';
import { useShareStory } from '../hooks/useShareStory';
import { pullNow as cloudSyncPullNow } from '../lib/cloudSync';
import { markCommentsOpenedId } from '../lib/openedStories';
import './StoryList.css';

interface Props {
  queryKey: string;
  ids: number[];
  emptyMessage: string;
  recover?: {
    label: (id: number) => string;
    onRecover: (id: number) => void;
  };
}

export function LibraryStoryList({
  queryKey,
  ids,
  emptyMessage,
  recover,
}: Props) {
  const { dismiss } = useDismissedStories();
  const { articleOpenedIds, commentsOpenedIds } = useOpenedStories();
  const { pinnedIds, pin, unpin } = usePinnedStories();
  const shareStory = useShareStory();

  const items = useQuery({
    queryKey: [
      'libraryStoryItems',
      queryKey,
      ids.length,
      ids[0] ?? null,
      ids[ids.length - 1] ?? null,
    ],
    queryFn: ({ signal }) => getItems(ids, signal),
    enabled: ids.length > 0,
  });

  if (ids.length === 0) {
    return <EmptyState message={emptyMessage} />;
  }

  if (items.isLoading) {
    return (
      <ol
        className="story-list"
        aria-busy="true"
        aria-label="Loading stories"
      >
        {Array.from({ length: Math.min(ids.length, 6) }).map((_, i) => (
          <li key={i} className="story-list__item">
            <StoryRowSkeleton />
          </li>
        ))}
      </ol>
    );
  }

  if (items.isError) {
    return (
      <ErrorState
        message="Could not load stories."
        onRetry={() => items.refetch()}
      />
    );
  }

  const stories = (items.data ?? []).filter(
    (it): it is NonNullable<typeof it> => it != null,
  );

  if (stories.length === 0) {
    return <EmptyState message={emptyMessage} />;
  }

  return (
    <PullToRefresh
      onRefresh={() =>
        // Library pages (/pinned, /favorites, /ignored, /opened) read
        // from localStorage — refetching items alone can't surface a
        // story pinned on another device because the id isn't in the
        // local list yet. Pull cloudSync first to bring in any new
        // ids, then refetch the HN items.
        cloudSyncPullNow().then(() => items.refetch())
      }
    >
      <ol className="story-list">
        {stories.map((story, idx) => (
          <li key={story.id} className="story-list__item">
            <StoryListItem
              story={story}
              rank={idx + 1}
              articleOpened={articleOpenedIds.has(story.id)}
              commentsOpened={commentsOpenedIds.has(story.id)}
              pinned={pinnedIds.has(story.id)}
              onDismiss={dismiss}
              onPin={pin}
              onUnpin={unpin}
              onShare={shareStory}
              onOpenThread={markCommentsOpenedId}
            />
            {recover ? (
              <div className="story-list__recover">
                <button
                  type="button"
                  className="recover-btn"
                  onClick={() => recover.onRecover(story.id)}
                >
                  {recover.label(story.id)}
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </PullToRefresh>
  );
}
