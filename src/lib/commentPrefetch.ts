import type { QueryClient } from '@tanstack/react-query';
import type { HNItem } from './hn';
import { SUMMARY_CACHE_TTL_MS } from '../hooks/useSummary';

// Cap on comments we batch in a single request. 30 matches the
// /api/items proxy's MAX_IDS and is one HTTP round-trip. For top-level
// kids of a story, HN ranks them roughly best-first, so slicing is a
// reasonable "top N" proxy; for a comment's children the same batch
// bound keeps an expand-click cheap even on huge subthreads.
export const COMMENT_BATCH_LIMIT = 30;

type BatchFetcher = (
  ids: number[],
  signal?: AbortSignal,
  options?: { fields?: 'feed' | 'full' },
) => Promise<Array<HNItem | null>>;

// Warm the comment cache for a batch of ids — top-level kids of a story,
// or children of a comment the user just expanded. We write each item
// under the same ['comment', id] key useCommentItem consumes, with the
// 7-day stale/gc window so the persister keeps these alive alongside
// the item root and AI summary.
//
// Best-effort: any failure is swallowed. Callers must not depend on a
// successful prefetch (per-comment useCommentItem falls back to
// individual Firebase fetches).
export async function prefetchCommentBatch(
  client: QueryClient,
  kidIds: readonly number[],
  fetcher: BatchFetcher,
  limit: number = COMMENT_BATCH_LIMIT,
): Promise<void> {
  if (kidIds.length === 0) return;
  const slice = kidIds.slice(0, limit);
  let items: Array<HNItem | null>;
  try {
    items = await fetcher(slice, undefined, { fields: 'full' });
  } catch {
    return;
  }
  // Use prefetchQuery (rather than setQueryData) so each comment entry
  // picks up the 7-day gcTime — otherwise the default 1-hour gc wipes
  // them from memory (and then the persister) long before the user
  // comes back to read offline. `staleTime: 0` makes prefetchQuery run
  // the (already-resolved) queryFn even when a value exists, so a
  // root-refetch batch actually overwrites older cached comment data
  // with the fresh version — how edits and deletions surface in the
  // thread. We await the full set so callers can rely on the cache
  // being populated once their awaited prefetch resolves (e.g. tests,
  // and upstream prefetchers that return it).
  const writes: Array<Promise<void>> = [];
  for (let i = 0; i < slice.length; i += 1) {
    const item = items[i];
    if (!item) continue;
    const id = slice[i];
    const resolved = item;
    writes.push(
      client.prefetchQuery({
        queryKey: ['comment', id],
        queryFn: () => resolved,
        staleTime: 0,
        gcTime: SUMMARY_CACHE_TTL_MS,
      }),
    );
  }
  await Promise.all(writes);
}
