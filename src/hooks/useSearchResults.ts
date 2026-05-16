import { useCallback, useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  searchStories,
  type SearchResultsPage,
  type SearchSort,
} from '../lib/algolia';
import type { HNItem } from '../lib/hn';

export interface SearchResultsState {
  hits: HNItem[];
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  isFetchingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
  refetch: () => Promise<unknown>;
}

// Infinite query over Algolia HN Search. `query` is trimmed once here
// so the queryKey doesn't change when the input only gains/loses
// surrounding whitespace, which would otherwise cause unnecessary
// refetches as the URL syncs.
export function useSearchResults(
  query: string,
  sort: SearchSort,
): SearchResultsState {
  const trimmed = query.trim();
  const enabled = trimmed.length > 0;

  const result = useInfiniteQuery<SearchResultsPage>({
    queryKey: ['searchResults', trimmed, sort],
    enabled,
    initialPageParam: 0 as number,
    queryFn: ({ pageParam, signal }) =>
      searchStories({
        query: trimmed,
        sort,
        page: pageParam as number,
        signal,
      }),
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
    // Search results are user-driven and stable enough to skip the
    // remount/refocus refetches the feed queries use.
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  const hits = useMemo<HNItem[]>(
    () => result.data?.pages.flatMap((p) => p.hits) ?? [],
    [result.data],
  );

  const { fetchNextPage, hasNextPage, isFetchingNextPage, refetch } = result;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return {
    hits,
    isLoading: enabled && result.isLoading,
    isFetching: enabled && result.isFetching,
    isError: result.isError,
    isFetchingMore: isFetchingNextPage,
    hasMore: !!hasNextPage,
    loadMore,
    refetch,
  };
}
