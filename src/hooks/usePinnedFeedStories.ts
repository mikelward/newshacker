import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { getItems, type HNItem } from '../lib/hn';
import { getPinnedEntries } from '../lib/pinnedStories';
import type { ItemRoot } from './useItemTree';
import { FEED_REFETCH_POLICY } from './useStoryList';
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
// Pins outside that window paint from the persisted `['itemRoot', id]`
// cache the pin warm already filled, so the block renders from disk on
// open and the network round trip below is only ever a refresh.
//
// Cost/reliability: one extra `/api/items` batch call when the reader has
// pins not already present in the loaded feed window — often zero (current
// top pins are already loaded), and a single request for the handful most
// readers keep, but getItems chunks at 30, so an uncapped pin list costs
// ceil(n / 30) parallel calls. No new infra — rides the existing items
// proxy and edge cache. Failure degrades silently for the feed itself,
// which still renders; a pin the batch didn't resolve is dropped from the
// block unless the persisted itemRoot cache can stand in for it.
export function usePinnedFeedStories(
  feedItems: ReadonlyArray<HNItem | null> | undefined,
  enabled = true,
): PinnedFeedState {
  const { pinnedIds } = usePinnedStories();
  const queryClient = useQueryClient();

  // Pinned item data we already have from the loaded feed pages. Dead
  // and deleted rows are kept rather than filtered: "this story is dead
  // now" is an answer, and a fresher one than anything on disk. The
  // merge below is where it's applied, by *removing* the id — filtering
  // here would leave a stale live copy from the cache to take its place,
  // and would also send the id off to be fetched again.
  const loadedById = useMemo(() => {
    const byId = new Map<number, HNItem>();
    if (enabled && feedItems) {
      for (const item of feedItems) {
        if (!item) continue;
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

  // Track the itemRoot cache for the ids below, so a root landing after
  // this hook rendered still paints — the pinned offline sync (or a
  // sibling tab, via queryCacheSync) usually beats our own batch to it.
  //
  // `useSyncExternalStore` rather than a subscribe-in-an-effect, because
  // subscribing is not atomic with the render that read the cache: a
  // root landing in that gap fires no event a fresh subscriber can see,
  // and the row would sit blank until the batch settled — the exact wait
  // this hook exists to remove. React re-reads the snapshot right after
  // subscribing and re-renders if it moved, which is what closes the gap;
  // an effect can only bump a counter it has no way to know it needs.
  //
  // The snapshot has to be derived from the cache itself for that to
  // work (an event counter would be unchanged by a write that predates
  // the subscription). Summing `dataUpdatedAt` gives a number that moves
  // on any arrival or update, and it's ≤30 lookups — pins fit well under
  // the batch size.
  const subscribeToRoots = useCallback(
    (onStoreChange: () => void) =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.query.queryKey[0] === 'itemRoot') onStoreChange();
      }),
    [queryClient],
  );
  const rootsVersion = useSyncExternalStore(subscribeToRoots, () =>
    missingIds.reduce(
      (sum, id) =>
        sum + (queryClient.getQueryState(['itemRoot', id])?.dataUpdatedAt ?? 0),
      0,
    ),
  );

  // Pinned stories the app already downloaded — every pin gets its item
  // root warmed at pin time and topped up by the pinned offline sync, and
  // those queries are locked at `gcTime: Infinity` and persisted, so after
  // rehydrate they're on disk for the whole pinned set.
  //
  // Reading them here is what keeps the block from blanking out: the batch
  // below is keyed on the *whole* missing-id list, so one arriving pin (a
  // cross-device pin landing from `/api/sync`, say) changes the key and
  // leaves every other pinned row with no query data until a fresh
  // `/api/items` round trip completes — a second of skeletons for rows the
  // app had in hand the whole time. Cached data paints immediately and the
  // batch refreshes scores and comment counts underneath.
  const cachedById = useMemo(() => {
    void rootsVersion; // read so a cache arrival re-runs this memo
    const byId = new Map<number, HNItem>();
    if (!enabled) return byId;
    for (const id of missingIds) {
      const item = queryClient.getQueryData<ItemRoot | null>(['itemRoot', id])
        ?.item;
      if (!item || item.deleted || item.dead) continue;
      byId.set(id, item);
    }
    return byId;
  }, [enabled, missingIds, queryClient, rootsVersion]);

  const query = useQuery({
    queryKey: ['pinnedFeedItems', missingKey],
    queryFn: ({ signal }) => getItems(missingIds, signal),
    enabled: missingIds.length > 0,
    // Same feed refetch policy as the feed body (FEED_REFETCH_POLICY):
    // mount/focus/reconnect refetches are stale-gated on the 5-min TTL, so
    // the top pinned block doesn't re-fetch pinned item data on every
    // remount either — only once the cache lapses.
    ...FEED_REFETCH_POLICY,
  });

  const stories = useMemo<HNItem[]>(() => {
    if (!enabled || pinnedIds.size === 0) return [];
    // Freshest wins: the just-fetched batch over the loaded feed window
    // over what's on disk from a previous warm. A fresher source saying
    // the story is dead or deleted *removes* the row — skipping it would
    // let a stale live copy from the cache stand in for a definitive
    // newer answer, which is how the row survived being killed upstream.
    const byId = new Map<number, HNItem>(cachedById);
    const apply = (item: HNItem | null | undefined) => {
      if (!item) return;
      if (item.deleted || item.dead) byId.delete(item.id);
      else byId.set(item.id, item);
    };
    for (const item of loadedById.values()) apply(item);
    for (const item of query.data ?? []) apply(item);
    // Oldest-pin-first, matching the /pinned route.
    return getPinnedEntries()
      .slice()
      .sort((a, b) => a.at - b.at)
      .map((entry) => byId.get(entry.id))
      .filter((x): x is HNItem => x != null);
  }, [enabled, pinnedIds, cachedById, loadedById, query.data]);

  return {
    stories,
    // Only "loading" while there's nothing to show — a cached row on
    // screen with the batch still in flight is a background refresh.
    isLoading: stories.length === 0 && missingIds.length > 0 && query.isLoading,
  };
}
