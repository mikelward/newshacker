import { useCallback, useEffect, useRef, useState } from 'react';
import type { Feed } from '../lib/feeds';
import { PAGE_SIZE, useStoryPage } from '../hooks/useStoryList';
import { useInfiniteScroll } from '../hooks/useInfiniteScroll';
import { useDismissedStories } from '../hooks/useDismissedStories';
import { useOpenedStories } from '../hooks/useOpenedStories';
import { useSavedStories } from '../hooks/useSavedStories';
import { useAutoDismissOnScroll } from '../hooks/useAutoDismissOnScroll';
import { StoryListItem } from './StoryListItem';
import { StoryRowSkeleton } from './Skeletons';
import { ErrorState, EmptyState } from './States';
import { useToast } from '../hooks/useToast';
import { useShareStory } from '../hooks/useShareStory';
import './StoryList.css';

// Dismisses (swipe, scroll-past, menu "Ignore") within this window of
// each other share a single undo toast. The toast's deadline extends
// with each new dismiss, so the user gets the full window of grace
// time after the most recent action — but only relative to what was
// already dismissed, never relative to when Undo was tapped.
export const DISMISS_BATCH_WINDOW_MS = 2000;
const DISMISS_TOAST_GROUP = 'dismiss-batch';

interface Props {
  feed: Feed;
}

export function StoryList({ feed }: Props) {
  const [page, setPage] = useState(0);
  const { ids, items, slice, totalIds } = useStoryPage(feed, page);
  const { dismissedIds, dismiss, undismiss } = useDismissedStories();
  const { articleOpenedIds, commentsOpenedIds, markOpened } =
    useOpenedStories();
  const { savedIds, save, unsave } = useSavedStories();
  const { showToast } = useToast();
  const shareStory = useShareStory();

  const handleMenuUnsave = useCallback(
    (id: number) => {
      unsave(id);
      showToast({
        message: 'Unsaved',
        actionLabel: 'Undo',
        onAction: () => save(id),
      });
    },
    [save, unsave, showToast],
  );

  const handleSwipeSave = useCallback(
    (id: number) => {
      save(id);
      showToast({
        message: 'Saved',
        actionLabel: 'Undo',
        onAction: () => unsave(id),
      });
    },
    [save, unsave, showToast],
  );

  const dismissBatchRef = useRef<{ ids: number[]; lastAt: number }>({
    ids: [],
    lastAt: 0,
  });
  const [revealIdAfterUndo, setRevealIdAfterUndo] = useState<number | null>(
    null,
  );

  const handleBatchedDismiss = useCallback(
    (id: number) => {
      dismiss(id);
      const now = Date.now();
      const batch = dismissBatchRef.current;
      const ids =
        now - batch.lastAt < DISMISS_BATCH_WINDOW_MS
          ? [...batch.ids, id]
          : [id];
      dismissBatchRef.current = { ids, lastAt: now };

      showToast({
        message: ids.length === 1 ? 'Dismissed' : `Dismissed ${ids.length}`,
        actionLabel: 'Undo',
        onAction: () => {
          const firstId = ids[0];
          for (const storyId of ids) undismiss(storyId);
          dismissBatchRef.current = { ids: [], lastAt: 0 };
          setRevealIdAfterUndo(firstId);
        },
        durationMs: DISMISS_BATCH_WINDOW_MS,
        groupKey: DISMISS_TOAST_GROUP,
      });
    },
    [dismiss, undismiss, showToast],
  );

  const canLoadMore = slice.length < totalIds;
  const isFetching = items.isFetching || ids.isFetching;

  const handleLoadMore = useCallback(() => {
    if (!isFetching && canLoadMore) setPage((p) => p + 1);
  }, [isFetching, canLoadMore]);

  const sentinelRef = useInfiniteScroll<HTMLDivElement>({
    enabled: canLoadMore && !isFetching,
    onLoadMore: handleLoadMore,
  });

  const [headerOffset, setHeaderOffset] = useState(0);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const measure = () => {
      const header = document.querySelector<HTMLElement>('.app-header');
      setHeaderOffset(header?.getBoundingClientRect().height ?? 0);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const { observe } = useAutoDismissOnScroll({
    onScrolledPast: handleBatchedDismiss,
    topOffset: headerOffset,
  });

  // After Undo, if the first restored row is above the sticky header,
  // scroll the page so that row sits just below the header. Rows that
  // are already in view stay put.
  useEffect(() => {
    if (revealIdAfterUndo == null) return;
    setRevealIdAfterUndo(null);
    const el = document.querySelector<HTMLElement>(
      `.story-list__item[data-story-id="${revealIdAfterUndo}"]`,
    );
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.top >= headerOffset) return;
    const top = window.scrollY + rect.top - headerOffset - 8;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [revealIdAfterUndo, headerOffset]);

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
    (it): it is NonNullable<typeof it> =>
      it != null && !it.deleted && !it.dead && !dismissedIds.has(it.id),
  );

  if (stories.length === 0 && !canLoadMore) {
    return <EmptyState message="No stories yet." />;
  }

  return (
    <>
      <ol className="story-list">
        {stories.map((story, idx) => (
          <li
            key={story.id}
            className="story-list__item"
            data-story-id={story.id}
            ref={(el) => observe(story.id, el)}
          >
            <StoryListItem
              story={story}
              rank={idx + 1}
              articleOpened={articleOpenedIds.has(story.id)}
              commentsOpened={commentsOpenedIds.has(story.id)}
              saved={savedIds.has(story.id)}
              onDismiss={handleBatchedDismiss}
              onSave={handleSwipeSave}
              onUnsave={handleMenuUnsave}
              onShare={shareStory}
              onMarkOpened={markOpened}
            />
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
