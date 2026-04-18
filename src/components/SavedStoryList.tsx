import { useQuery } from '@tanstack/react-query';
import { getItems } from '../lib/hn';
import { useDismissedStories } from '../hooks/useDismissedStories';
import { useOpenedStories } from '../hooks/useOpenedStories';
import { StoryListItem } from './StoryListItem';
import { StoryRowSkeleton } from './Skeletons';
import { EmptyState, ErrorState } from './States';
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

export function SavedStoryList({
  queryKey,
  ids,
  emptyMessage,
  recover,
}: Props) {
  const { dismiss } = useDismissedStories();
  const { articleOpenedIds, commentsOpenedIds, markOpened } =
    useOpenedStories();

  const items = useQuery({
    queryKey: [
      'savedStoryItems',
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
    <ol className="story-list">
      {stories.map((story, idx) => (
        <li key={story.id} className="story-list__item">
          <StoryListItem
            story={story}
            rank={idx + 1}
            articleOpened={articleOpenedIds.has(story.id)}
            commentsOpened={commentsOpenedIds.has(story.id)}
            onDismiss={dismiss}
            onMarkOpened={markOpened}
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
  );
}
