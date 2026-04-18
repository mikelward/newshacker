import { useQuery } from '@tanstack/react-query';
import { getItems, getStoryIds, type HNItem } from '../lib/hn';
import type { Feed } from '../lib/feeds';

export const PAGE_SIZE = 30;

export function useStoryIds(feed: Feed) {
  return useQuery({
    queryKey: ['storyIds', feed],
    queryFn: ({ signal }) => getStoryIds(feed, signal),
  });
}

export function useStoryPage(feed: Feed, page: number) {
  const ids = useStoryIds(feed);
  const slice = ids.data?.slice(0, (page + 1) * PAGE_SIZE) ?? [];

  const items = useQuery<Array<HNItem | null>>({
    queryKey: ['storyItems', feed, slice.length, slice[0] ?? null],
    queryFn: ({ signal }) => getItems(slice, signal),
    enabled: slice.length > 0,
  });

  return {
    ids,
    items,
    slice,
    totalIds: ids.data?.length ?? 0,
  };
}
