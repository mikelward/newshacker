// Cross-device sync glue. Pulls Pinned / Favorite / Hidden / Done from
// /api/sync on login, reconnect, and tab-visibility change, listens to
// the four change events, and debounces local changes into a single
// POST ~2 s later. Merge is per-id last-write-wins, matching the server.
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
  HIDDEN_STORIES_CHANGE_EVENT,
  getAllHiddenEntries,
  replaceHiddenEntries,
  type HiddenEntry,
} from './hiddenStories';
import {
  DONE_STORIES_CHANGE_EVENT,
  getAllDoneEntries,
  replaceDoneEntries,
  type DoneEntry,
} from './doneStories';

export const SYNC_DEBOUNCE_MS = 2000;
// Visibility-triggered pulls are gated: tab-switching shouldn't hammer
// /api/sync. One pull per minute of visibility change is plenty for
// the "I switched to this tab, show me the latest" case.
const VISIBILITY_PULL_MIN_INTERVAL_MS = 30_000;

export interface SyncEntry {
  id: number;
  at: number;
  deleted?: true;
}

export interface SyncState {
  pinned: SyncEntry[];
  favorite: SyncEntry[];
  hidden: SyncEntry[];
  done: SyncEntry[];
}

type ListName = 'pinned' | 'favorite' | 'hidden' | 'done';

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
  unsubscribeVisibility: (() => void) | null;
  onChange: () => void;
  fetchImpl: typeof fetch;
  debounceMs: number;
  // Timestamp of the most recent pull attempt (any outcome). Used to
  // gate visibility-change pulls.
  lastPullAttemptAt: number;
}

let runtime: SyncRuntime | null = null;

// Debug snapshot — populated whenever pull/push completes, regardless
// of outcome. Survives stopCloudSync so the debug panel can still show
// "last pull 5 s ago, failed with 503" after a user signs out.
export interface CloudSyncDebugSnapshot {
  running: boolean;
  username: string | null;
  lastPushed: Record<ListName, number>;
  pendingCount: Record<ListName, number>;
  push: { inFlight: boolean; queued: boolean; timerPending: boolean };
  lastPull: LastRequest | null;
  lastPush: LastRequest | null;
}

export interface LastRequest {
  at: number;
  ok: boolean;
  status?: number;
  // For GET: counts of entries returned by the server. For POST: counts
  // in the delta we sent.
  counts?: Record<ListName, number>;
  error?: string;
}

let lastPull: LastRequest | null = null;
let lastPush: LastRequest | null = null;

const debugSubscribers = new Set<() => void>();

function notifyDebug(): void {
  for (const fn of debugSubscribers) {
    try {
      fn();
    } catch {
      // A subscriber throwing must not derail other subscribers or the
      // underlying pull/push flow.
    }
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return String(e);
  } catch {
    return 'unknown error';
  }
}

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
    case 'hidden':
      return asEntries(getAllHiddenEntries());
    case 'done':
      return asEntries(getAllDoneEntries());
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
    case 'hidden':
      replaceHiddenEntries(entries as HiddenEntry[]);
      return;
    case 'done':
      replaceDoneEntries(entries as DoneEntry[]);
      return;
  }
}

function applyServerState(state: SyncState): void {
  if (!runtime) return;
  const lists: ListName[] = ['pinned', 'favorite', 'hidden', 'done'];
  for (const list of lists) {
    // Tolerate a missing list on the server response — an older server
    // that predates the Done rollout won't return `done` at all, and we
    // don't want to crash the pull path during the deploy window.
    const incoming = state[list] ?? [];
    const merged = mergeEntries(readLocal(list), incoming);
    writeLocal(list, merged);
    runtime.lastPushed[list] = Math.max(
      runtime.lastPushed[list],
      maxAt(incoming),
    );
  }
}

function collectDelta(): SyncState {
  if (!runtime) return { pinned: [], favorite: [], hidden: [], done: [] };
  return {
    pinned: readLocal('pinned').filter(
      (e) => e.at > runtime!.lastPushed.pinned,
    ),
    favorite: readLocal('favorite').filter(
      (e) => e.at > runtime!.lastPushed.favorite,
    ),
    hidden: readLocal('hidden').filter(
      (e) => e.at > runtime!.lastPushed.hidden,
    ),
    done: readLocal('done').filter(
      (e) => e.at > runtime!.lastPushed.done,
    ),
  };
}

async function pull(): Promise<void> {
  if (!runtime) return;
  runtime.lastPullAttemptAt = Date.now();
  const startedAt = runtime.lastPullAttemptAt;

  let res: Response;
  try {
    res = await runtime.fetchImpl('/api/sync', { method: 'GET' });
  } catch (e) {
    lastPull = { at: startedAt, ok: false, error: errorMessage(e) };
    notifyDebug();
    return;
  }
  if (!res.ok) {
    lastPull = { at: startedAt, ok: false, status: res.status };
    notifyDebug();
    return;
  }
  let server: unknown;
  try {
    server = await res.json();
  } catch {
    lastPull = {
      at: startedAt,
      ok: false,
      status: res.status,
      error: 'invalid-json',
    };
    notifyDebug();
    return;
  }
  if (!isSyncState(server)) {
    lastPull = {
      at: startedAt,
      ok: false,
      status: res.status,
      error: 'invalid-shape',
    };
    notifyDebug();
    return;
  }
  lastPull = {
    at: startedAt,
    ok: true,
    status: res.status,
    counts: {
      pinned: server.pinned.length,
      favorite: server.favorite.length,
      hidden: server.hidden.length,
      done: server.done?.length ?? 0,
    },
  };
  applyServerState(server);
  notifyDebug();
}

async function push(): Promise<void> {
  if (!runtime) return;
  const delta = collectDelta();
  const total =
    delta.pinned.length +
    delta.favorite.length +
    delta.hidden.length +
    delta.done.length;
  if (total === 0) return;

  const deltaCounts: Record<ListName, number> = {
    pinned: delta.pinned.length,
    favorite: delta.favorite.length,
    hidden: delta.hidden.length,
    done: delta.done.length,
  };
  const deltaMax = {
    pinned: maxAt(delta.pinned),
    favorite: maxAt(delta.favorite),
    hidden: maxAt(delta.hidden),
    done: maxAt(delta.done),
  };
  const startedAt = Date.now();

  let res: Response;
  try {
    res = await runtime.fetchImpl('/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(delta),
    });
  } catch (e) {
    lastPush = {
      at: startedAt,
      ok: false,
      counts: deltaCounts,
      error: errorMessage(e),
    };
    notifyDebug();
    return;
  }
  if (!res.ok) {
    lastPush = {
      at: startedAt,
      ok: false,
      status: res.status,
      counts: deltaCounts,
    };
    notifyDebug();
    return;
  }

  let server: unknown;
  try {
    server = await res.json();
  } catch {
    lastPush = {
      at: startedAt,
      ok: false,
      status: res.status,
      counts: deltaCounts,
      error: 'invalid-json',
    };
    notifyDebug();
    return;
  }
  if (!isSyncState(server)) {
    lastPush = {
      at: startedAt,
      ok: false,
      status: res.status,
      counts: deltaCounts,
      error: 'invalid-shape',
    };
    notifyDebug();
    return;
  }

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
  runtime.lastPushed.hidden = Math.max(
    runtime.lastPushed.hidden,
    deltaMax.hidden,
  );
  runtime.lastPushed.done = Math.max(
    runtime.lastPushed.done,
    deltaMax.done,
  );

  applyServerState(server);
  lastPush = {
    at: startedAt,
    ok: true,
    status: res.status,
    counts: deltaCounts,
  };
  notifyDebug();
}

function isSyncState(x: unknown): x is SyncState {
  if (typeof x !== 'object' || x === null) return false;
  const obj = x as Record<string, unknown>;
  // Accept responses from older servers that don't yet return `done` as
  // an array — we'll treat it as empty rather than rejecting the pull.
  // The POST path always sends `done`, and a fresh server deploy will
  // start echoing it back.
  if (!Array.isArray(obj.done) && obj.done !== undefined) return false;
  return (
    Array.isArray(obj.pinned) &&
    Array.isArray(obj.favorite) &&
    Array.isArray(obj.hidden)
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
  notifyDebug();
}

async function runPush(): Promise<void> {
  if (!runtime) return;
  if (runtime.pushInFlight) {
    runtime.pushQueued = true;
    notifyDebug();
    return;
  }
  runtime.pushInFlight = true;
  notifyDebug();
  try {
    await push();
  } finally {
    if (runtime) {
      runtime.pushInFlight = false;
      if (runtime.pushQueued) {
        runtime.pushQueued = false;
        schedulePush(0);
      }
      notifyDebug();
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

// Wire a document.visibilitychange listener that calls pullNow() when
// the tab transitions to visible, gated so rapid tab-switching doesn't
// flood /api/sync. Lives inside the runtime so stopCloudSync tears it
// down cleanly.
function subscribeVisibility(): () => void {
  if (typeof document === 'undefined') return () => {};
  const handler = () => {
    if (document.visibilityState !== 'visible') return;
    if (!runtime) return;
    const now = Date.now();
    if (now - runtime.lastPullAttemptAt < VISIBILITY_PULL_MIN_INTERVAL_MS) {
      return;
    }
    void pull().then(() => schedulePush(0));
  };
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
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
    lastPushed: { pinned: 0, favorite: 0, hidden: 0, done: 0 },
    pushTimer: null,
    pushInFlight: false,
    pushQueued: false,
    unsubscribeOnline: null,
    unsubscribeVisibility: null,
    onChange,
    fetchImpl,
    debounceMs: opts.debounceMs ?? SYNC_DEBOUNCE_MS,
    lastPullAttemptAt: 0,
  };

  window.addEventListener(PINNED_STORIES_CHANGE_EVENT, onChange);
  window.addEventListener(FAVORITES_CHANGE_EVENT, onChange);
  window.addEventListener(HIDDEN_STORIES_CHANGE_EVENT, onChange);
  window.addEventListener(DONE_STORIES_CHANGE_EVENT, onChange);

  runtime.unsubscribeOnline = subscribeOnline((online) => {
    if (!online) return;
    // Re-pull on reconnect and flush any deltas accumulated offline.
    void pull().then(() => schedulePush(0));
  });
  runtime.unsubscribeVisibility = subscribeVisibility();

  notifyDebug();
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
  window.removeEventListener(HIDDEN_STORIES_CHANGE_EVENT, r.onChange);
  window.removeEventListener(DONE_STORIES_CHANGE_EVENT, r.onChange);
  if (r.pushTimer) clearTimeout(r.pushTimer);
  r.unsubscribeOnline?.();
  r.unsubscribeVisibility?.();
  notifyDebug();
}

// Force an immediate GET /api/sync and merge the response. Used by
// pull-to-refresh and the /debug "Pull now" button. No-op when sync
// isn't running (user isn't signed in) — callers can always invoke
// without checking auth state.
export async function pullNow(): Promise<void> {
  if (!runtime) return;
  await pull();
}

// Force an immediate POST /api/sync of whatever delta is pending. If
// nothing's pending the call completes without sending anything. Used
// by the /debug "Push now" button.
export async function pushNow(): Promise<void> {
  if (!runtime) return;
  if (runtime.pushTimer) {
    clearTimeout(runtime.pushTimer);
    runtime.pushTimer = null;
  }
  await runPush();
}

export function getCloudSyncDebug(): CloudSyncDebugSnapshot {
  if (!runtime) {
    return {
      running: false,
      username: null,
      lastPushed: { pinned: 0, favorite: 0, hidden: 0, done: 0 },
      pendingCount: { pinned: 0, favorite: 0, hidden: 0, done: 0 },
      push: { inFlight: false, queued: false, timerPending: false },
      lastPull,
      lastPush,
    };
  }
  const delta = collectDelta();
  return {
    running: true,
    username: runtime.username,
    lastPushed: { ...runtime.lastPushed },
    pendingCount: {
      pinned: delta.pinned.length,
      favorite: delta.favorite.length,
      hidden: delta.hidden.length,
      done: delta.done.length,
    },
    push: {
      inFlight: runtime.pushInFlight,
      queued: runtime.pushQueued,
      timerPending: runtime.pushTimer !== null,
    },
    lastPull,
    lastPush,
  };
}

// Subscribe to snapshot changes. Fires on pull/push completion, push
// state transitions (in-flight, queued), and start/stop. Callers are
// expected to re-read the snapshot via getCloudSyncDebug(). Returns an
// unsubscribe function.
export function subscribeCloudSyncDebug(listener: () => void): () => void {
  debugSubscribers.add(listener);
  return () => {
    debugSubscribers.delete(listener);
  };
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

// Test-only: reset the stored lastPull / lastPush snapshots so tests
// that inspect them don't see leftovers from earlier cases.
export function _resetCloudSyncDebugForTests(): void {
  lastPull = null;
  lastPush = null;
  debugSubscribers.clear();
}
