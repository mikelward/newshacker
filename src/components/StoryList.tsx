import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnimationEvent as ReactAnimationEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Feed } from '../lib/feeds';
import { PAGE_SIZE, useFeedItems } from '../hooks/useStoryList';
import { useHotFeedItems } from '../hooks/useHotFeedItems';
import { useDoneStories } from '../hooks/useDoneStories';
import { useHiddenStories } from '../hooks/useHiddenStories';
import { useOffFeedPinnedStories } from '../hooks/useOffFeedPinnedStories';
import { useOpenedStories } from '../hooks/useOpenedStories';
import { usePinnedStories } from '../hooks/usePinnedStories';
import { BackToTopButton } from './BackToTopButton';
import { PullToRefresh } from './PullToRefresh';
import { StoryListItem, type RowFlag } from './StoryListItem';
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

// Keep in sync with the `story-list__item--sweeping` animation duration
// in StoryList.css, which in turn matches `EXIT_DURATION_MS` in
// `useSwipeToDismiss` — tapping the broom should feel like every
// unpinned row swiped itself away at the same time. The timer fires
// the actual hide + undo-batch record once the animation has played,
// so the row slides in place instead of popping.
const SWEEP_ANIMATION_MS = 200;

interface Props {
  feed: Feed;
}

// /hot rows that came from the `/new` source (and were not also in
// the `/top` source) render a `new` segment in place of the
// otherwise-suppressed `hot` flag — see SPEC.md *Hot flag*. The
// underlying `RowFlag` enum is declared on `StoryListItem` (where
// it's consumed); we just thread a `flagFor` callback through the
// list so each row can opt into an override.
type FlagFor = (id: number) => RowFlag | undefined;

interface ImplProps {
  feedItems: ReturnType<typeof useFeedItems>;
  flagFor?: FlagFor;
  emptyMessage?: string;
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
  return <StoryListImpl feedItems={feedItems} />;
}

// `/hot` shim: same render path, different data source + a per-row
// `flag` override so rows that came from the `/new` source carry a
// `new` debug segment (the suppressed `hot` segment is what every
// other row would otherwise render — see SPEC.md *Hot flag*). The
// empty state copy matches SPEC.md *Story feeds → /hot*.
export function HotStoryList() {
  const feedItems = useHotFeedItems();
  const newSourceIds = feedItems.newSourceIds;
  const flagFor = useCallback(
    (id: number): RowFlag => (newSourceIds.has(id) ? 'new' : null),
    [newSourceIds],
  );
  return (
    <StoryListImpl
      feedItems={feedItems}
      flagFor={flagFor}
      emptyMessage="Nothing hot right now."
    />
  );
}

// Inner renderer shared by `<StoryList>` (the standard feed shim
// above) and `<HotStoryList>` (the /hot route, which uses a
// different data hook to merge `/top` and `/new`). All sweep / IO
// observer / prefetch / "load more" wiring lives here so the two
// entry points behave identically except for the data source and
// the per-row flag override.
export function StoryListImpl({
  feedItems,
  flagFor,
  emptyMessage = 'No stories yet.',
}: ImplProps) {
  const queryClient = useQueryClient();
  const { hiddenIds, hide } = useHiddenStories();
  const { doneIds } = useDoneStories();
  const { articleOpenedIds, commentsOpenedIds, seenCommentCounts } =
    useOpenedStories();
  const { pinnedIds, pin, unpin } = usePinnedStories();
  const shareStory = useShareStory();
  const { setSweep, setRefresh, recordHide } = useFeedBar();

  const { items, allIds, hasMore, isFetchingMore, loadMore, refetch, isError } =
    feedItems;
  const { stories: rawOffFeedPinnedStories } =
    useOffFeedPinnedStories(allIds);
  // Pin is a shield against Hide, so new state can't produce a pin ∩
  // hidden collision (swipe-right and menu "Hide" are blocked on
  // pinned rows; see StoryListItem). This filter is defense-in-depth
  // for legacy storage that predates that rule and for brief
  // cross-device-sync windows where the two stores could disagree —
  // without it, a surviving collision would render the pinned row on
  // the home feed while `hiddenIds` said it should be gone.
  const offFeedPinnedStories = useMemo(
    () => rawOffFeedPinnedStories.filter((s) => !hiddenIds.has(s.id)),
    [rawOffFeedPinnedStories, hiddenIds],
  );

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
  const visibleStories = useMemo(
    () =>
      items.filter(
        (it): it is NonNullable<typeof it> =>
          it != null &&
          !it.deleted &&
          !it.dead &&
          (it.score ?? 0) > 1 &&
          !hiddenIds.has(it.id) &&
          !doneIds.has(it.id),
      ),
    [items, hiddenIds, doneIds],
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
            !hiddenIds.has(id),
        ),
    [visibleStories, inViewIds, pinnedIds, hiddenIds],
  );

  // Visual "whoosh" when sweep fires: every unpinned, fully-visible row
  // slides+fades out together as a single gesture (matches the verb —
  // sweep is one motion, not a staggered cascade), then the hide
  // commits once the animation finishes. CSS gates the actual motion
  // behind `prefers-reduced-motion: no-preference`; JS mirrors that
  // gate so readers who opted out skip the delay too.
  //
  // The commit is driven by the `animationend` signal that bubbles up
  // from the swept `<li>` (so JS follows whatever duration the CSS
  // defines), with a fallback timer at 2× SWEEP_ANIMATION_MS in case
  // the event never fires — background-tab throttling, the browser
  // optimizing out the animation on an offscreen element, jsdom not
  // synthesizing animation events, etc.
  const [sweepingIds, setSweepingIds] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const sweepPendingIdsRef = useRef<readonly number[] | null>(null);
  const sweepFallbackTimerRef = useRef<number | null>(null);
  // Keep handler refs so the unmount cleanup below can commit without
  // re-subscribing every time hide/recordHide change identity.
  const hideRef = useRef(hide);
  const recordHideRef = useRef(recordHide);
  useEffect(() => {
    hideRef.current = hide;
  }, [hide]);
  useEffect(() => {
    recordHideRef.current = recordHide;
  }, [recordHide]);

  const commitSweep = useCallback(() => {
    const ids = sweepPendingIdsRef.current;
    if (!ids) return;
    sweepPendingIdsRef.current = null;
    if (sweepFallbackTimerRef.current != null) {
      window.clearTimeout(sweepFallbackTimerRef.current);
      sweepFallbackTimerRef.current = null;
    }
    for (const id of ids) hide(id);
    recordHide(ids);
    setSweepingIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, [hide, recordHide]);

  // If the list unmounts (route change, etc.) while a sweep is still
  // animating, commit the hide synchronously so the action isn't
  // silently dropped — the user's intent ("hide everything unpinned")
  // has already been recorded by the tap. Uses refs to avoid
  // re-subscribing the cleanup every render.
  useEffect(() => {
    return () => {
      const ids = sweepPendingIdsRef.current;
      if (ids) {
        for (const id of ids) hideRef.current(id);
        recordHideRef.current(ids);
        sweepPendingIdsRef.current = null;
      }
      if (sweepFallbackTimerRef.current != null) {
        window.clearTimeout(sweepFallbackTimerRef.current);
        sweepFallbackTimerRef.current = null;
      }
    };
  }, []);

  const handleSweep = useCallback(() => {
    if (sweepableIds.length === 0) return;
    // Ignore repeat taps while a sweep is already playing out — the
    // second batch would be identical (hiddenIds hasn't updated yet).
    if (sweepPendingIdsRef.current !== null) return;
    const ids = sweepableIds.slice();
    const reducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
      for (const id of ids) hide(id);
      recordHide(ids);
      return;
    }
    sweepPendingIdsRef.current = ids;
    setSweepingIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    sweepFallbackTimerRef.current = window.setTimeout(
      commitSweep,
      SWEEP_ANIMATION_MS * 2,
    );
  }, [sweepableIds, hide, recordHide, commitSweep]);

  // First `animationend` from a swept row drives the commit — `<li>`
  // elements all animate with the same duration, so one signal is
  // enough. Filter by animationName so an unrelated descendant
  // animation (a skeleton shimmer, etc.) can't accidentally trigger
  // the commit.
  const handleListAnimationEnd = useCallback(
    (e: ReactAnimationEvent<HTMLOListElement>) => {
      if (e.animationName !== 'story-list__sweep-out') return;
      commitSweep();
    },
    [commitSweep],
  );

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
    return <EmptyState message={emptyMessage} />;
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
      <ol className="story-list" onAnimationEnd={handleListAnimationEnd}>
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
              flag={flagFor?.(story.id)}
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
            className={
              'story-list__item' +
              (sweepingIds.has(story.id) ? ' story-list__item--sweeping' : '')
            }
            data-story-id={story.id}
          >
            <StoryListItem
              story={story}
              rank={idx + 1}
              flag={flagFor?.(story.id)}
              articleOpened={articleOpenedIds.has(story.id)}
              commentsOpened={commentsOpenedIds.has(story.id)}
              seenCommentCount={seenCommentCounts.get(story.id)}
              pinned={pinnedIds.has(story.id)}
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
