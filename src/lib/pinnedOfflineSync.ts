import type { QueryClient } from '@tanstack/react-query';
import type { ItemRoot } from '../hooks/useItemTree';
import {
  commentsSummaryQueryKey,
  commentsSummaryQueryOptions,
} from '../hooks/useCommentsSummary';
import {
  SUMMARY_RETENTION_MS,
  summaryQueryKey,
  summaryQueryOptions,
} from '../hooks/useSummary';
import { COMMENT_BATCH_LIMIT, prefetchCommentBatch } from './commentPrefetch';
import { getItems, type HNItem } from './hn';
import {
  getOnline,
  isRetryableFetchError,
  subscribeOnline,
} from './networkStatus';
import {
  PINNED_STORIES_CHANGE_EVENT,
  PINNED_STORIES_STORAGE_KEY,
  getPinnedEntries,
} from './pinnedStories';
import { hasSelfPostBody } from './selfPostBody';

export const PINNED_SYNC_STALE_MS = 6 * 60 * 60 * 1000;
export const PINNED_SYNC_MAX_STORIES = 30;

const attemptedAtById = new Map<number, number>();

// What a pinned story still needs before it's fully readable offline.
// 'root' also implies re-checking summaries and comments once the fresh
// item is in hand; 'fill' means the root is fresh and only a summary
// (article and/or comments) or part of the first comment page has never
// been cached — the cross-device case (the pin arrived via cloud sync
// but the content was only ever downloaded on the device that pinned)
// or the aftermath of a best-effort pin-time comment batch that failed
// silently.
type SyncNeed = 'skip' | 'root' | 'fill';

// The first page of top-level comments a pinned story promises offline
// (SPEC § Pin/Favorite offline prefetch), minus what's already cached.
// prefetchCommentBatch deliberately re-fetches everything it's given
// (staleTime 0, so edits surface), so the filtering to only-missing ids
// has to happen here — the fill path is a top-up, not a refresh.
function missingFirstPageCommentIds(
  client: QueryClient,
  kidIds: readonly number[],
): number[] {
  return kidIds
    .slice(0, COMMENT_BATCH_LIMIT)
    .filter((id) => client.getQueryData(['comment', id]) === undefined);
}

function summariesMissing(
  client: QueryClient,
  item: HNItem,
  kidIds: readonly number[],
): boolean {
  const articleApplicable = !!item.url || hasSelfPostBody(item.text);
  if (
    articleApplicable &&
    client.getQueryData(summaryQueryKey(item.id)) === undefined
  ) {
    return true;
  }
  const commentsApplicable = kidIds.length > 0 || (item.descendants ?? 0) > 0;
  return (
    commentsApplicable &&
    client.getQueryData(commentsSummaryQueryKey(item.id)) === undefined
  );
}

// prefetchQuery swallows errors, so failure kind is recovered from the
// query's post-settle state: resolves true when the fetch died on a
// statusless network blip (retry-worthy), false on success or on an
// HTTP-status failure (a 4xx won't change; a 5xx shouldn't be re-asked
// on every trigger).
async function prefetchSummaryQuery(
  client: QueryClient,
  options: Parameters<QueryClient['prefetchQuery']>[0],
): Promise<boolean> {
  await client.prefetchQuery(options);
  const query = client
    .getQueryCache()
    .find({ queryKey: options.queryKey, exact: true });
  return isRetryableFetchError(query?.state.error ?? undefined);
}

// Fire prefetches for whichever summaries this story is missing. Only
// ever fetches a summary that has *never* been cached — freshness of an
// existing summary is owned by the warm-summaries cron plus the normal
// thread-open refetch, so the sync path can't turn into a periodic
// re-generation loop. gcTime locking to Infinity for pinned ids happens
// automatically via subscribeToPinnedCacheLocking when the query lands.
// Resolves true when any fired prefetch failed on a network blip — the
// caller clears the story's attempt mark so the next trigger retries,
// mirroring the root batch's clear-on-blip rule.
async function prefetchMissingSummaries(
  client: QueryClient,
  item: HNItem,
  kidIds: readonly number[],
): Promise<boolean> {
  if (item.dead || item.deleted) return false;
  const prefetches: Array<Promise<boolean>> = [];
  if (
    (!!item.url || hasSelfPostBody(item.text)) &&
    client.getQueryData(summaryQueryKey(item.id)) === undefined
  ) {
    prefetches.push(prefetchSummaryQuery(client, summaryQueryOptions(item.id)));
  }
  if (
    (kidIds.length > 0 || (item.descendants ?? 0) > 0) &&
    client.getQueryData(commentsSummaryQueryKey(item.id)) === undefined
  ) {
    prefetches.push(
      prefetchSummaryQuery(client, commentsSummaryQueryOptions(item.id)),
    );
  }
  return (await Promise.all(prefetches)).some(Boolean);
}

// Fire-and-forget wrapper for the callers: clear the story's attempt
// mark when a summary prefetch died on a network blip, so the next
// trigger (reconnect, focus, change event) rechecks summariesMissing
// instead of waiting out the 6 h throttle.
function prefetchMissingSummariesAndUnthrottleOnBlip(
  client: QueryClient,
  item: HNItem,
  kidIds: readonly number[],
): void {
  void prefetchMissingSummaries(client, item, kidIds).then((blipped) => {
    if (blipped) attemptedAtById.delete(item.id);
  });
}

function storySyncNeed(
  client: QueryClient,
  id: number,
  now: number,
): SyncNeed {
  const attemptedAt = attemptedAtById.get(id) ?? 0;
  if (attemptedAt > 0 && now - attemptedAt < PINNED_SYNC_STALE_MS) {
    return 'skip';
  }
  const state = client.getQueryState(['itemRoot', id]);
  // A pin made on this device fires prefetchPinnedStory (the full warm,
  // summaries included) and *then* the change event that re-enters this
  // module — skip while that fetch is in flight instead of double-
  // fetching the same root.
  if (state?.fetchStatus === 'fetching') return 'skip';
  const updatedAt = state?.dataUpdatedAt ?? 0;
  if (updatedAt === 0 || now - updatedAt >= PINNED_SYNC_STALE_MS) {
    return 'root';
  }
  const root = client.getQueryData<ItemRoot | null>(['itemRoot', id]);
  if (!root) return 'skip'; // fetched recently, item gone upstream
  if (root.item.dead || root.item.deleted) return 'skip';
  return summariesMissing(client, root.item, root.kidIds) ||
    missingFirstPageCommentIds(client, root.kidIds).length > 0
    ? 'fill'
    : 'skip';
}

// Run a comment batch through a blip-tracking fetcher: on a statusless
// network failure, clear the contributing stories' attempt marks so the
// next trigger retries the (still-missing) comments — the same recovery
// rule as the root batch and the summary prefetches. The wrapper exists
// because prefetchCommentBatch deliberately swallows failures for its
// other callers; HTTP-status failures still keep the 6 h throttle. Used
// by both the root-refresh path and the fill-path top-up.
function prefetchCommentsAndUnthrottleOnBlip(
  client: QueryClient,
  commentIds: readonly number[],
  storyIds: readonly number[],
): Promise<void> {
  if (commentIds.length === 0) return Promise.resolve();
  let blipped = false;
  const blipTrackingGetItems: typeof getItems = async (ids, signal, options) => {
    try {
      return await getItems(ids, signal, options);
    } catch (error) {
      if (isRetryableFetchError(error)) blipped = true;
      throw error;
    }
  };
  return prefetchCommentBatch(client, [...commentIds], blipTrackingGetItems).then(
    () => {
      if (blipped) {
        for (const id of storyIds) attemptedAtById.delete(id);
      }
    },
  );
}

async function syncPinnedRootBatch(
  client: QueryClient,
  ids: readonly number[],
): Promise<void> {
  let items: Array<HNItem | null>;
  try {
    items = await getItems([...ids], undefined, { fields: 'full' });
  } catch (error) {
    // A statusless network blip (thrown fetch, read-cap timeout) means
    // nothing arrived — clear the attempt marks so the next trigger
    // (reconnect, change event, next home view) retries instead of
    // waiting out the 6 h window. A response that carried an HTTP
    // status (or an unparsable body) keeps the marks: a 4xx won't
    // change on retry, and re-asking a 5xx on every sync pull would
    // hammer a backend that just said it's struggling — same rule as
    // the app-wide retry default in main.tsx.
    if (isRetryableFetchError(error)) {
      for (const id of ids) attemptedAtById.delete(id);
    }
    return;
  }

  const rootWrites: Array<Promise<void>> = [];
  const commentIds: number[] = [];
  const commentStoryIds: number[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    const item = items[i];
    if (!item) continue;
    const kidIds = item.deleted || item.dead ? [] : (item.kids ?? []);
    const resolved = { item, kidIds };
    rootWrites.push(
      client.prefetchQuery({
        queryKey: ['itemRoot', ids[i]],
        queryFn: () => resolved,
        staleTime: 0,
        gcTime: SUMMARY_RETENTION_MS,
      }),
    );
    let contributed = false;
    for (const kidId of kidIds) {
      if (commentIds.length >= COMMENT_BATCH_LIMIT) break;
      commentIds.push(kidId);
      contributed = true;
    }
    if (contributed) commentStoryIds.push(ids[i]);
    // A blip-cleared mark here is safe even though the root batch
    // succeeded: the next trigger sees the now-fresh root and takes the
    // fill path, so nothing is double-fetched.
    prefetchMissingSummariesAndUnthrottleOnBlip(client, item, kidIds);
  }
  await Promise.all(rootWrites);
  // Same blip rule as the fill path: the roots landed, but if the
  // comment batch dies on a network blip the story is still missing its
  // promised first page — clear the contributing marks so the next
  // trigger's fill path retries just the absent comments.
  await prefetchCommentsAndUnthrottleOnBlip(client, commentIds, commentStoryIds);
}

// Make every pinned story fully readable offline — item root, the first
// page of top-level comments, and both AI summaries — without waiting
// for the reader to open it. Runs at foreground network moments (app
// boot after rehydrate, home view, window focus) and whenever the pinned
// set changes, which is exactly when a pin made on *another* device
// lands here via cloud sync. Cost is capped at one /api/items batch for
// the newest pins, one capped comments batch, and per-story summary
// fetches only for summaries that have never been cached; failures are
// fail-open and leave the previous cache intact.
export function syncPinnedStoriesForOffline(
  client: QueryClient,
  now: number = Date.now(),
): void {
  if (!getOnline()) return;
  const rootIds: number[] = [];
  const fillRoots: ItemRoot[] = [];
  for (const entry of getPinnedEntries().sort((a, b) => b.at - a.at)) {
    if (rootIds.length + fillRoots.length >= PINNED_SYNC_MAX_STORIES) break;
    const need = storySyncNeed(client, entry.id, now);
    if (need === 'skip') continue;
    attemptedAtById.set(entry.id, now);
    if (need === 'root') {
      rootIds.push(entry.id);
    } else {
      const root = client.getQueryData<ItemRoot | null>(['itemRoot', entry.id]);
      if (root) fillRoots.push(root);
    }
  }
  for (const root of fillRoots) {
    prefetchMissingSummariesAndUnthrottleOnBlip(client, root.item, root.kidIds);
  }
  topUpFillComments(client, fillRoots);
  if (rootIds.length > 0) void syncPinnedRootBatch(client, rootIds);
}

// Top up the fill-path stories' absent first-page comments in ONE
// aggregated batch, capped at COMMENT_BATCH_LIMIT ids across all
// stories — the same one-capped-comment-batch-per-run cost bound the
// root path keeps, so a boot after rehydrate with many partially-cached
// pins can't burst a batch per story. Ids past the cap simply wait for
// a later run (post-throttle), matching the root path's tail behavior.
// Blip recovery rides prefetchCommentsAndUnthrottleOnBlip like the root
// path's batch.
function topUpFillComments(
  client: QueryClient,
  fillRoots: readonly ItemRoot[],
): void {
  const commentIds: number[] = [];
  const storyIds: number[] = [];
  for (const root of fillRoots) {
    if (commentIds.length >= COMMENT_BATCH_LIMIT) break;
    const missing = missingFirstPageCommentIds(client, root.kidIds);
    if (missing.length === 0) continue;
    let contributed = false;
    for (const id of missing) {
      if (commentIds.length >= COMMENT_BATCH_LIMIT) break;
      commentIds.push(id);
      contributed = true;
    }
    if (contributed) storyIds.push(root.item.id);
  }
  void prefetchCommentsAndUnthrottleOnBlip(client, commentIds, storyIds);
}

// Wire the sync to the moments that can create download work outside a
// home view: the pinned set changing — same-tab via the custom event (a
// local pin/unpin, or cloud sync pulling a pin made on another device)
// and cross-tab via the key-filtered `storage` event (a pin made in
// another open tab) — connectivity coming back (a pin made while
// offline gets its download the moment the tracker flips online,
// because the offline early-return above never marked it attempted),
// and window focus — the reader can park the tab on a thread or
// /pinned page past the 6 h staleness window, and without a global
// focus trigger nothing would refresh until they visited a feed. The
// per-story attempt throttle absorbs overlap with the home view's own
// sync moments. Returns an unsubscribe for symmetry with the other
// main.tsx starters; the app never calls it.
export function startPinnedOfflineSync(client: QueryClient): () => void {
  if (typeof window === 'undefined') return () => {};
  const run = () => syncPinnedStoriesForOffline(client);
  // The pin-change trigger is deferred by one macrotask: local pin
  // handlers call pin(id) — which dispatches the change event
  // synchronously — and only then fire prefetchPinnedStory, so a sync
  // run inside the event dispatch would start its own root warm before
  // the pin-time prefetch exists for storySyncNeed's fetchStatus guard
  // to see, double-fetching every local pin. One tick later the
  // pin-time root fetch is in flight and the guard skips it. Remote
  // arrivals (cloud sync) don't care about the extra tick, and bursts
  // of change events (a Sweep, a sync pull) coalesce into one run.
  let pinChangeTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRun = () => {
    if (pinChangeTimer !== null) return;
    pinChangeTimer = setTimeout(() => {
      pinChangeTimer = null;
      run();
    }, 0);
  };
  window.addEventListener(PINNED_STORIES_CHANGE_EVENT, scheduleRun);
  // Cross-tab pins arrive as `storage` events (the custom event only
  // fires in the tab that wrote). queryCacheSync usually delivers the
  // originating tab's warmed data, but when it can't (BroadcastChannel
  // unavailable, or that tab's warm failed) this tab must download for
  // itself — otherwise the pin sits here undownloaded until focus or
  // reconnect, which may come after connectivity is gone. Key-filtered
  // so unrelated cross-tab localStorage writes don't run the sync; a
  // null key is storage.clear(), which also changes the pinned set.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== PINNED_STORIES_STORAGE_KEY) return;
    scheduleRun();
  };
  window.addEventListener('storage', onStorage);
  // Focus runs directly (not deferred) — unlike a pin click, regaining
  // focus can't race a same-tick pin-time warm.
  window.addEventListener('focus', run);
  const unsubscribeOnline = subscribeOnline(() => {
    if (getOnline()) run();
  });
  return () => {
    window.removeEventListener(PINNED_STORIES_CHANGE_EVENT, scheduleRun);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('focus', run);
    if (pinChangeTimer !== null) {
      clearTimeout(pinChangeTimer);
      pinChangeTimer = null;
    }
    unsubscribeOnline();
  };
}

export function _resetPinnedOfflineSyncForTests(): void {
  attemptedAtById.clear();
}
