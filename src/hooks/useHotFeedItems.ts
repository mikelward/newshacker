import { useInfiniteQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { getItems, type HNItem } from '../lib/hn';
import {
  deriveRefreshState,
  PAGE_SIZE,
  useStoryIds,
  type FeedItemsState,
} from './useStoryList';

// Same per-feed thinning as `useStoryList`: the rendered row only
// needs the title-bar fields, and the persisted React Query cache
// stays small if we drop everything else (notably the `kids`
// comment-tree array, which can be large).
function thinForFeed(item: HNItem | null): HNItem | null {
  if (!item) return null;
  const { id, type, by, time, title, url, text, score, descendants, dead, deleted } = item;
  return { id, type, by, time, title, url, text, score, descendants, dead, deleted };
}

interface HotPageEntry {
  id: number;
  // Which source feed put this id on the candidate list for the page
  // it first appeared on. Only `'new'`-tagged entries get the orange
  // `new` debug segment in the meta line on `/hot`. Once a row has
  // been classified its source label sticks across page advances —
  // an id that surfaces in `/new` on page 0 and later climbs into
  // `/top`'s page-1 slice still renders with `new` because that's
  // how it earned its row on the page where it first appeared.
  source: 'top' | 'new';
  item: HNItem | null;
}

export interface HotFeedItemsState extends FeedItemsState {
  newSourceIds: Set<number>;
}

// Cross-page projection of the fetched candidates into the rendered set:
// dedup across pages (keeping the earliest source label), drop misses,
// then apply `predicate`. Shared by the render-time `useMemo` and the
// `loadMore` chase so both compute "what survives the filter" identically
// — the chase reads it straight off `fetchNextPage`'s resolved data, which
// avoids any dependence on a React re-render landing first.
function projectHotPages(
  pages: HotPageEntry[][],
  predicate: (item: HNItem) => boolean,
): { items: Array<HNItem | null>; newSourceIds: Set<number>; allIds: number[] } {
  const seen = new Set<number>();
  const items: Array<HNItem | null> = [];
  const newSourceIds = new Set<number>();
  const allIds: number[] = [];
  for (const page of pages) {
    for (const entry of page) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      allIds.push(entry.id);
      const it = entry.item;
      if (!it) continue;
      if (!predicate(it)) continue;
      if (entry.source === 'new') newSourceIds.add(entry.id);
      items.push(it);
    }
  }
  return { items, newSourceIds, allIds };
}

// `/hot` candidate window per page. `PAGE_SIZE` from `useStoryList`
// is the standard feed page size (30); `/hot` slices that many ids
// from each source feed per page (so up to 60 candidates / page),
// which by spec yields 0–25 rendered rows after dedup and the
// `isHotStory` filter. SPEC.md *Story feeds → /hot* covers the
// "deliberately different from the other feeds" framing.

// Combined view over `/top ∪ /new` story-id lists, paginated 30 ids
// from *each* source per page (so up to 60 candidates), deduped
// across pages, with `predicate` applied on top to filter the
// rendered set. `predicate` is required: `/hot`'s `<HotStoryList>`
// supplies a closure over `isHotStory(item, hotNow, hotThresholds)`
// (where `hotNow` is captured per render) so the user's
// Hot customize panel overrides drive which fetched candidates render,
// while `/tuning`'s Preview supplies a compiled expression directly.
// Adjusting a slider re-filters without re-fetching HN (the React
// Query cache key is `['feedItems', 'hot']`, predicate-independent —
// both consumers share the same fetched candidates). Rows that came
// from `/new` and were not also in the `/top` slice for the page
// where they first appeared are tagged `'new'` so the renderer can
// swap the suppressed `hot` segment for a `new` debug segment (see
// SPEC.md *Hot flag*).
//
// Pagination: each "More" tap advances both source feeds one page
// (30 ids) in lockstep. The button disappears when both source
// feeds are exhausted. Rows that surface in an earlier page are
// deduped out of later pages so a story that climbed from `/new`
// into `/top` on a later refresh doesn't double-render.
//
// Cost (rule 11): one extra `<feed>stories.json` ID-list fetch
// (tiny edge-cached JSON array of integers) and up to 30 extra
// `/api/items` lookups vs. a normal feed page (~2× the items-proxy
// traffic per `/hot` load), all on the existing items proxy with
// no new infra. Reliability: if either source feed errors, the
// page degrades to whichever survived rather than blanking.
// `predicate` is required — every caller has its own source of truth
// for what "hot" means. `<HotStoryList>` binds it to `useHotThresholds()`
// at the call site so the user's Hot customize panel overrides drive `/hot`;
// `/tuning`'s Preview supplies a compiled expression directly. Keeping
// the subscription out of this hook means `/tuning` doesn't pay for a
// hot-threshold listener it would never use (Copilot review on PR #240).
export function useHotFeedItems(
  predicate: (item: HNItem) => boolean,
): HotFeedItemsState {
  const topQuery = useStoryIds('top');
  const newQuery = useStoryIds('new');
  const topIds = topQuery.data;
  const newIds = newQuery.data;

  // Both source id lists have to be in hand before we can compute
  // the union. Until then the `enabled` gate below keeps the
  // infinite query parked. Empty arrays still count as "loaded" —
  // an HN outage that returns `[]` shouldn't keep the spinner
  // spinning forever; StoryListImpl renders the empty state.
  const idsLoaded = !!topIds && !!newIds;

  const pages = useInfiniteQuery<HotPageEntry[]>({
    queryKey: ['feedItems', 'hot'],
    enabled: idsLoaded,
    initialPageParam: 0 as number,
    queryFn: async ({ pageParam, signal }) => {
      const p = pageParam as number;
      const topSlice = (topIds ?? []).slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
      const newSlice = (newIds ?? []).slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
      // Order matters: top-first means a candidate that sits in
      // both slices keeps its `top` tag (no `new` badge), matching
      // the spec's "rows that came from `/new` and were *not* also
      // in the `/top` slice".
      const topSet = new Set(topSlice);
      const candidates: number[] = [];
      const seen = new Set<number>();
      for (const id of topSlice) {
        if (seen.has(id)) continue;
        seen.add(id);
        candidates.push(id);
      }
      for (const id of newSlice) {
        if (seen.has(id)) continue;
        seen.add(id);
        candidates.push(id);
      }
      if (candidates.length === 0) return [];
      const fetched = await getItems(candidates, signal);
      return candidates.map((id, i) => ({
        id,
        source: topSet.has(id) ? ('top' as const) : ('new' as const),
        item: thinForFeed(fetched[i] ?? null),
      }));
    },
    getNextPageParam: (_last, allPages) => {
      // Both source feeds advance in lockstep, so the next page is
      // available as long as *either* source still has ids beyond
      // the cumulative window. The button disappears (no next page)
      // only when both are exhausted.
      const consumed = allPages.length * PAGE_SIZE;
      const topRemaining = (topIds?.length ?? 0) - consumed;
      const newRemaining = (newIds?.length ?? 0) - consumed;
      if (topRemaining <= 0 && newRemaining <= 0) return undefined;
      return allPages.length;
    },
    // Match the same freshness contract as `useFeedItems`: bypass
    // the app-wide staleTime on mount/focus so a reload renders the
    // current ranking, not yesterday's.
    // No `retry` override here on purpose — the source id-list queries
    // (useStoryIds for top/new) carry the retry, while the "More" chase
    // must bail on a failed page rather than re-issue it in a loop (see
    // loadMore below and the "stops the More chase" test).
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  // Cross-page dedup. The queryFn already dedupes within a page;
  // this layer drops anything that re-surfaces in a later page
  // after climbing between feeds. The dedup is predicate-agnostic:
  // `/hot` keeps whichever ids first qualified under the
  // caller-provided, user-tuned predicate from Hot customize panel,
  // while `/tuning` applies the Preview's compiled expression to
  // the same fetched candidates without re-fetching.
  // StoryListImpl still applies its visibility filter (`score > 1`,
  // `!dead`, `!deleted`, and by default `!hidden` and `!done`) on
  // top of whichever predicate the consumer applies. The hidden
  // and done checks are opt-outs: `/hot` keeps both defaults
  // ("I've handled this, get it off my list" / "I said never
  // again"), while the `/tuning` Preview passes `includeDone` and
  // `includeHidden` so done rows show full rule output and hidden
  // rows surface as a tightening cue when the rule wrongly
  // promotes them.
  const { items, newSourceIds, allIds } = useMemo(
    () => projectHotPages(pages.data?.pages ?? [], predicate),
    [pages.data, predicate],
  );

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = pages;
  const topRefetch = topQuery.refetch;
  const newRefetch = newQuery.refetch;
  const pagesRefetch = pages.refetch;

  // A "More" tap has to reveal something or correctly run out. Because
  // the `isHotStory` predicate can reject an entire page of candidates,
  // a single page advance can survive the filter to zero new rows — which
  // reads as a dead button. So the tap keeps advancing pages until at
  // least one new row surfaces or both source feeds are exhausted. We
  // decide off `fetchNextPage`'s resolved data (deterministic) rather
  // than waiting for a React re-render of the filtered `items`, so there
  // is no render-timing race. This reveals *something* per tap, not a
  // fixed row count — a tap still stops at the first non-empty page.
  //
  // Cost (rule 11): worst case a tap fans out to every remaining page's
  // `/api/items` lookups when a long run of pages is fully filtered — the
  // same total fetches a reader would trigger tapping More repeatedly,
  // just batched, all on the existing items proxy, no new infra or
  // failure mode.
  const loadMore = useCallback(
    async (isRowVisible?: (item: HNItem) => boolean) => {
      if (!hasNextPage || isFetchingNextPage) return;
      // Count the rows that will actually *render*: the `isHotStory`
      // predicate decides candidacy, then `isRowVisible` (supplied by
      // StoryListImpl) drops the ones its own `score > 1` / hidden /
      // done filter would remove. Counting only `projectHotPages`
      // here would let the chase stop on a hot row the reader has
      // hidden or marked done — the renderer filters it out, so the
      // tap surfaces nothing and reads as a dead button.
      const countVisible = (pgs: HotPageEntry[][]): number => {
        const projected = projectHotPages(pgs, predicate).items;
        if (!isRowVisible) return projected.length;
        return projected.filter((it) => !!it && isRowVisible(it)).length;
      };
      const pagesBefore = pages.data?.pages ?? [];
      const visibleBefore = countVisible(pagesBefore);
      let loadedPages = pagesBefore.length;
      let result = await fetchNextPage();
      while (result.hasNextPage) {
        const nextPages = result.data?.pages ?? [];
        // A failed page fetch resolves without adding a page (TanStack
        // Query's default `throwOnError: false`), so the projected count
        // never moves — bail instead of hammering a failing upstream in a
        // tight loop. The feed's own `isError` then surfaces the error
        // state. `hasNextPage` going false (feeds exhausted) ends the loop
        // via the `while` guard.
        if (nextPages.length <= loadedPages) break;
        loadedPages = nextPages.length;
        if (countVisible(nextPages) > visibleBefore) {
          break;
        }
        result = await fetchNextPage();
      }
    },
    [hasNextPage, isFetchingNextPage, fetchNextPage, pages.data, predicate],
  );

  const refetch = useCallback(
    () => Promise.all([topRefetch(), newRefetch(), pagesRefetch()]),
    [topRefetch, newRefetch, pagesRefetch],
  );

  // Mirror of the source-id-signature guard in `useFeedItems`: when
  // either source feed's first-page ids change underneath us
  // (e.g. a refresh landed a new ranking), the cached pages cache
  // is pointed at yesterday's ids. A short signature of the leading
  // ids on each source is enough — if it differs from the mounted
  // signature, refetch the leading page.
  const sourceSignature = useMemo(() => {
    if (!topIds && !newIds) return '';
    const t = topIds?.slice(0, PAGE_SIZE).join(',') ?? '';
    const n = newIds?.slice(0, PAGE_SIZE).join(',') ?? '';
    return `${t}|${n}`;
  }, [topIds, newIds]);
  const mountedSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sourceSignature) return;
    if (mountedSignatureRef.current === null) {
      mountedSignatureRef.current = sourceSignature;
      return;
    }
    if (mountedSignatureRef.current === sourceSignature) return;
    mountedSignatureRef.current = sourceSignature;
    pagesRefetch();
  }, [sourceSignature, pagesRefetch]);

  const totalIds =
    Math.max(topIds?.length ?? 0, newIds?.length ?? 0);

  const refetching =
    (topQuery.isFetching && !topQuery.isLoading) ||
    (newQuery.isFetching && !newQuery.isLoading) ||
    (pages.isFetching && !pages.isLoading && !isFetchingNextPage);
  // Mirror the isError "degrade to whichever source survived" rule: `/hot`
  // is fresh as long as *either* source ranking refreshed, so only call it
  // stale when the latest attempt on *both* sources errored after their
  // last good load.
  const topFailed = topQuery.errorUpdatedAt > topQuery.dataUpdatedAt;
  const newFailed = newQuery.errorUpdatedAt > newQuery.dataUpdatedAt;
  const { isRefreshing, refreshFailed } = deriveRefreshState({
    hasData: items.length > 0,
    refetching,
    latestAttemptFailed: topFailed && newFailed,
  });

  return {
    items,
    // `allIds` is consumed by `useOffFeedPinnedStories` to decide
    // which pinned rows are off-feed. For `/hot` it's the union of
    // all candidates seen across pages so far, deduped — pinned
    // rows that aren't currently in either source feed prepend at
    // the top.
    allIds,
    totalIds,
    isLoading:
      topQuery.isLoading ||
      newQuery.isLoading ||
      (pages.isLoading && items.length === 0 && idsLoaded),
    // `topQuery.isError && newQuery.isError` would be the strict
    // "both source feeds dead" guard; the spec asks us to degrade
    // to whichever source survived rather than blanking, so a
    // single-source error is *not* an error from this hook's
    // perspective. The infinite query handles its own errors.
    isError: (topQuery.isError && newQuery.isError) || pages.isError,
    isFetchingMore: isFetchingNextPage,
    hasMore: !!hasNextPage,
    isRefreshing,
    refreshFailed,
    loadMore,
    refetch,
    newSourceIds,
  };
}
