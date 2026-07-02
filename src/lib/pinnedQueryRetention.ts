import type { QueryClient, QueryKey } from '@tanstack/react-query';
import {
  PINNED_STORIES_CHANGE_EVENT,
  getPinnedIds,
} from './pinnedStories';
import type { HNItem } from './hn';
import type { ItemRoot } from '../hooks/useItemTree';

// "Pinned articles never get evicted" lives at this layer. React Query
// removes a query from the cache when its `gcTime` elapses with no
// observers; once removed, the next persister snapshot drops it from
// the persisted blob (IndexedDB, see idbPersister.ts) too. So "never
// evicted" reduces to "never let the gc
// timer fire on a pinned-story query." We do that by bumping each
// pinned-story query's `gcTime` to Infinity. Query.updateGcTime is
// `Math.max`-merged, so a later observer using the regular 7-day window
// can't shrink it back down.
//
// The persister side of the contract — `maxAge: Infinity` on
// PersistQueryClientProvider in src/main.tsx — handles the "user has
// been away for months" case. Without that, the rehydrate step would
// throw away the whole persisted blob (pinned data and all) when the
// blob's age exceeds maxAge.
//
// Two things are intentionally NOT done here:
//   - Lowering gcTime back to the default when a story is unpinned.
//     Math.max means we'd need a different mechanism (e.g.
//     query.setOptions outside the Math.max path) and the win is small:
//     the next page reload reseats the query at default gcTime anyway.
//   - Honoring CACHE_BUSTER. A buster bump deliberately wipes the whole
//     persisted cache (data shape changed, hydrated data would crash);
//     pinned entries ride along for the same reason.

const NEVER_EVICT_GC_TIME = Number.POSITIVE_INFINITY;

const STORY_KEY_HEADS = ['itemRoot', 'summary', 'comments-summary'] as const;

function lockQueryGcTime(client: QueryClient, queryKey: QueryKey): void {
  const query = client.getQueryCache().find({ queryKey, exact: true });
  if (!query) return;
  // setOptions merges and goes through updateGcTime, which Math.max-folds
  // the new gcTime into the current one — so writing Infinity here can't
  // be undone by an observer that later attaches with the regular 7-day
  // gcTime. That's the point: pin is the user's "keep this forever"
  // signal, observer options are just defaults.
  query.setOptions({ ...query.options, gcTime: NEVER_EVICT_GC_TIME });
  // setOptions doesn't cancel an in-flight gc timer (the timer is set
  // by the constructor, by the last observer detaching, or by the most
  // recent fetch-success). For a feed-warmed query that's been sitting
  // idle with a 7-day timer armed, just bumping options.gcTime would
  // leave the original eviction deadline ticking. scheduleGc() clears
  // any pending timeout and reschedules using the now-Infinity gcTime;
  // `isValidTimeout(Infinity) === false` means it skips arming a new
  // one, so the query lives indefinitely. The method is protected on
  // @tanstack/query-core's Removable base — accessing it is the same
  // shape this file's tests rely on, so a future minor-version bump
  // that rename it would break the test first.
  (query as unknown as { scheduleGc: () => void }).scheduleGc();
}

// Bump gcTime to Infinity on every cached query that belongs to this
// pinned story: itemRoot, both summaries, and the cached top-level
// comments (resolved through the itemRoot's kidIds). Idempotent —
// queries that already have Infinity gcTime are a no-op.
export function lockPinnedQueryGcTime(
  client: QueryClient,
  storyId: number,
): void {
  for (const head of STORY_KEY_HEADS) {
    lockQueryGcTime(client, [head, storyId]);
  }
  const root = client.getQueryData<ItemRoot | null>(['itemRoot', storyId]);
  const kidIds = root?.kidIds ?? [];
  for (const kidId of kidIds) {
    lockQueryGcTime(client, ['comment', kidId]);
  }
}

export function lockAllPinnedQueriesGcTime(client: QueryClient): void {
  for (const id of getPinnedIds()) {
    lockPinnedQueryGcTime(client, id);
  }
}

// Walk a comment's parent chain looking for a pinned story id. Top-level
// comments have `parent === storyId`, so they hit on the first iteration;
// nested replies climb through cached comment entries until they reach a
// story or run out. We bail (and don't lock) when the chain breaks —
// without a complete chain we can't tell whether the comment belongs to
// a pinned story, and a false-positive lock would pin unrelated comment
// data forever.
export function commentBelongsToPinnedStory(
  client: QueryClient,
  comment: Pick<HNItem, 'parent'> | null | undefined,
  pinnedIds: Set<number>,
): boolean {
  let parentId = comment?.parent;
  const visited = new Set<number>();
  while (typeof parentId === 'number') {
    if (pinnedIds.has(parentId)) return true;
    if (visited.has(parentId)) return false; // cycle guard
    visited.add(parentId);
    const parent = client.getQueryData<HNItem | null>(['comment', parentId]);
    if (!parent) return false;
    parentId = parent.parent;
  }
  return false;
}

// Subscribe to QueryCache 'added'/'updated' events and lock gcTime on
// any pinned-relevant query as soon as it lands. This closes two races
// the change-event listener alone misses:
//
//   1. Cross-tab queryCacheSync. Tab A pins → storage event fires
//      synchronously in tab B → tab B's change-event listener walks the
//      pinned set, but tab B's cache is still empty (tab A is mid-fetch).
//      Later, when queryCacheSync delivers tab A's warmed data via
//      setQueryData, the queries are created with whatever finite gcTime
//      that key normally uses. Without this subscriber, those queries
//      would expire at the default deadline despite the user's pin.
//
//   2. Late comment batches on a thread the user has already pinned.
//      Thread load-more (Thread.tsx) and reply expansion (Comment.tsx)
//      both call prefetchCommentBatch with the default gcTime. The
//      pin event already fired (and ran without those comments existing
//      yet), so plumbing a `gcTime` argument through every call site
//      isn't enough — only re-checking on each new addition is.
//
// We handle 'added' as the primary trigger; 'updated' (success) is also
// observed because a query created via setQueryData transitions through
// 'added' first and 'updated' second, and a comment may not have its
// `parent` field populated until the second event lands.
export function subscribeToPinnedCacheLocking(
  client: QueryClient,
): () => void {
  return client.getQueryCache().subscribe((event) => {
    if (event.type !== 'added' && event.type !== 'updated') return;
    if (
      event.type === 'updated' &&
      // We only care once data has arrived. Errors and pending states
      // can't tell us anything about ancestry.
      !(event.action.type === 'success' && event.query.state.data !== undefined)
    ) {
      return;
    }
    const queryKey = event.query.queryKey;
    if (!Array.isArray(queryKey) || queryKey.length !== 2) return;
    const [head, id] = queryKey;
    if (typeof id !== 'number') return;
    const pinnedIds = getPinnedIds();
    if (pinnedIds.size === 0) return;
    if (head === 'itemRoot') {
      if (!pinnedIds.has(id)) return;
      // Lock the root *and* every kid-comment that's already been
      // warmed under this story — when itemRoot lands via cross-tab
      // sync, the kidIds it carries become resolvable here for the
      // first time.
      lockPinnedQueryGcTime(client, id);
      return;
    }
    if (head === 'summary' || head === 'comments-summary') {
      if (pinnedIds.has(id)) lockQueryGcTime(client, queryKey);
      return;
    }
    if (head === 'comment') {
      const data = event.query.state.data as
        | Pick<HNItem, 'parent'>
        | null
        | undefined;
      if (commentBelongsToPinnedStory(client, data, pinnedIds)) {
        lockQueryGcTime(client, queryKey);
      }
    }
  });
}

// Subscribe to pin/unpin changes (same-tab via the custom event,
// cross-tab via the storage event that pinnedStories.ts also fires) and
// re-lock on every change. Also subscribes to QueryCache events so a
// pinned-relevant query is locked the moment it appears, regardless of
// whether the cache write came from a local prefetch, a cross-tab
// queryCacheSync broadcast, or a fresh comment batch on an already-pinned
// thread. Cheap: lookups are O(1), comment-ancestry walks are O(depth).
export function startPinnedQueryRetention(client: QueryClient): () => void {
  const unsubscribeCache = subscribeToPinnedCacheLocking(client);
  if (typeof window === 'undefined') {
    return unsubscribeCache;
  }
  const onChange = () => lockAllPinnedQueriesGcTime(client);
  window.addEventListener(PINNED_STORIES_CHANGE_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(PINNED_STORIES_CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onChange);
    unsubscribeCache();
  };
}
