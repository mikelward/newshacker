import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getItem, getItems, type HNItem } from '../lib/hn';
import {
  getInFlightBatchComment,
  prefetchCommentBatch,
} from '../lib/commentPrefetch';
import { SUMMARY_RETENTION_MS } from './useSummary';

export interface ItemRoot {
  item: HNItem;
  kidIds: number[];
}

export async function loadRoot(
  id: number,
  signal: AbortSignal | undefined,
  client: QueryClient | null,
): Promise<ItemRoot | null> {
  const item = await getItem(id, signal);
  if (!item) return null;
  const kidIds = item.deleted || item.dead ? [] : (item.kids ?? []);
  // Warm the first page of top-level comments in a single /api/items
  // batch — fired, NOT awaited. The whole thread UI gates on this
  // function resolving, so awaiting here made every cold open pay two
  // serial round trips (item, then batch) before anything but the
  // skeleton painted. The batch registers its ids synchronously (see
  // commentPrefetch.ts), so the <Comment> observers that mount the
  // moment the story renders JOIN the in-flight batch via useCommentItem
  // instead of each firing its own Firebase round-trip. Best-effort as
  // before — a failed batch resolves observers to their single-item
  // fallback. Load-more (Thread.tsx) and reply expansion (Comment.tsx)
  // still wait on the same helper before mounting the next page of
  // observers; the pin/favorite prefetchers were already fire-and-forget
  // inside their own root queryFns, and their batches now register in
  // the same in-flight map — so pinning from the feed and immediately
  // opening the thread joins the pin-time batch too.
  if (client && kidIds.length > 0) {
    void prefetchCommentBatch(client, kidIds, getItems);
  }
  return { item, kidIds };
}

export function useItemTree(id: number) {
  const client = useQueryClient();
  return useQuery({
    queryKey: ['itemRoot', id],
    queryFn: ({ signal }) => loadRoot(id, signal, client),
    enabled: Number.isFinite(id),
    // Keep root story/comment metadata alongside pinned/favorite/comment
    // prefetches so a saved thread can hydrate immediately after a long
    // offline gap; freshness still follows the app-wide staleTime.
    gcTime: SUMMARY_RETENTION_MS,
  });
}

export function useCommentItem(id: number) {
  return useQuery({
    queryKey: ['comment', id],
    queryFn: async ({ signal }) => {
      // Join an in-flight comment batch when one is already fetching
      // this id — thread load fires its batch without blocking the root
      // paint, so observers routinely mount mid-batch. A null slot
      // (batch failure, upstream null) falls through to the single-item
      // path below so its throw-on-null retry semantics keep owning the
      // error case.
      const batched = getInFlightBatchComment(id);
      if (batched) {
        const item = await batched;
        if (item) return item;
      }
      const item = await getItem(id, signal);
      // Comment ids come from a parent's `kids` array, so they always
      // reference real items — Firebase resolving null here is upstream
      // trouble (replication lag, transient errors), not "deleted"
      // (deleted comments resolve as { deleted: true }). Throw so the
      // failure is retryable instead of being cached as fresh data for
      // the full 7-day staleTime (and persisted), which is how one bad
      // night used to leave comments permanently blank.
      if (!item) throw new Error(`Comment ${id} unavailable`);
      return item;
    },
    enabled: Number.isFinite(id),
    // Match prefetchCommentBatch's 7-day window so observer-driven
    // refetches don't race the batch: on a Thread re-mount after the
    // short default staleTime, every useCommentItem would otherwise
    // fire its own single-item Firebase request in parallel with
    // loadRoot's batched /api/items refresh, losing the batch benefit.
    // Freshness comes via the root-refetch batch instead.
    staleTime: SUMMARY_RETENTION_MS,
    gcTime: SUMMARY_RETENTION_MS,
  });
}

export { loadRoot as _loadRootForTests };
