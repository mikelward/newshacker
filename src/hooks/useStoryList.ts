import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { getItems, getStoryIds, type HNItem } from '../lib/hn';
import { isRetryableFetchError } from '../lib/networkStatus';
import type { Feed } from '../lib/feeds';

// Fields we render in the feed. Stripping everything else (notably the
// `kids` comment-tree array, which can be large) keeps the persisted
// React Query cache small.
function thinForFeed(item: HNItem | null): HNItem | null {
  if (!item) return null;
  const { id, type, by, time, title, url, text, score, descendants, dead, deleted } = item;
  return { id, type, by, time, title, url, text, score, descendants, dead, deleted };
}

// HN's own web front page shows exactly 30 stories and hides the rest
// behind a "More" link. We mirror that: first paint is 30, and additional
// pages are only fetched when the reader explicitly asks for them.
export const PAGE_SIZE = 30;

// Feed reads are the app's core content, so a single transient failure on
// open (a flaky mobile radio, a momentarily blocked or slow Firebase
// request) shouldn't immediately strand the reader on the persisted
// snapshot. Retry a few times with exponential backoff before we give up
// and surface the refresh-failed state. This overrides the app-wide
// retry default (see main.tsx) for the feed list/item queries only.
//
// Retries are for true statusless network blips only: a response that
// carried an HTTP status is the backend speaking, and re-asking won't
// change a 4xx while re-asking a 5xx hammers a backend that just said it's
// struggling — the connectivity tracker's 'down' state + rate-bounded
// recovery probe own that path instead.
export const FEED_QUERY_MAX_RETRIES = 3;
export function feedQueryRetry(failureCount: number, error: unknown): boolean {
  return failureCount < FEED_QUERY_MAX_RETRIES && isRetryableFetchError(error);
}
export const feedQueryRetryDelay = (attempt: number) => {
  const cap = Math.min(1000 * 2 ** attempt, 8000);
  // Half fixed + half jitter, so clients that all failed together (a Firebase
  // hiccup hits everyone at once) don't retry in lockstep against a backend
  // that's trying to recover.
  return cap / 2 + Math.random() * (cap / 2);
};

// Derives the two refresh signals the feed UI renders from the underlying
// React Query state. Pulled out as a pure function so it can be unit
// tested directly, without driving React Query's retry/backoff timers.
//
// `refreshFailed` exists because React Query keeps a query's `status` at
// `'success'` (so `isError` stays false) when it already has data and only
// a *background* refetch fails — which is exactly the "opened the app after
// a while, the refresh silently failed, and I'm staring at a stale
// snapshot" report. The caller detects that by comparing the success/error
// timestamps (most recent attempt errored after the last good load) and
// passes it in as `latestAttemptFailed`.
export function deriveRefreshState(args: {
  hasData: boolean;
  refetching: boolean;
  latestAttemptFailed: boolean;
}): { isRefreshing: boolean; refreshFailed: boolean } {
  const isRefreshing = args.hasData && args.refetching;
  const refreshFailed =
    args.hasData && !isRefreshing && args.latestAttemptFailed;
  return { isRefreshing, refreshFailed };
}

// Refetch policy shared by every query behind the feed surface — the
// id-list and item pages here, plus `/hot` (useHotFeedItems) and the
// pinned-top block (usePinnedFeedStories). Every trigger honors the same
// cache TTL: the app-wide 5-min `staleTime` (main.tsx). A refetch fires
// only when the cached feed is actually older than that.
//
//   - `refetchOnMount: true` is React Query's stale-gated default: it
//     refetches on mount only when the cache is older than `staleTime`.
//     Opening the app after a while still lands the current ranking — the
//     persisted cache keeps each query's original fetch timestamp, so a
//     snapshot from a previous session reads as stale and refreshes. But
//     navigating back to the feed from a story (a remount seconds later)
//     sees a fresh cache and does NOT re-check. This is the one line that
//     changed: it was `'always'`, the literal "ignore staleTime, refetch
//     on every mount" — which force-refreshed on every back-navigation and
//     surfaced the "Checking for new stories…" strip far more often than
//     readers expected.
//   - `refetchOnWindowFocus: true` is *also* stale-gated: a tab refocus
//     refetches only when the cache has gone stale, so returning to a feed
//     you were reading a minute ago is quiet while returning after the TTL
//     lapses picks up new stories. (This overrides the app-wide
//     `refetchOnWindowFocus: false`, kept on purpose for the feed.)
//   - `refetchOnReconnect: true` — regaining connectivity refetches, which
//     is what the offline refresh strip already promises.
//
// Pull-to-refresh and the More button remain the explicit "check now"
// gestures, bypassing the TTL entirely.
export const FEED_REFETCH_POLICY = {
  refetchOnMount: true,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
} as const;

export function useStoryIds(feed: Feed) {
  return useQuery({
    queryKey: ['storyIds', feed],
    queryFn: ({ signal }) => getStoryIds(feed, signal),
    // The retry/backoff for the id-list query is configured app-wide via
    // `setQueryDefaults(['storyIds'], …)` in main.tsx (see feedQueryRetry
    // / feedQueryRetryDelay) rather than inline here, so tests that want a
    // fast, deterministic error path can opt out with their own client.
    ...FEED_REFETCH_POLICY,
  });
}

export interface FeedItemsState {
  items: Array<HNItem | null>;
  allIds: number[] | undefined;
  totalIds: number;
  // True whenever we don't yet have any items to show, regardless of why
  // (in-flight first fetch, PersistQueryClientProvider rehydrate window,
  // or a paused query). Broader than React Query's `isLoading`
  // (= `isPending && isFetching`) so the skeleton stays on screen until
  // either data lands or the request errors, instead of letting a "No
  // stories yet." empty state flash during rehydrate.
  isPending: boolean;
  isError: boolean;
  isFetchingMore: boolean;
  hasMore: boolean;
  // A background refresh of the visible list is in flight while we already
  // have rows on screen (on-open refetch, window-focus refetch, or a
  // Retry). Drives the "Checking for new stories…" indicator.
  isRefreshing: boolean;
  // The most recent refresh attempt failed but we still have cached rows to
  // show — so the list on screen is stale and we say so instead of
  // silently sitting on it. See `deriveRefreshState`.
  refreshFailed: boolean;
  // `isRowVisible` lets the caller (StoryListImpl) tell a paginating
  // feed which fetched items will actually render after its own
  // `score > 1` / hidden / done filtering. `/hot`'s chase uses it to
  // keep advancing past pages whose only hot rows are ones the reader
  // has already hidden or marked done — without it the chase would
  // stop on such a row, the renderer would filter it out, and the
  // tap would read as a dead button. Plain (non-`/hot`) feeds load a
  // single page per tap and ignore the predicate.
  loadMore: (isRowVisible?: (item: HNItem) => boolean) => void;
  refetch: () => Promise<unknown>;
  // React Query's timestamp of the most recent *successful* items fetch.
  // It bumps on every completed fetch — initial load, pull-to-refresh,
  // window-focus/reconnect refetch, and each "More" page — even when the
  // returned data is byte-identical (structural sharing would keep the
  // `items` array reference stable, so array identity can't see that
  // refetch). Consumers use it as the "a refetch just landed" signal.
  dataUpdatedAt: number;
}

function pageRange(pageIndex: number): { start: number; take: number } {
  return { start: pageIndex * PAGE_SIZE, take: PAGE_SIZE };
}

function itemsLoadedAfter(pagesCount: number): number {
  return pagesCount * PAGE_SIZE;
}

// Combined view over the feed's id list plus a paginated fetch of items.
// Each page is its own cache entry so "load more" only fetches the new
// items, never re-fetches everything we already have.
export function useFeedItems(feed: Feed): FeedItemsState {
  const ids = useStoryIds(feed);
  const allIds = ids.data;

  const pages = useInfiniteQuery<Array<HNItem | null>>({
    queryKey: ['feedItems', feed],
    enabled: !!allIds && allIds.length > 0,
    initialPageParam: 0 as number,
    queryFn: async ({ pageParam, signal }) => {
      const { start, take } = pageRange(pageParam as number);
      const slice = (allIds ?? []).slice(start, start + take);
      if (slice.length === 0) return [];
      const fetched = await getItems(slice, signal);
      return fetched.map(thinForFeed);
    },
    getNextPageParam: (_last, allPages) => {
      const loaded = itemsLoadedAfter(allPages.length);
      return allIds && loaded < allIds.length ? allPages.length : undefined;
    },
    // Shared feed refetch policy (see FEED_REFETCH_POLICY): every trigger
    // (mount, focus, reconnect) is stale-gated on the 5-min TTL, so score
    // and comment counts refresh when the cache lapses instead of on every
    // remount. No `retry` override here on purpose: the id-list query
    // (useStoryIds) carries the retry, and the "More" chase (loadMore)
    // deliberately bails on a failed page rather than hammering the upstream
    // — see the loadMore comments and HotStoryList's "stops the More chase"
    // test.
    ...FEED_REFETCH_POLICY,
  });

  const items = useMemo<Array<HNItem | null>>(
    () => pages.data?.pages.flat() ?? [],
    [pages.data],
  );

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = pages;
  const idsRefetch = ids.refetch;
  const pagesRefetch = pages.refetch;

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const refetch = useCallback(
    () => Promise.all([idsRefetch(), pagesRefetch()]),
    [idsRefetch, pagesRefetch],
  );

  // If the id list changes (e.g. storyIds.refetchOnMount landed a fresh
  // ranking after a reload), the pages cache — whose queryKey is
  // ['feedItems', feed] and intentionally doesn't include the id list
  // so it survives pin/dismiss churn — is still pointing at yesterday's
  // ids. A stable signature of the first few ids is enough: if they
  // differ, the leading page is stale and must be refetched. We skip
  // the initial mount to avoid doubling up with refetchOnMount.
  const idsSignature = useMemo(() => {
    if (!allIds) return '';
    return allIds.slice(0, PAGE_SIZE).join(',');
  }, [allIds]);
  const mountedSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!idsSignature) return;
    if (mountedSignatureRef.current === null) {
      mountedSignatureRef.current = idsSignature;
      return;
    }
    if (mountedSignatureRef.current === idsSignature) return;
    mountedSignatureRef.current = idsSignature;
    pagesRefetch();
  }, [idsSignature, pagesRefetch]);

  // A refresh is in flight when either query is fetching but not doing its
  // first load and not paging in "More" (those have their own indicators).
  const refetching =
    (ids.isFetching && !ids.isLoading) ||
    (pages.isFetching && !pages.isLoading && !isFetchingNextPage);
  // The id list is the freshness signal for "are these the current top
  // stories?", so we key staleness off it: if its latest attempt errored
  // after its last good load, the ranking on screen is stale.
  const { isRefreshing, refreshFailed } = deriveRefreshState({
    hasData: items.length > 0,
    refetching,
    latestAttemptFailed: ids.errorUpdatedAt > ids.dataUpdatedAt,
  });

  return {
    items,
    allIds,
    totalIds: allIds?.length ?? 0,
    // The `pages` infinite query is disabled when `allIds` is empty,
    // and a disabled query reports `isPending: true` — so only count
    // `pages` as pending when its id list resolved with at least one
    // id; an empty id list is a real "no stories" outcome and must
    // fall through to the empty state, not the skeleton.
    isPending:
      ids.isPending ||
      (!!allIds &&
        allIds.length > 0 &&
        pages.isPending &&
        items.length === 0),
    isError: ids.isError || pages.isError,
    isFetchingMore: isFetchingNextPage,
    hasMore: !!hasNextPage,
    isRefreshing,
    refreshFailed,
    loadMore,
    refetch,
    dataUpdatedAt: pages.dataUpdatedAt,
  };
}
