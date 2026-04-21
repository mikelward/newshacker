import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getItems, type HNItem } from '../lib/hn';
import { getPinnedEntries } from '../lib/pinnedStories';
import { usePinnedStories } from './usePinnedStories';

export interface OffFeedPinnedState {
  stories: HNItem[];
  isLoading: boolean;
}

// Pinned stories that aren't present in the current feed's id list.
// Rendered in a "Pinned" section above the feed so items the reader
// cares about stay reachable from the home view after HN's ranking
// drops them off the top page. Ordered newest-pin-first to match the
// dedicated /pinned route.
//
// Cost/reliability: one extra `/api/items` batch call when the reader
// has at least one off-feed pin (typical users have a handful, well
// under the 30-id chunk size, so it's a single request). No new
// infra — rides the existing items proxy and edge cache. Failure
// degrades silently: the feed still renders if this fetch errors.
export function useOffFeedPinnedStories(
  feedIds: readonly number[] | undefined,
): OffFeedPinnedState {
  const { pinnedIds } = usePinnedStories();

  const missingIds = useMemo(() => {
    if (pinnedIds.size === 0) return [];
    if (!feedIds) return [];
    const feedSet = new Set(feedIds);
    const ids: number[] = [];
    for (const id of pinnedIds) {
      if (!feedSet.has(id)) ids.push(id);
    }
    if (ids.length === 0) return ids;
    const at = new Map(getPinnedEntries().map((e) => [e.id, e.at]));
    ids.sort((a, b) => (at.get(b) ?? 0) - (at.get(a) ?? 0));
    return ids;
  }, [pinnedIds, feedIds]);

  const missingKey = missingIds.join(',');

  const query = useQuery({
    queryKey: ['offFeedPinnedItems', missingKey],
    queryFn: ({ signal }) => getItems(missingIds, signal),
    enabled: missingIds.length > 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });

  const stories = useMemo<HNItem[]>(() => {
    if (missingIds.length === 0) return [];
    const data = query.data ?? [];
    const byId = new Map<number, HNItem>();
    for (const item of data) {
      if (!item) continue;
      if (item.deleted || item.dead) continue;
      byId.set(item.id, item);
    }
    // Preserve the newest-pin-first order from missingIds rather than
    // relying on the order of the API response.
    return missingIds
      .map((id) => byId.get(id))
      .filter((x): x is HNItem => x != null);
  }, [query.data, missingIds]);

  return {
    stories,
    isLoading: missingIds.length > 0 && query.isLoading,
  };
}
