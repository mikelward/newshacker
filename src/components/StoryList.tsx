import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Feed } from '../lib/feeds';
import { isHotStory } from '../lib/format';
import { PAGE_SIZE, useFeedItems } from '../hooks/useStoryList';
import { useDoneStories } from '../hooks/useDoneStories';
import { useFeedFilters } from '../hooks/useFeedFilters';
import { useHiddenStories } from '../hooks/useHiddenStories';
import { useOffFeedPinnedStories } from '../hooks/useOffFeedPinnedStories';
import { useOpenedStories } from '../hooks/useOpenedStories';
import { usePinnedStories } from '../hooks/usePinnedStories';
import { BackToTopButton } from './BackToTopButton';
import { PullToRefresh } from './PullToRefresh';
import { StoryListItem } from './StoryListItem';
import { StoryRowSkeleton } from './Skeletons';
import { ErrorState, EmptyState } from './States';
import { TooltipButton } from './TooltipButton';
import { useShareStory } from '../hooks/useShareStory';
import { markCommentsOpenedId } from '../lib/openedStories';
import { prefetchPinnedStory } from '../lib/pinnedStoryPrefetch';
import {
  FEED_PREFETCH_SCORE_THRESHOLD,
  prefetchFeedStory,
} from '../lib/feedStoryPrefetch';
import { warmFeedSummaries } from '../lib/feedSummaryWarm';
import { pullNow as cloudSyncPullNow } from '../lib/cloudSync';
import { checkForServiceWorkerUpdate } from '../lib/swUpdate';
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

// Material Symbols Outlined — Apache 2.0, Google. Same broom glyph as the
// header's Hide unpinned button, repeated inline so the list footer doesn't
// have to reach into AppHeader for an icon.
function SweepIcon() {
  return (
    <svg
      className="list-footer__icon"
      viewBox="0 -960 960 960"
      fill="currentColor"
      width="24"
      height="24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M400-240v-80h240v80H400Zm-158 0L15-467l57-57 170 170 366-366 57 57-423 423Zm318-160v-80h240v80H560Zm160-160v-80h240v80H720Z" />
    </svg>
  );
}

export function StoryList({ feed }: Props) {
  const feedItems = useFeedItems(feed);
  const queryClient = useQueryClient();
  const { hiddenIds, hide } = useHiddenStories();
  const { doneIds } = useDoneStories();
  const { articleOpenedIds, commentsOpenedIds, seenCommentCounts } =
    useOpenedStories();
  const { pinnedIds, pin, unpin } = usePinnedStories();
  const shareStory = useShareStory();
  const { setSweep, setRefresh, recordHide } = useFeedBar();
  const { unreadOnly, hotOnly } = useFeedFilters();

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

  const handleHideOne = useCallback(
    (id: number) => {
      hide(id);
      recordHide([id]);
    },
    [hide, recordHide],
  );

  // Visibility floor: filter out stories that haven't earned at least one
  // organic upvote (HN submissions start at score 1 from the
  // submitter's implicit self-vote; `> 1` means at least one other
  // person has voted). This is a live, per-render check, not a
  // persistent filter — if a story's score climbs above 1 on a
  // subsequent feed refetch, it rejoins the list automatically.
  // Done stories are also hidden: Done is the completion log, and
  // the feed should represent "what's still worth looking at".
  // Unread-only and hot-only toggles layer on top: an opened story is
  // one the reader has tapped into (article or thread), a hot story is
  // whatever `isHotStory` currently flags.
  // isHotStory is time-dependent (the "recent fast-riser" rule uses a
  // 2h window from `time`), so the memo below has to invalidate as the
  // clock advances — otherwise a 40-point row could age past 2h and
  // still appear while Hot-only is on. `hotNowBucket` ticks once per
  // minute while Hot-only is active and participates in the memo deps;
  // it's the coarsest cadence that still lands on the right side of
  // the 2h boundary within ~1 minute. When Hot-only is off we don't
  // tick — the filter isn't reading the clock.
  const [hotNowBucket, setHotNowBucket] = useState(() =>
    Math.floor(Date.now() / 60_000),
  );
  useEffect(() => {
    if (!hotOnly) return;
    setHotNowBucket(Math.floor(Date.now() / 60_000));
    const id = window.setInterval(() => {
      setHotNowBucket(Math.floor(Date.now() / 60_000));
    }, 60_000);
    return () => window.clearInterval(id);
  }, [hotOnly]);

  const visibleStories = useMemo(() => {
    // Capture `now` once per filter pass so every isHotStory() call
    // classifies against the same instant (a row whose age crosses the
    // 2h "recent" boundary mid-loop shouldn't flip state from row to
    // row) and we skip allocating a new Date per item.
    const now = new Date();
    return items.filter(
      (it): it is NonNullable<typeof it> =>
        it != null &&
        !it.deleted &&
        !it.dead &&
        (it.score ?? 0) > 1 &&
        !hiddenIds.has(it.id) &&
        !doneIds.has(it.id) &&
        (!unreadOnly ||
          (!articleOpenedIds.has(it.id) && !commentsOpenedIds.has(it.id))) &&
        (!hotOnly || isHotStory(it, now)),
    );
    // `hotNowBucket` isn't read in the body but is intentionally a
    // dep: its change invalidates the memo once per minute while
    // Hot-only is on, so a story that ages past the 2h fast-rise
    // window drops out of the filter. isHotStory reads `Date.now()`
    // at call time, so we don't need to surface the bucket value to it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    items,
    hiddenIds,
    doneIds,
    unreadOnly,
    hotOnly,
    articleOpenedIds,
    commentsOpenedIds,
    hotNowBucket,
  ]);

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
            !hiddenIds.has(id),
        ),
    [visibleStories, inViewIds, pinnedIds, hiddenIds],
  );

  const handleSweep = useCallback(() => {
    if (sweepableIds.length === 0) return;
    for (const id of sweepableIds) hide(id);
    recordHide(sweepableIds);
  }, [sweepableIds, hide, recordHide]);

  useEffect(() => {
    setSweep(handleSweep, sweepableIds.length);
    return () => setSweep(null, 0);
  }, [setSweep, handleSweep, sweepableIds.length]);

  // Refresh == "pull the feed + cross-device sync state + latest
  // app bundle". Same callback PullToRefresh uses — see onRefresh
  // below. `cloudSyncPullNow` and `checkForServiceWorkerUpdate` are
  // outer-scope module imports, not dependencies of this hook —
  // `react-hooks/exhaustive-deps` flags adding them (their values
  // can't mutate in a way that would require a re-callback).
  //
  // `checkForServiceWorkerUpdate` pings the SW to re-fetch `/sw.js`
  // and reloads the tab if a newer build has shipped. Without it
  // the browser only re-checks on full navigation, and our custom
  // PTR overrides the browser's native swipe-to-reload, so a
  // session parked on one route stays on the old bundle — the
  // failure mode that made Vercel preview testing after a
  // force-push unreliable.
  const handleRefresh = useCallback(
    () =>
      Promise.all([refetch(), cloudSyncPullNow(), checkForServiceWorkerUpdate()]),
    [refetch],
  );
  useEffect(() => {
    setRefresh(handleRefresh);
    return () => setRefresh(null);
  }, [setRefresh, handleRefresh]);

  // Snapshot the current comment count so later visits can show a
  // "N new" badge for anything posted since. Look the story up in both
  // the feed page and the off-feed pinned list — a tap on a pinned
  // story that has scrolled off the feed otherwise wouldn't record
  // anything.
  const handleOpenThread = useCallback(
    (id: number) => {
      const story =
        items.find((it): it is NonNullable<typeof it> => it?.id === id) ??
        offFeedPinnedStories.find((s) => s.id === id);
      markCommentsOpenedId(id, Date.now(), story?.descendants ?? 0);
    },
    [items, offFeedPinnedStories],
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

  if (
    visibleStories.length === 0 &&
    offFeedPinnedStories.length === 0 &&
    !hasMore
  ) {
    return <EmptyState message="No stories yet." />;
  }

  return (
    <PullToRefresh
      // Pull cross-device sync state alongside the HN feed — PTR is
      // the user's "show me the latest" gesture and they'd expect
      // pins from other devices to land here too. cloudSyncPullNow
      // (inside handleRefresh) is a no-op when the user isn't
      // signed in. Same handler backs the header Refresh button.
      onRefresh={handleRefresh}
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
              seenCommentCount={seenCommentCounts.get(story.id)}
              pinned
              hidden={hiddenIds.has(story.id)}
              onHide={handleHideOne}
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
              seenCommentCount={seenCommentCounts.get(story.id)}
              pinned={pinnedIds.has(story.id)}
              hidden={hiddenIds.has(story.id)}
              onHide={handleHideOne}
              onPin={handlePin}
              onUnpin={unpin}
              onShare={shareStory}
              onOpenThread={handleOpenThread}
            />
          </li>
        ))}
      </ol>
      <div className="story-list__footer story-list__footer--feed">
        <BackToTopButton />
        {hasMore ? (
          <button
            type="button"
            className="load-more-btn"
            onClick={loadMore}
            disabled={isFetchingMore}
          >
            {isFetchingMore ? 'Loading…' : 'More'}
          </button>
        ) : null}
        <TooltipButton
          type="button"
          className="list-footer__icon-btn"
          data-testid="sweep-btn-bottom"
          onClick={sweepableIds.length > 0 ? handleSweep : undefined}
          disabled={sweepableIds.length === 0}
          tooltip={sweepableIds.length > 0 ? 'Hide unpinned' : 'Nothing to hide'}
          aria-label={
            sweepableIds.length > 0 ? 'Hide unpinned' : 'Nothing to hide'
          }
        >
          <SweepIcon />
        </TooltipButton>
      </div>
    </PullToRefresh>
  );
}

export { PAGE_SIZE };
