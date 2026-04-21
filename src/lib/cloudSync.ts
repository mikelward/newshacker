// Cross-device sync glue. Pulls Pinned / Favorite / Ignored from
// /api/sync on login and reconnect, listens to the three change
// events, and debounces local changes into a single POST ~2 s later.
// Merge is per-id last-write-wins, matching the server.
//
// Fail-open: any error (server down, offline, 5xx) is swallowed and
// retried on the next event or reconnect. Local storage remains the
// source of truth for the UI; /api/sync is purely additive.

import { trackedFetch, subscribeOnline } from './networkStatus';
import {
  PINNED_STORIES_CHANGE_EVENT,
  getAllPinnedEntries,
  replacePinnedEntries,
  type PinnedEntry,
} from './pinnedStories';
import {
  FAVORITES_CHANGE_EVENT,
  getAllFavoriteEntries,
  replaceFavoriteEntries,
  type FavoriteEntry,
} from './favorites';
import {
  DISMISSED_STORIES_CHANGE_EVENT,
  getAllDismissedEntries,
  replaceDismissedEntries,
  type DismissedEntry,
} from './dismissedStories';

export const SYNC_DEBOUNCE_MS = 2000;

export interface SyncEntry {
  id: number;
  at: number;
  deleted?: true;
}

export interface SyncState {
  pinned: SyncEntry[];
  favorite: SyncEntry[];
  ignored: SyncEntry[];
}

type ListName = 'pinned' | 'favorite' | 'ignored';

export function mergeEntries(
  current: SyncEntry[],
  incoming: SyncEntry[],
): SyncEntry[] {
  const byId = new Map<number, SyncEntry>();
  for (const e of current) byId.set(e.id, e);
  for (const e of incoming) {
    const existing = byId.get(e.id);
    if (!existing || e.at > existing.at) byId.set(e.id, e);
  }
  return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}

function maxAt(entries: SyncEntry[]): number {
  let m = 0;
  for (const e of entries) if (e.at > m) m = e.at;
  return m;
}

// Module-level singleton. There's exactly one signed-in user per
// browsing session and one set of localStorage stores, so there's no
// reason to instantiate this per-component.
interface SyncRuntime {
  username: string;
  lastPushed: Record<ListName, number>;
  pushTimer: ReturnType<typeof setTimeout> | null;
  pushInFlight: boolean;
  pushQueued: boolean;
  unsubscribeOnline: (() => void) | null;
  onChange: () => void;
  fetchImpl: typeof fetch;
  debounceMs: number;
}

let runtime: SyncRuntime | null = null;

function asEntries(list: SyncEntry[]): SyncEntry[] {
  return list.map((e) => {
    const out: SyncEntry = { id: e.id, at: e.at };
    if (e.deleted) out.deleted = true;
    return out;
  });
}

function readLocal(list: ListName): SyncEntry[] {
  switch (list) {
    case 'pinned':
      return asEntries(getAllPinnedEntries());
    case 'favorite':
      return asEntries(getAllFavoriteEntries());
    case 'ignored':
      return asEntries(getAllDismissedEntries());
  }
}

function writeLocal(list: ListName, entries: SyncEntry[]): void {
  switch (list) {
    case 'pinned':
      replacePinnedEntries(entries as PinnedEntry[]);
      return;
    case 'favorite':
      replaceFavoriteEntries(entries as FavoriteEntry[]);
      return;
    case 'ignored':
      replaceDismissedEntries(entries as DismissedEntry[]);
      return;
  }
}

function applyServerState(state: SyncState): void {
  if (!runtime) return;
  const lists: ListName[] = ['pinned', 'favorite', 'ignored'];
  for (const list of lists) {
    const merged = mergeEntries(readLocal(list), state[list]);
    writeLocal(list, merged);
    runtime.lastPushed[list] = Math.max(
      runtime.lastPushed[list],
      maxAt(state[list]),
    );
  }
}

function collectDelta(): SyncState {
  if (!runtime) return { pinned: [], favorite: [], ignored: [] };
  return {
    pinned: readLocal('pinned').filter(
      (e) => e.at > runtime!.lastPushed.pinned,
    ),
    favorite: readLocal('favorite').filter(
      (e) => e.at > runtime!.lastPushed.favorite,
    ),
    ignored: readLocal('ignored').filter(
      (e) => e.at > runtime!.lastPushed.ignored,
    ),
  };
}

async function pull(): Promise<void> {
  if (!runtime) return;
  let res: Response;
  try {
    res = await runtime.fetchImpl('/api/sync', { method: 'GET' });
  } catch {
    return; // offline / transient; retry on reconnect.
  }
  if (!res.ok) return;
  let server: unknown;
  try {
    server = await res.json();
  } catch {
    return;
  }
  if (!isSyncState(server)) return;
  applyServerState(server);
}

async function push(): Promise<void> {
  if (!runtime) return;
  const delta = collectDelta();
  const total =
    delta.pinned.length + delta.favorite.length + delta.ignored.length;
  if (total === 0) return;

  const deltaMax = {
    pinned: maxAt(delta.pinned),
    favorite: maxAt(delta.favorite),
    ignored: maxAt(delta.ignored),
  };

  let res: Response;
  try {
    res = await runtime.fetchImpl('/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(delta),
    });
  } catch {
    return; // fail-open: a subsequent change event will retry.
  }
  if (!res.ok) return;

  let server: unknown;
  try {
    server = await res.json();
  } catch {
    return;
  }
  if (!isSyncState(server)) return;

  // Raise the high-water mark for everything we just successfully
  // pushed, BEFORE applying the server response. If we bumped only
  // after applyServerState, a concurrent change event firing between
  // the two calls could trigger a schedulePush that re-sends the same
  // delta. Bumping first makes collectDelta correctly skip entries
  // that are already on the server.
  runtime.lastPushed.pinned = Math.max(
    runtime.lastPushed.pinned,
    deltaMax.pinned,
  );
  runtime.lastPushed.favorite = Math.max(
    runtime.lastPushed.favorite,
    deltaMax.favorite,
  );
  runtime.lastPushed.ignored = Math.max(
    runtime.lastPushed.ignored,
    deltaMax.ignored,
  );

  applyServerState(server);
}

function isSyncState(x: unknown): x is SyncState {
  if (typeof x !== 'object' || x === null) return false;
  const obj = x as Record<string, unknown>;
  return (
    Array.isArray(obj.pinned) &&
    Array.isArray(obj.favorite) &&
    Array.isArray(obj.ignored)
  );
}

function schedulePush(delayOverride?: number): void {
  if (!runtime) return;
  if (runtime.pushTimer) return;
  const delay = delayOverride ?? runtime.debounceMs;
  runtime.pushTimer = setTimeout(() => {
    if (!runtime) return;
    runtime.pushTimer = null;
    void runPush();
  }, delay);
}

async function runPush(): Promise<void> {
  if (!runtime) return;
  if (runtime.pushInFlight) {
    runtime.pushQueued = true;
    return;
  }
  runtime.pushInFlight = true;
  try {
    await push();
  } finally {
    if (runtime) {
      runtime.pushInFlight = false;
      if (runtime.pushQueued) {
        runtime.pushQueued = false;
        schedulePush(0);
      }
    }
  }
}

export interface StartOptions {
  fetchImpl?: typeof fetch;
  // Debounce window before a POST fires after a local change event.
  // Tests override this to 0 so they don't need fake timers; default
  // is the production 2-second debounce.
  debounceMs?: number;
}

export async function startCloudSync(
  username: string,
  opts: StartOptions = {},
): Promise<void> {
  if (runtime && runtime.username === username) return;
  stopCloudSync();

  const fetchImpl = opts.fetchImpl ?? trackedFetch;
  const onChange = () => schedulePush();

  runtime = {
    username,
    lastPushed: { pinned: 0, favorite: 0, ignored: 0 },
    pushTimer: null,
    pushInFlight: false,
    pushQueued: false,
    unsubscribeOnline: null,
    onChange,
    fetchImpl,
    debounceMs: opts.debounceMs ?? SYNC_DEBOUNCE_MS,
  };

  window.addEventListener(PINNED_STORIES_CHANGE_EVENT, onChange);
  window.addEventListener(FAVORITES_CHANGE_EVENT, onChange);
  window.addEventListener(DISMISSED_STORIES_CHANGE_EVENT, onChange);

  runtime.unsubscribeOnline = subscribeOnline((online) => {
    if (!online) return;
    // Re-pull on reconnect and flush any deltas accumulated offline.
    void pull().then(() => schedulePush(0));
  });

  await pull();
  // After pull, push any local changes that the server didn't already
  // know about. Uses delay=0 rather than the debounce so a fresh
  // login doesn't sit idle for 2 s before flushing.
  schedulePush(0);
}

export function stopCloudSync(): void {
  if (!runtime) return;
  const r = runtime;
  runtime = null;
  window.removeEventListener(PINNED_STORIES_CHANGE_EVENT, r.onChange);
  window.removeEventListener(FAVORITES_CHANGE_EVENT, r.onChange);
  window.removeEventListener(DISMISSED_STORIES_CHANGE_EVENT, r.onChange);
  if (r.pushTimer) clearTimeout(r.pushTimer);
  r.unsubscribeOnline?.();
}

// Test-only peek at the singleton so tests can assert on internal
// state transitions without exporting every mutable field.
export function _getCloudSyncRuntimeForTests(): Readonly<SyncRuntime> | null {
  return runtime;
}

// Test-only: yield microtasks so pending promise chains (pull/push
// handlers) settle. Does NOT advance timers — tests must drive the
// debounce with vi.advanceTimersByTimeAsync themselves. A generous
// fixed budget of microtask yields is plenty for the 2–3 awaits our
// push/pull chains do.
export async function _flushCloudSyncForTests(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}
