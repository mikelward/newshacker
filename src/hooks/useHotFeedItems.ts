import { useInfiniteQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { getItems, type HNItem } from '../lib/hn';
import { isHotStory } from '../lib/format';
import {
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

// `/hot` candidate window per page. `PAGE_SIZE` from `useStoryList`
// is the standard feed page size (30); `/hot` slices that many ids
// from each source feed per page (so up to 60 candidates / page),
// which by spec yields 0–25 rendered rows after dedup and the
// `isHotStory` filter. SPEC.md *Story feeds → /hot* covers the
// "deliberately different from the other feeds" framing.

// Combined view over `/top ∪ /new` story-id lists, paginated 30 ids
// from *each* source per page (so up to 60 candidates), deduped
// across pages, with `predicate` applied on top to filter the
// rendered set. Defaults to `isHotStory` so /hot's `<HotStoryList>`
// gets the production rule unchanged. The /tuning Preview passes
// a compiled expression instead, so adjusting a slider re-filters
// without re-fetching HN (the React Query cache key is
// `['feedItems', 'hot']`, predicate-independent — both consumers
// share the same fetched candidates). Rows that came from `/new`
// and were not also in the `/top` slice for the page where they
// first appeared are tagged `'new'` so the renderer can swap the
// suppressed `hot` segment for a `new` debug segment (see SPEC.md
// *Hot flag*).
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
export function useHotFeedItems(
  predicate: (item: HNItem) => boolean = isHotStory,
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
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });

  // Cross-page dedup. The queryFn already dedupes within a page;
  // this layer drops anything that re-surfaces in a later page
  // after climbing between feeds. The `isHotStory` filter is
  // *not* applied here — consumers each pick their own predicate
  // so /hot uses the production rule while /tuning's Preview can
  // re-evaluate against a tunable expression without re-fetching.
  // StoryListImpl still applies its visibility filter (`score > 1`,
  // `!hidden`, `!dead`, `!deleted`, and by default `!done`) on top
  // of whichever predicate the consumer applies. The done check is
  // an opt-out: `/hot` keeps the default ("I've handled this, get
  // it off my list"), while the `/tuning` Preview passes
  // `includeDone` so done rows stay visible — the question there is
  // "what does the rule surface", not "what's left of my inbox".
  const { items, newSourceIds, allIds } = useMemo(() => {
    const seen = new Set<number>();
    const out: Array<HNItem | null> = [];
    const newSrc = new Set<number>();
    const idsCombined: number[] = [];
    for (const page of pages.data?.pages ?? []) {
      for (const entry of page) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        idsCombined.push(entry.id);
        const it = entry.item;
        if (!it) continue;
        if (!predicate(it)) continue;
        if (entry.source === 'new') newSrc.add(entry.id);
        out.push(it);
      }
    }
    return { items: out, newSourceIds: newSrc, allIds: idsCombined };
  }, [pages.data, predicate]);

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = pages;
  const topRefetch = topQuery.refetch;
  const newRefetch = newQuery.refetch;
  const pagesRefetch = pages.refetch;

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

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
    loadMore,
    refetch,
    newSourceIds,
  };
}
