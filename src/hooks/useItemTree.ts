import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getItem, getItems, type HNItem } from '../lib/hn';
import { prefetchCommentBatch } from '../lib/commentPrefetch';
import { SUMMARY_CACHE_TTL_MS } from './useSummary';

export interface ItemRoot {
  item: HNItem;
  kidIds: number[];
}

async function loadRoot(
  id: number,
  signal: AbortSignal | undefined,
  client: QueryClient | null,
): Promise<ItemRoot | null> {
  const item = await getItem(id, signal);
  if (!item) return null;
  const kidIds = item.deleted || item.dead ? [] : (item.kids ?? []);
  // Warm the first page of top-level comments in a single /api/items
  // batch so the Comment observers that mount immediately after the
  // thread renders hydrate from cache instead of each firing their
  // own Firebase round-trip. Best-effort — pin/favorite flows already
  // rely on the same helper, and its failures are non-fatal.
  if (client && kidIds.length > 0) {
    await prefetchCommentBatch(client, kidIds, getItems);
  }
  return { item, kidIds };
}

export function useItemTree(id: number) {
  const client = useQueryClient();
  return useQuery({
    queryKey: ['itemRoot', id],
    queryFn: ({ signal }) => loadRoot(id, signal, client),
    enabled: Number.isFinite(id),
  });
}

export function useCommentItem(id: number) {
  return useQuery({
    queryKey: ['comment', id],
    queryFn: ({ signal }) => getItem(id, signal),
    enabled: Number.isFinite(id),
    // Match prefetchCommentBatch's 7-day window so observer-driven
    // refetches don't race the batch: on a Thread re-mount after the
    // short default staleTime, every useCommentItem would otherwise
    // fire its own single-item Firebase request in parallel with
    // loadRoot's batched /api/items refresh, losing the batch benefit.
    // Freshness comes via the root-refetch batch instead.
    staleTime: SUMMARY_CACHE_TTL_MS,
    gcTime: SUMMARY_CACHE_TTL_MS,
  });
}

export { loadRoot as _loadRootForTests };
