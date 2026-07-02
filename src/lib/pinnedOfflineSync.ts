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
  // An invalidated root is prefetchPinnedStory's seed-from-feed-row
  // marker: setQueryData stamps a fresh dataUpdatedAt, the seed is
  // immediately invalidated, and only a successful full-item fetch
  // clears the flag. If that fetch failed (a pin made while offline),
  // the seed sits fresh-but-thin — kidIds [] from the stripped feed
  // payload — so the timestamp check alone would take the fill path
  // and never download the promised first-page comments until the 6 h
  // window expired.
  if (state?.isInvalidated) return 'root';
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

// One contributing story's slice of the shared comment batch: which
// comment ids the batch is expected to cache for it.
interface CommentTopUpEntry {
  storyId: number;
  commentIds: number[];
}

// Run a comment batch through a tracking fetcher and clear attempt
// marks per failure kind once it settles:
//   - statusless network blip (thrown fetch/timeout) → clear every
//     contributing story, same recovery rule as the root batch and the
//     summary prefetches;
//   - the batch resolved, but some requested ids came back as `null`
//     slots (/api/items reports partial upstream failure as HTTP 200
//     with nulls, and prefetchCommentBatch skips them) → clear only the
//     stories whose requested ids are still uncached, so a transient
//     partial failure doesn't sit out the 6 h throttle. Genuinely
//     scrubbed items also stay null forever, but those are rare
//     (deleted/dead comments still return cacheable items) and each
//     retry is one small, usually edge-cached call;
//   - an HTTP-status failure (thrown non-blip) keeps every mark — a
//     4xx won't change and re-asking a 5xx on every trigger would
//     hammer a struggling backend.
// The wrapper exists because prefetchCommentBatch deliberately swallows
// failures for its other callers. Used by both the root-refresh path
// and the fill-path top-up.
function prefetchCommentsAndUnthrottleOnBlip(
  client: QueryClient,
  entries: readonly CommentTopUpEntry[],
  // Stories whose missing comments didn't (fully) fit the 30-id cap.
  // Their attempt marks are cleared once the batch settles — the cap's
  // "wait for a later run" tail must be reachable by the next trigger,
  // not throttled out for 6 h (a starved cross-device pin would
  // otherwise sit with a fresh root and no offline comments). Cleared
  // post-settle rather than immediately so a burst of triggers can't
  // stack concurrent comment batches; each successful batch caches ≥1
  // of a story's missing comments, so repeated runs converge.
  overflowStoryIds: readonly number[] = [],
): Promise<void> {
  const commentIds = entries.flatMap((entry) => entry.commentIds);
  if (commentIds.length === 0) {
    // Nothing to fetch, so nothing can stack — clear overflow stories
    // (e.g. a null root slot with no kids to batch) immediately.
    for (const id of overflowStoryIds) attemptedAtById.delete(id);
    return Promise.resolve();
  }
  let blipped = false;
  let resolved = false;
  const trackingGetItems: typeof getItems = async (ids, signal, options) => {
    try {
      const items = await getItems(ids, signal, options);
      resolved = true;
      return items;
    } catch (error) {
      if (isRetryableFetchError(error)) blipped = true;
      throw error;
    }
  };
  return prefetchCommentBatch(client, commentIds, trackingGetItems).then(() => {
    if (blipped) {
      for (const entry of entries) attemptedAtById.delete(entry.storyId);
    } else if (resolved) {
      for (const entry of entries) {
        const stillMissing = entry.commentIds.some(
          (id) => client.getQueryData(['comment', id]) === undefined,
        );
        if (stillMissing) attemptedAtById.delete(entry.storyId);
      }
    }
    for (const id of overflowStoryIds) attemptedAtById.delete(id);
  });
}

// The fill-path stories' absent first-page comment ids, aggregated and
// capped at COMMENT_BATCH_LIMIT across all stories, as per-story
// entries (for blip/partial-failure mark clearing) plus the stories
// whose ids overflowed the cap (un-throttled post-settle so the next
// trigger picks up the tail).
interface CommentTopUp {
  entries: CommentTopUpEntry[];
  overflowStoryIds: number[];
}

async function syncPinnedRootBatch(
  client: QueryClient,
  ids: readonly number[],
  fillTopUp: CommentTopUp,
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
      // The merged comment top-up below never fired either — the fill
      // stories' missing comments are still missing, so let them retry
      // on the next trigger too.
      for (const entry of fillTopUp.entries) {
        attemptedAtById.delete(entry.storyId);
      }
      for (const id of fillTopUp.overflowStoryIds) attemptedAtById.delete(id);
    }
    return;
  }

  const rootWrites: Array<Promise<void>> = [];
  // One comment batch per sync run: the fill-path top-up ids ride the
  // same capped batch as the refreshed roots' first pages, sharing the
  // 30-id ceiling, instead of issuing a second /api/items call.
  const entries: CommentTopUpEntry[] = [...fillTopUp.entries];
  const overflowStoryIds: number[] = [...fillTopUp.overflowStoryIds];
  let batchSize = entries.reduce((n, entry) => n + entry.commentIds.length, 0);
  for (let i = 0; i < ids.length; i += 1) {
    const item = items[i];
    if (!item) {
      // /api/items reports a partial upstream failure as a null slot in
      // an otherwise-successful 200 — the root never arrived, so the
      // mark must not sit out the 6 h window. Rides the overflow list's
      // post-settle clearing (same anti-stacking rationale). Genuinely
      // scrubbed pinned stories also stay null, but a scrubbed story's
      // retry is one small, usually edge-cached slot in the next
      // trigger's batch.
      overflowStoryIds.push(ids[i]);
      continue;
    }
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
    const included: number[] = [];
    let truncated = false;
    for (const kidId of kidIds.slice(0, COMMENT_BATCH_LIMIT)) {
      if (batchSize >= COMMENT_BATCH_LIMIT) {
        truncated = true;
        break;
      }
      included.push(kidId);
      batchSize += 1;
    }
    if (included.length > 0) {
      entries.push({ storyId: ids[i], commentIds: included });
    }
    // A refreshed root whose first-page kids didn't (fully) fit the cap
    // must not sit throttled for 6 h with no offline comments — clear
    // its mark post-settle so the next trigger's fill path tops it up.
    if (truncated) overflowStoryIds.push(ids[i]);
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
  await prefetchCommentsAndUnthrottleOnBlip(client, entries, overflowStoryIds);
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
  // ONE capped comment batch per run, whatever the mix: fill-only runs
  // fire it directly; when roots also need refreshing, the fill ids are
  // merged into the root batch's comment batch (which must wait for the
  // root items anyway) so a mixed run can't double the /api/items calls.
  const fillTopUp = collectFillCommentTopUp(client, fillRoots);
  if (rootIds.length > 0) {
    void syncPinnedRootBatch(client, rootIds, fillTopUp);
  } else {
    void prefetchCommentsAndUnthrottleOnBlip(
      client,
      fillTopUp.entries,
      fillTopUp.overflowStoryIds,
    );
  }
}

// Gather the fill-path stories' absent first-page comment ids into one
// capped aggregate — a boot after rehydrate with many partially-cached
// pins can't burst a batch per story. Blip recovery rides
// prefetchCommentsAndUnthrottleOnBlip like the root path's batch.
function collectFillCommentTopUp(
  client: QueryClient,
  fillRoots: readonly ItemRoot[],
): CommentTopUp {
  const entries: CommentTopUpEntry[] = [];
  const overflowStoryIds: number[] = [];
  let batchSize = 0;
  for (const root of fillRoots) {
    const missing = missingFirstPageCommentIds(client, root.kidIds);
    if (missing.length === 0) continue;
    const included: number[] = [];
    let truncated = false;
    for (const id of missing) {
      if (batchSize >= COMMENT_BATCH_LIMIT) {
        truncated = true;
        break;
      }
      included.push(id);
      batchSize += 1;
    }
    if (included.length > 0) {
      entries.push({ storyId: root.item.id, commentIds: included });
    }
    // A story whose missing comments didn't (fully) fit the cap is
    // un-throttled post-settle so the next trigger's batch picks up
    // the tail instead of waiting out the 6 h window.
    if (truncated) overflowStoryIds.push(root.item.id);
  }
  return { entries, overflowStoryIds };
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
