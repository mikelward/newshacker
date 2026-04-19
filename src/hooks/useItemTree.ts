import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getItem, getItems, type HNItem } from '../lib/hn';
import { prefetchCommentBatch } from '../lib/commentPrefetch';

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
    // Matches the prefetch TTL on commentPrefetch — once the top-level
    // batch has populated this key, we don't want each Comment observer
    // firing a refetch just because the default 60s window lapsed during
    // scroll. Edits surface when the root refetches and re-runs the batch.
    staleTime: 5 * 60_000,
  });
}

export { loadRoot as _loadRootForTests };
