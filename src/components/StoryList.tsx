import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Feed } from '../lib/feeds';
import { PAGE_SIZE, useFeedItems } from '../hooks/useStoryList';
import { useDismissedStories } from '../hooks/useDismissedStories';
import { useOffFeedPinnedStories } from '../hooks/useOffFeedPinnedStories';
import { useOpenedStories } from '../hooks/useOpenedStories';
import { usePinnedStories } from '../hooks/usePinnedStories';
import { PullToRefresh } from './PullToRefresh';
import { StoryListItem } from './StoryListItem';
import { StoryRowSkeleton } from './Skeletons';
import { ErrorState, EmptyState } from './States';
import { useShareStory } from '../hooks/useShareStory';
import { markCommentsOpenedId } from '../lib/openedStories';
import { prefetchPinnedStory } from '../lib/pinnedStoryPrefetch';
import {
  FEED_PREFETCH_SCORE_THRESHOLD,
  prefetchFeedStory,
} from '../lib/feedStoryPrefetch';
import { warmFeedSummaries } from '../lib/feedSummaryWarm';
import { pullNow as cloudSyncPullNow } from '../lib/cloudSync';
import { useFeedBar } from '../hooks/useFeedBar';
import './StoryList.css';

interface Props {
  feed: Feed;
}

function measureHeaderInset(): number {
  if (typeof document === 'undefined') return 0;
  const header = document.querySelector('.app-header');
  if (!header) return 0;
  const rect = header.getBoundingClientRect();
  return Math.max(0, Math.ceil(rect.bottom));
}

export function StoryList({ feed }: Props) {
  const feedItems = useFeedItems(feed);
  const queryClient = useQueryClient();
  const { dismissedIds, dismiss } = useDismissedStories();
  const { articleOpenedIds, commentsOpenedIds } = useOpenedStories();
  const { pinnedIds, pin, unpin } = usePinnedStories();
  const shareStory = useShareStory();
  const { setSweep, recordDismiss } = useFeedBar();

  const { items, allIds, hasMore, isFetchingMore, loadMore, refetch, isError } =
    feedItems;
  const { stories: offFeedPinnedStories } = useOffFeedPinnedStories(allIds);

  const handlePin = useCallback(
    (id: number) => {
      pin(id);
      const story = items.find((it): it is NonNullable<typeof it> => it?.id === id);
      if (story) prefetchPinnedStory(queryClient, story);
    },
    [pin, items, queryClient],
  );

  const handleDismissOne = useCallback(
    (id: number) => {
      dismiss(id);
      recordDismiss([id]);
    },
    [dismiss, recordDismiss],
  );

  // Visibility floor: hide stories that haven't earned at least one
  // organic upvote (HN submissions start at score 1 from the
  // submitter's implicit self-vote; `> 1` means at least one other
  // person has voted). This is a live, per-render check, not a
  // persistent filter — if a story's score climbs above 1 on a
  // subsequent feed refetch, it rejoins the list automatically.
  const visibleStories = useMemo(
    () =>
      items.filter(
        (it): it is NonNullable<typeof it> =>
          it != null &&
          !it.deleted &&
          !it.dead &&
          (it.score ?? 0) > 1 &&
          !dismissedIds.has(it.id),
      ),
    [items, dismissedIds],
  );

  // Opportunistically warm the thread/comment cache for currently-trending
  // stories so tapping one feels instant. We only fire once per story id
  // per session (tracked by `warmedIdsRef`) and skip anything already in
  // the query cache — see `prefetchFeedStory` for the cost note.
  const warmedIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    for (const story of visibleStories) {
      if ((story.score ?? 0) <= FEED_PREFETCH_SCORE_THRESHOLD) continue;
      if (warmedIdsRef.current.has(story.id)) continue;
      warmedIdsRef.current.add(story.id);
      prefetchFeedStory(queryClient, story);
    }
  }, [visibleStories, queryClient]);

  // Sweep only applies to rows the user can actually see *right now*, not
  // the whole rendered list. A row counts as "in view" iff its bounding
  // box sits entirely inside the viewport minus the sticky app header.
  // We track that via a shared IntersectionObserver whose rootMargin
  // shrinks the top of the viewport by the current header height.
  const [inViewIds, setInViewIds] = useState<Set<number>>(() => new Set());
  const rowEls = useRef<Map<number, HTMLLIElement>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const [headerInset, setHeaderInset] = useState<number>(() =>
    measureHeaderInset(),
  );

  useEffect(() => {
    const update = () => setHeaderInset(measureHeaderInset());
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        setInViewIds((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const el = entry.target as HTMLElement;
            const id = Number(el.dataset.storyId);
            if (!id) continue;
            // "Fully visible" — intersectionRatio can round to just under 1
            // for sub-pixel layouts, so treat very close to 1 as fully in.
            if (entry.intersectionRatio >= 0.999) next.add(id);
            else next.delete(id);
          }
          return next;
        });
      },
      { threshold: [0, 1], rootMargin: `-${headerInset}px 0px 0px 0px` },
    );
    observerRef.current = io;
    for (const el of rowEls.current.values()) io.observe(el);
    return () => {
      io.disconnect();
      observerRef.current = null;
    };
  }, [headerInset]);

  const rowRefCache = useRef<
    Map<number, (el: HTMLLIElement | null) => void>
  >(new Map());
  const getRowRef = useCallback((id: number) => {
    const cached = rowRefCache.current.get(id);
    if (cached) return cached;
    const setRef = (el: HTMLLIElement | null) => {
      const io = observerRef.current;
      const prev = rowEls.current.get(id);
      if (prev && prev !== el) {
        io?.unobserve(prev);
        rowEls.current.delete(id);
        setInViewIds((s) => {
          if (!s.has(id)) return s;
          const next = new Set(s);
          next.delete(id);
          return next;
        });
      }
      if (el) {
        rowEls.current.set(id, el);
        io?.observe(el);
      }
    };
    rowRefCache.current.set(id, setRef);
    return setRef;
  }, []);

  // Warm the server-side Gemini summary caches (/api/summary and
  // /api/comments-summary, both Upstash-backed) for rows the user has
  // actually scrolled into view. This replaces a periodic cron — instead
  // of generating summaries for every story on a schedule, we generate
  // them on demand for the stories people are actually looking at. The
  // endpoints already short-circuit on a KV hit, so only the first view
  // of each story in a TTL window pays a Gemini call. Session-scoped
  // dedup via `warmedServerIdsRef` stops us from re-hitting the server
  // as a row re-enters the viewport during scroll.
  const warmedServerIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (inViewIds.size === 0) return;
    for (const story of visibleStories) {
      if (!inViewIds.has(story.id)) continue;
      if (warmedServerIdsRef.current.has(story.id)) continue;
      warmedServerIdsRef.current.add(story.id);
      warmFeedSummaries(story);
    }
  }, [inViewIds, visibleStories]);

  const sweepableIds = useMemo(
    () =>
      visibleStories
        .map((s) => s.id)
        .filter(
          (id) =>
            inViewIds.has(id) &&
            !pinnedIds.has(id) &&
            !dismissedIds.has(id),
        ),
    [visibleStories, inViewIds, pinnedIds, dismissedIds],
  );

  const handleSweep = useCallback(() => {
    if (sweepableIds.length === 0) return;
    for (const id of sweepableIds) dismiss(id);
    recordDismiss(sweepableIds);
  }, [sweepableIds, dismiss, recordDismiss]);

  useEffect(() => {
    setSweep(handleSweep, sweepableIds.length);
    return () => setSweep(null, 0);
  }, [setSweep, handleSweep, sweepableIds.length]);

  const handleOpenThread = useCallback((id: number) => {
    markCommentsOpenedId(id);
  }, []);

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

  if (
    visibleStories.length === 0 &&
    offFeedPinnedStories.length === 0 &&
    !hasMore
  ) {
    return <EmptyState message="No stories yet." />;
  }

  return (
    <PullToRefresh
      onRefresh={() =>
        // Pull cross-device sync state alongside the HN feed — PTR is
        // the user's "show me the latest" gesture and they'd expect
        // pins from other devices to land here too. cloudSyncPullNow
        // is a no-op when the user isn't signed in.
        Promise.all([refetch(), cloudSyncPullNow()])
      }
    >
      <ol className="story-list">
        {offFeedPinnedStories.map((story) => (
          <li
            key={`pinned-${story.id}`}
            ref={getRowRef(story.id)}
            className="story-list__item"
            data-story-id={story.id}
            data-off-feed-pinned="true"
          >
            <StoryListItem
              story={story}
              articleOpened={articleOpenedIds.has(story.id)}
              commentsOpened={commentsOpenedIds.has(story.id)}
              pinned
              dismissed={dismissedIds.has(story.id)}
              onDismiss={handleDismissOne}
              onPin={handlePin}
              onUnpin={unpin}
              onShare={shareStory}
              onOpenThread={handleOpenThread}
            />
          </li>
        ))}
        {visibleStories.map((story, idx) => (
          <li
            key={story.id}
            ref={getRowRef(story.id)}
            className="story-list__item"
            data-story-id={story.id}
          >
            <StoryListItem
              story={story}
              rank={idx + 1}
              articleOpened={articleOpenedIds.has(story.id)}
              commentsOpened={commentsOpenedIds.has(story.id)}
              pinned={pinnedIds.has(story.id)}
              dismissed={dismissedIds.has(story.id)}
              onDismiss={handleDismissOne}
              onPin={handlePin}
              onUnpin={unpin}
              onShare={shareStory}
              onOpenThread={handleOpenThread}
            />
          </li>
        ))}
      </ol>
      {hasMore ? (
        <div className="story-list__more">
          <button
            type="button"
            className="load-more-btn"
            onClick={loadMore}
            disabled={isFetchingMore}
          >
            {isFetchingMore ? 'Loading…' : 'More'}
          </button>
        </div>
      ) : null}
    </PullToRefresh>
  );
}

export { PAGE_SIZE };
