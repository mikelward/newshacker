import type { QueryCacheNotifyEvent, QueryClient, QueryKey } from '@tanstack/react-query';

// Cross-tab bridge for the React Query cache.
//
// Two tabs of the same origin each have their own in-memory QueryClient
// (separate JS heaps). localStorage is shared, but the persister only
// reads it once at mount and writes it on a throttle — so a pin in tab
// A populates tab A's cache without reaching tab B's live cache. The
// resulting drift means tab B pays again on tap for work tab A already
// did (the item root, top-level comments, and both Gemini summaries).
//
// BroadcastChannel is a same-origin event bus between tabs. We subscribe
// to the query cache, post {queryKey, data, dataUpdatedAt} for an allow
// list of keys, and let receiving tabs apply the write via setQueryData.
// The channel carries only the changed entry — no full-blob serialize,
// no throttle — so it's decoupled from the persister's 1s rhythm.
//
// Fallback: if BroadcastChannel is missing (old Safari), start is a
// no-op and tabs run with today's drift. No new failure mode.

export const CHANNEL_NAME = 'newshacker:rq';

// Keys worth syncing — the expensive ones a pin/favorite warms. Feed
// lists (`storyIds`, `feedItems`) are skipped because each tab already
// refetches them on mount; that's the per-feed freshness story.
const SYNCED_ROOT_KEYS = new Set<string>([
  'itemRoot',
  'summary',
  'comments-summary',
  'comment',
]);

function isSyncedKey(key: QueryKey): boolean {
  return (
    Array.isArray(key) &&
    typeof key[0] === 'string' &&
    SYNCED_ROOT_KEYS.has(key[0] as string)
  );
}

interface SyncMessage {
  type: 'query-updated';
  queryKey: QueryKey;
  data: unknown;
  dataUpdatedAt: number;
}

function isSyncMessage(value: unknown): value is SyncMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<SyncMessage>;
  return (
    v.type === 'query-updated' &&
    Array.isArray(v.queryKey) &&
    typeof v.dataUpdatedAt === 'number'
  );
}

type BroadcastChannelLike = Pick<
  BroadcastChannel,
  'postMessage' | 'close'
> & {
  onmessage: ((ev: MessageEvent) => void) | null;
};

interface SyncDeps {
  // Lets tests inject a pair of paired channels without a real
  // BroadcastChannel implementation.
  channelFactory?: (name: string) => BroadcastChannelLike;
}

// Broadcast only on terminal success-with-data events. 'added' fires
// when the persister hydrates on boot — we don't want every tab's
// restore to re-announce yesterday's cache to its siblings. 'removed'
// and error states don't carry data we can ship.
function shouldBroadcast(event: QueryCacheNotifyEvent): boolean {
  if (event.type !== 'updated') return false;
  const action = event.action;
  if (action.type !== 'success') return false;
  const state = event.query.state;
  return state.status === 'success' && state.data !== undefined;
}

export function startQueryCacheSync(
  client: QueryClient,
  deps: SyncDeps = {},
): () => void {
  const factory =
    deps.channelFactory ??
    (typeof BroadcastChannel !== 'undefined'
      ? (name: string) => new BroadcastChannel(name)
      : null);
  if (!factory) return () => {};

  const channel = factory(CHANNEL_NAME);

  // Guard against the echo loop: a remote message lands, we call
  // setQueryData, the cache fires a 'success' event synchronously, our
  // subscriber runs — and without this set it would rebroadcast. The
  // set is keyed by a stringified queryKey and cleared on a microtask
  // so real local mutations after the apply still broadcast normally.
  const applying = new Set<string>();
  const keyId = (key: QueryKey) => JSON.stringify(key);

  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (!shouldBroadcast(event)) return;
    const query = event.query;
    if (!isSyncedKey(query.queryKey)) return;
    const id = keyId(query.queryKey);
    if (applying.has(id)) return;
    const msg: SyncMessage = {
      type: 'query-updated',
      queryKey: query.queryKey,
      data: query.state.data,
      dataUpdatedAt: query.state.dataUpdatedAt,
    };
    try {
      channel.postMessage(msg);
    } catch {
      // DataCloneError (non-cloneable payload) or channel-closed races
      // shouldn't break local-only flows. Swallow — next successful
      // write will carry fresh data anyway.
    }
  });

  channel.onmessage = (ev: MessageEvent) => {
    const msg = ev.data;
    if (!isSyncMessage(msg)) return;
    if (!isSyncedKey(msg.queryKey)) return;
    const existing = client.getQueryState(msg.queryKey);
    // Last-write-wins by dataUpdatedAt. If we already have newer data
    // (rare — overlapping fetches resolving out of order), don't stomp.
    if (existing && existing.dataUpdatedAt >= msg.dataUpdatedAt) return;
    const id = keyId(msg.queryKey);
    applying.add(id);
    try {
      client.setQueryData(msg.queryKey, msg.data, {
        updatedAt: msg.dataUpdatedAt,
      });
    } finally {
      queueMicrotask(() => applying.delete(id));
    }
  };

  return () => {
    unsubscribe();
    channel.onmessage = null;
    channel.close();
  };
}
