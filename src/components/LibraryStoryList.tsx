import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  useIsRestoring,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { getItems, type HNItem } from '../lib/hn';
import type { ItemRoot } from '../hooks/useItemTree';
import { isHotStory } from '../lib/format';
import { useHiddenStories } from '../hooks/useHiddenStories';
import { useHotThresholds } from '../hooks/useHotThresholds';
import { useOpenedStories } from '../hooks/useOpenedStories';
import { usePinnedStories } from '../hooks/usePinnedStories';
import { useStickyBottomBar } from '../hooks/useFeedSettings';
import { BackToTopButton } from './BackToTopButton';
import { ListToolbar } from './ListToolbar';
import { PullToRefresh } from './PullToRefresh';
import { StoryListItem } from './StoryListItem';
import { StoryRowSkeleton } from './Skeletons';
import { EmptyState, ErrorState } from './States';
import { useListKeyboardNav } from '../hooks/useListKeyboardNav';
import { useShareStory } from '../hooks/useShareStory';
import { pullNow as cloudSyncPullNow } from '../lib/cloudSync';
import { checkForServiceWorkerUpdate } from '../lib/swUpdate';
import { markCommentsOpenedId } from '../lib/openedStories';
import { prefetchPinnedStory } from '../lib/pinnedStoryPrefetch';
import './StoryList.css';

interface Props {
  queryKey: string;
  ids: number[];
  emptyMessage: string;
  /**
   * Swaps the row's default Pin/Unpin button for a view-contextual
   * "undo" action (Unmark done, Unfavorite, Unhide, …) on library
   * views. When omitted, the default Pin/Unpin button renders — used
   * by /pinned, where Pin/Unpin is already the right action.
   */
  rightAction?: {
    label: string;
    icon: ReactNode;
    onToggle: (id: number) => void;
    testId?: string;
  };
}

export function LibraryStoryList({
  queryKey,
  ids,
  emptyMessage,
  rightAction,
}: Props) {
  useListKeyboardNav();
  const { hide, hiddenIds } = useHiddenStories();
  const { articleOpenedIds, commentsOpenedIds, seenCommentCounts, unopen } =
    useOpenedStories();
  const { pinnedIds, pin, unpin } = usePinnedStories();
  const { stickyBottomBar } = useStickyBottomBar();
  const queryClient = useQueryClient();
  const isRestoring = useIsRestoring();
  const [cacheVersion, setCacheVersion] = useState(0);
  const shareStory = useShareStory();
  // Hoist `useHotThresholds()` here so the user's Hot customize panel
  // overrides reach the row pill without per-row hook subscriptions
  // (Copilot review on PR #240). `now` is captured once per render
  // so all rows evaluate against the same wall-clock instant — saves
  // per-row `new Date()` allocations.
  const { prefs: hotThresholds } = useHotThresholds();
  const now = new Date();
  const flagFromHot = (story: HNItem) =>
    isHotStory(story, now, hotThresholds) ? ('hot' as const) : null;

  const items = useQuery({
    // Key on the full id list: rows are matched to `items.data`
    // positionally (`items.data?.[idx]` ↔ `ids[idx]`), so any key
    // signature weaker than the whole list (e.g. length+first+last)
    // can collide across a mid-list change and render another story's
    // title against the wrong id.
    queryKey: ['libraryStoryItems', queryKey, ids],
    queryFn: ({ signal }) => getItems(ids, signal),
    enabled: ids.length > 0,
  });
  useEffect(() => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    return queryClient.getQueryCache().subscribe((event) => {
      const key = event.query.queryKey;
      if (key[0] !== 'itemRoot') return;
      const id = key[1];
      if (typeof id !== 'number' || !idSet.has(id)) return;
      setCacheVersion((version) => version + 1);
    });
  }, [ids, queryClient]);

  // `cacheVersion` is intentionally read here: query-cache subscriptions
  // bump it when a sibling tab (or a late prefetch) writes itemRoot data
  // after the library list rendered. That forces this synchronous cache
  // fallback to re-run without installing a disabled observer for every id.
  void cacheVersion;
  const stories = isRestoring
    ? (items.data ?? []).filter((it): it is HNItem => it != null)
    : ids
        .map((id, idx) => {
          const batchItem = items.data?.[idx] ?? null;
          if (batchItem) return batchItem;
          return queryClient.getQueryData<ItemRoot | null>(['itemRoot', id])
            ?.item ?? null;
        })
        .filter((it): it is HNItem => it != null);

  // Library rows arrive through ['libraryStoryItems', ...], while the thread
  // page reads ['itemRoot', id]. Seed pinned rows into the thread key before
  // the full warm finishes so tapping a pinned article never waits on the
  // network just to paint the header. Cost/reliability: this reuses the
  // existing pin-time warm (one Firebase item request, one /api/items comment
  // batch, and summary endpoints on cache misses; no new infrastructure) and
  // is best-effort, so failures only mean the thread falls back to its normal
  // fetch path.
  const warmedPinnedIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    for (const story of stories) {
      if (!pinnedIds.has(story.id)) continue;
      if (warmedPinnedIdsRef.current.has(story.id)) continue;
      warmedPinnedIdsRef.current.add(story.id);
      prefetchPinnedStory(queryClient, story);
    }
  }, [stories, pinnedIds, queryClient]);

  const handlePin = useCallback(
    (id: number) => {
      pin(id);
      const story = stories.find((s) => s.id === id);
      if (story) {
        warmedPinnedIdsRef.current.add(id);
        prefetchPinnedStory(queryClient, story);
      }
    },
    [pin, stories, queryClient],
  );

  const handleOpenThread = useCallback(
    (id: number) => {
      const story = stories.find((s) => s.id === id);
      markCommentsOpenedId(id, Date.now(), story?.descendants ?? 0);
    },
    [stories],
  );

  // The bar sits above every render state (empty, loading, error,
  // populated) so library views match the feed views — Undo always
  // stays reachable even when this list is empty (e.g. a hide from a
  // previous feed visit). Sweep stays disabled here since library
  // views don't register a sweep handler.
  const toolbar = <ListToolbar />;

  if (ids.length === 0) {
    return (
      <>
        {toolbar}
        <EmptyState message={emptyMessage} />
      </>
    );
  }

  if ((items.isLoading || isRestoring) && stories.length === 0) {
    return (
      <>
        {toolbar}
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
      </>
    );
  }

  if (items.isError && stories.length === 0) {
    return (
      <>
        {toolbar}
        <ErrorState
          message="Could not load stories."
          onRetry={() => items.refetch()}
        />
      </>
    );
  }

  if (stories.length === 0) {
    return (
      <>
        {toolbar}
        <EmptyState message={emptyMessage} />
      </>
    );
  }

  return (
    <>
    {toolbar}
    <PullToRefresh
      onRefresh={() =>
        // Library pages (/pinned, /favorites, /hidden, /opened) read
        // from localStorage — refetching items alone can't surface a
        // story pinned on another device because the id isn't in the
        // local list yet. Pull cloudSync first to bring in any new
        // ids, then refetch the HN items. In parallel, check for a
        // newer app bundle — see `StoryList.handleRefresh` for the
        // full rationale on tying SW update checks to PTR.
        Promise.all([
          cloudSyncPullNow().then(() => items.refetch()),
          checkForServiceWorkerUpdate(),
        ])
      }
    >
      <ol className="story-list">
        {stories.map((story, idx) => {
          // Pin and Hide are mutually exclusive — see SPEC.md under
          // *Pinned vs. Favorite vs. Done*. StoryList already blocks
          // swipe-right and menu "Hide" on pinned rows; here on the
          // library side we withhold onPin/onUnpin when the story is
          // currently hidden, so swipe-left and menu "Pin" can't
          // create the inverse collision (visible mainly on
          // /hidden, where every row is hidden, but also catches
          // the /favorites case of a hidden+favorited story).
          const isHidden = hiddenIds.has(story.id);
          return (
            <li key={story.id} className="story-list__item">
              <StoryListItem
                story={story}
                rank={idx + 1}
                isLibraryRow
                flag={flagFromHot(story)}
                articleOpened={articleOpenedIds.has(story.id)}
                commentsOpened={commentsOpenedIds.has(story.id)}
                seenCommentCount={seenCommentCounts.get(story.id)}
                pinned={pinnedIds.has(story.id)}
                hidden={isHidden}
                onHide={hide}
                onPin={isHidden ? undefined : handlePin}
                onUnpin={isHidden ? undefined : unpin}
                onShare={shareStory}
                // Long-press "Mark unread" mirrors the feed-row menu:
                // it clears both opened halves so the row returns to an
                // unread visual state and drops from /opened immediately.
                onMarkUnread={unopen}
                onOpenThread={handleOpenThread}
                rightAction={
                  rightAction
                    ? {
                        label: rightAction.label,
                        icon: rightAction.icon,
                        testId: rightAction.testId,
                        onToggle: () => rightAction.onToggle(story.id),
                      }
                    : undefined
                }
              />
            </li>
          );
        })}
      </ol>
      <div
        className={
          'story-list__footer' +
          (stickyBottomBar ? ' story-list__footer--sticky' : '')
        }
      >
        <BackToTopButton />
      </div>
    </PullToRefresh>
    </>
  );
}
