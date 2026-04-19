import type { QueryClient } from '@tanstack/react-query';
import type { HNItem } from './hn';
import { SUMMARY_CACHE_TTL_MS } from '../hooks/useSummary';

// Cap on top-level comments we eagerly cache when a story is pinned or
// favorited. HN ranks `kids` roughly best-first, so slicing is a
// reasonable "top N" proxy. 30 is one /api/items batch — a single HTTP
// request — and covers the first visible page of most threads without
// blowing out cellular data or the persisted-cache quota.
export const TOP_LEVEL_COMMENT_PREFETCH_LIMIT = 30;

type BatchFetcher = (
  ids: number[],
  signal?: AbortSignal,
  options?: { fields?: 'feed' | 'full' },
) => Promise<Array<HNItem | null>>;

// Warm the top-level comment cache for a pinned/favorited story so an
// offline reader sees real discussion, not "Loading…". We write each
// comment under the same ['comment', id] key useCommentItem consumes,
// with the 7-day stale/gc window so the persister keeps these alive
// alongside the item root and AI summary.
//
// Best-effort: any failure is swallowed. Pinning must not depend on a
// successful comment prefetch.
export async function prefetchTopLevelComments(
  client: QueryClient,
  kidIds: readonly number[],
  fetcher: BatchFetcher,
  limit: number = TOP_LEVEL_COMMENT_PREFETCH_LIMIT,
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
  // comes back to read offline. We await the full set so callers can
  // rely on the cache being populated once their awaited prefetch
  // resolves (e.g. tests, and upstream prefetchers that return it).
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
        staleTime: SUMMARY_CACHE_TTL_MS,
        gcTime: SUMMARY_CACHE_TTL_MS,
      }),
    );
  }
  await Promise.all(writes);
}
