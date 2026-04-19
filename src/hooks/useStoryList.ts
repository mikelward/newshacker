import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { getItems, getStoryIds, type HNItem } from '../lib/hn';
import type { Feed } from '../lib/feeds';

export const PAGE_SIZE = 30;

// The first fetch grabs three pages' worth of items in one parallel batch.
// That gives the first paint a full screen of stories even when the user
// has dismissed many of them, so we don't have to chain several small
// fetches (each with its own visible "Loading…" state) to fill one
// viewport. Subsequent pages use the smaller PAGE_SIZE.
const FIRST_PAGE_MULTIPLIER = 3;
const FIRST_PAGE_SIZE = PAGE_SIZE * FIRST_PAGE_MULTIPLIER;

export function useStoryIds(feed: Feed) {
  return useQuery({
    queryKey: ['storyIds', feed],
    queryFn: ({ signal }) => getStoryIds(feed, signal),
  });
}

export interface FeedItemsState {
  items: Array<HNItem | null>;
  totalIds: number;
  isLoading: boolean;
  isError: boolean;
  isFetchingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
  refetch: () => void;
}

function pageRange(pageIndex: number): { start: number; take: number } {
  if (pageIndex === 0) return { start: 0, take: FIRST_PAGE_SIZE };
  const start = FIRST_PAGE_SIZE + (pageIndex - 1) * PAGE_SIZE;
  return { start, take: PAGE_SIZE };
}

function itemsLoadedAfter(pagesCount: number): number {
  if (pagesCount === 0) return 0;
  return FIRST_PAGE_SIZE + Math.max(0, pagesCount - 1) * PAGE_SIZE;
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
      return getItems(slice, signal);
    },
    getNextPageParam: (_last, allPages) => {
      const loaded = itemsLoadedAfter(allPages.length);
      return allIds && loaded < allIds.length ? allPages.length : undefined;
    },
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

  const refetch = useCallback(() => {
    idsRefetch();
    pagesRefetch();
  }, [idsRefetch, pagesRefetch]);

  return {
    items,
    totalIds: allIds?.length ?? 0,
    isLoading: ids.isLoading || (pages.isLoading && items.length === 0),
    isError: ids.isError || pages.isError,
    isFetchingMore: isFetchingNextPage,
    hasMore: !!hasNextPage,
    loadMore,
    refetch,
  };
}
