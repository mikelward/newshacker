import type { QueryClient } from '@tanstack/react-query';
import type { HNItem } from './hn';
import { SUMMARY_RETENTION_MS } from '../hooks/useSummary';

// Cap on comments we batch in a single request. 30 matches the
// /api/items proxy's MAX_IDS and is one HTTP round-trip. For top-level
// kids of a story, HN ranks them roughly best-first, so slicing is a
// reasonable "top N" proxy; for a comment's children the same batch
// bound keeps an expand-click cheap even on huge subthreads.
export const COMMENT_BATCH_LIMIT = 30;

// Hard ceiling on how long a batch prefetch may run. Thread's
// infinite-scroll sentinel and Comment's reply expansion wait on this
// helper before mounting the next page of <Comment>s — without a
// deadline, a hung /api/items request (slow upstream, half-dead radio)
// left the reader staring at placeholder skeletons until the browser's
// own fetch timeout, often minutes. (loadRoot fires the helper without
// awaiting it, so there the deadline bounds how long mid-batch
// observers wait on their joined slots instead.) On abort the prefetch
// is swallowed like any other failure and each Comment falls back to
// its own per-item Firebase fetch.
export const COMMENT_BATCH_TIMEOUT_MS = 8000;

function batchTimeoutSignal(): AbortSignal | undefined {
  // AbortSignal.timeout is everywhere we support (2022+ browsers,
  // Node 18+); the guard is for older test environments only.
  if (typeof AbortSignal === 'undefined') return undefined;
  if (typeof AbortSignal.timeout !== 'function') return undefined;
  return AbortSignal.timeout(COMMENT_BATCH_TIMEOUT_MS);
}

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
// `gcTime` overrides the default 7-day window — pinned-story prefetches
// pass `Number.POSITIVE_INFINITY` so the comment cache for a pinned
// thread is never evicted (see src/lib/pinnedQueryRetention.ts).
//
// Best-effort: any failure is swallowed. Callers must not depend on a
// successful prefetch (per-comment useCommentItem falls back to
// individual Firebase fetches).
// In-flight batch registry: while a batch fetch is running, each id in
// its slice maps to a promise of that id's slot. Thread load no longer
// awaits the batch before the story paints (loadRoot fires it and
// returns after one round trip), so <Comment> observers can mount while
// the batch is still in flight — without this registry each would fire
// its own single-item Firebase fetch, the 30-request stampede the batch
// exists to prevent. useCommentItem consults this first and joins the
// batch. Ids are registered SYNCHRONOUSLY (before any await), so a
// caller that kicks a batch and immediately renders observers is safe.
const inFlightBatchItems = new Map<number, Promise<HNItem | null>>();

export function getInFlightBatchComment(
  id: number,
): Promise<HNItem | null> | undefined {
  return inFlightBatchItems.get(id);
}

export function _resetInFlightBatchForTests(): void {
  inFlightBatchItems.clear();
}

export async function prefetchCommentBatch(
  client: QueryClient,
  kidIds: readonly number[],
  fetcher: BatchFetcher,
  limit: number = COMMENT_BATCH_LIMIT,
  gcTime: number = SUMMARY_RETENTION_MS,
): Promise<void> {
  if (kidIds.length === 0) return;
  const slice = kidIds.slice(0, limit);
  // A failed batch resolves every slot to null (never rejects), so a
  // joined observer falls back to its own single-item fetch — the same
  // best-effort contract awaiting callers already rely on.
  const fetchPromise: Promise<Array<HNItem | null>> = (async () => {
    try {
      return await fetcher(slice, batchTimeoutSignal(), { fields: 'full' });
    } catch {
      return slice.map(() => null);
    }
  })();
  // Register slots for ids no other batch is already fetching — an
  // overlapping batch (load-more racing a root refetch) keeps the first
  // claim, and only the claimer clears it below.
  const claimed: number[] = [];
  slice.forEach((id, index) => {
    if (!inFlightBatchItems.has(id)) {
      claimed.push(id);
      inFlightBatchItems.set(
        id,
        fetchPromise.then((items) => items[index] ?? null),
      );
    }
  });
  // The registry entries live until the CACHE WRITES below land, not
  // just until the fetch resolves — clearing between the two would give
  // a mounting observer a window with no slot to join and no cache to
  // hydrate from, and it would fire the very single-item fetch this
  // exists to prevent.
  try {
    const items = await fetchPromise;
    if (items.every((item) => item === null)) {
      // Whole batch failed (the catch above) or upstream returned
      // nothing usable — keep the old "failed batch writes nothing"
      // behavior; joined observers fall back to single fetches.
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
          gcTime,
        }),
      );
    }
    await Promise.all(writes);
  } finally {
    for (const id of claimed) inFlightBatchItems.delete(id);
  }
}
