import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getItems, type HNItem } from '../lib/hn';
import { getPinnedEntries } from '../lib/pinnedStories';
import { usePinnedStories } from './usePinnedStories';

export interface PinnedFeedState {
  stories: HNItem[];
  isLoading: boolean;
}

// All of the reader's pinned stories, surfaced in a block at the top of
// the home feed (oldest-pin-first, matching the dedicated /pinned route).
// The feed body excludes pinned ids, so a pin lives in exactly one place
// on the home view — whether HN still ranks it on a later, not-yet-loaded
// page or it has dropped off the front page entirely. This replaces the
// older "off-feed only" behavior, where a pinned story still in HN's id
// list stayed at its natural feed position and only surfaced after the
// reader tapped More — i.e. some of your pins were invisible until you
// paginated to them.
//
// `feedItems` is the already-loaded feed window; item data for pins on a
// loaded page is reused from it so pinning a visible row doesn't trigger
// a redundant round-trip (or flicker the row out of the top block).
//
// Cost/reliability: at most one extra `/api/items` batch call when the
// reader has pins not already present in the loaded feed window (typical
// users have a handful, well under the 30-id chunk size, so it's a single
// request — often zero, since current top pins are already loaded). No new
// infra — rides the existing items proxy and edge cache. Failure degrades
// silently: the feed still renders if this fetch errors.
export function usePinnedFeedStories(
  feedItems: ReadonlyArray<HNItem | null> | undefined,
  enabled = true,
): PinnedFeedState {
  const { pinnedIds } = usePinnedStories();

  // Pinned item data we already have from the loaded feed pages.
  const loadedById = useMemo(() => {
    const byId = new Map<number, HNItem>();
    if (enabled && feedItems) {
      for (const item of feedItems) {
        if (!item || item.deleted || item.dead) continue;
        if (pinnedIds.has(item.id)) byId.set(item.id, item);
      }
    }
    return byId;
  }, [enabled, feedItems, pinnedIds]);

  // Pins whose item data we don't have yet — dropped off the feed, or on a
  // page the reader hasn't loaded. Fetched as one batch.
  const missingIds = useMemo(() => {
    if (!enabled || pinnedIds.size === 0) return [];
    const ids: number[] = [];
    for (const id of pinnedIds) {
      if (!loadedById.has(id)) ids.push(id);
    }
    return ids;
  }, [enabled, pinnedIds, loadedById]);

  const missingKey = missingIds.join(',');

  const query = useQuery({
    queryKey: ['pinnedFeedItems', missingKey],
    queryFn: ({ signal }) => getItems(missingIds, signal),
    enabled: missingIds.length > 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });

  const stories = useMemo<HNItem[]>(() => {
    if (!enabled || pinnedIds.size === 0) return [];
    const byId = new Map<number, HNItem>(loadedById);
    for (const item of query.data ?? []) {
      if (!item) continue;
      if (item.deleted || item.dead) continue;
      byId.set(item.id, item);
    }
    // Oldest-pin-first, matching the /pinned route.
    return getPinnedEntries()
      .slice()
      .sort((a, b) => a.at - b.at)
      .map((entry) => byId.get(entry.id))
      .filter((x): x is HNItem => x != null);
  }, [enabled, pinnedIds, loadedById, query.data]);

  return {
    stories,
    isLoading: missingIds.length > 0 && query.isLoading,
  };
}
