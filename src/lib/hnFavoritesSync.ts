// HN-side favorites sync. Phase A (this file today): pulls the
// signed-in user's favorites list from /api/hn-favorites-list on
// startup and merges IDs into the local favorites store. Phase B
// will extend this singleton with a localStorage-backed queue that
// forwards local favorite/unfavorite actions back to HN.
//
// Merge semantics: HN gives us IDs only, no timestamps, so we treat
// an HN entry as `at: 0`. This means ANY subsequent local write
// (favorite with `at: Date.now()`, or a locally-recorded tombstone)
// wins the per-id last-write-wins race in replaceFavoriteEntries.
// Concretely:
//   - HN has X, local has no record    → add `{ id: X, at: 0 }`.
//   - HN has X, local has live `{X,T}` → keep local (higher `at`).
//   - HN has X, local has tombstone    → keep local tombstone.
//                                         Phase B will push an
//                                         unfavorite to HN to close
//                                         the loop.
//   - HN lacks X, local has anything   → keep local. Phase B will
//                                         push the favorite up.
//
// Fail-open: any error (401, 502, network) is swallowed — local
// favorites keep working unchanged and the next startup retries.

import { subscribeOnline, trackedFetch } from './networkStatus';
import {
  FavoriteEntry,
  getAllFavoriteEntries,
  replaceFavoriteEntries,
} from './favorites';
import {
  drop as dropFromQueue,
  enqueue as enqueueToQueue,
  HnFavoriteAction,
  listQueue,
  markFailure,
  peekReady,
} from './hnFavoriteQueue';

export interface HnFavoritesListResponse {
  ids: number[];
  truncated?: boolean;
}

// Pure merge. Exported for testing. Returns a new array; doesn't
// mutate either input.
export function mergeHnFavorites(
  local: FavoriteEntry[],
  hnIds: number[],
): FavoriteEntry[] {
  const byId = new Map<number, FavoriteEntry>();
  for (const e of local) byId.set(e.id, { ...e });
  for (const id of hnIds) {
    if (byId.has(id)) continue;
    byId.set(id, { id, at: 0 });
  }
  return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}

interface Runtime {
  username: string;
  fetchImpl: typeof fetch;
  bootstrapped: boolean;
  draining: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  unsubscribeOnline: (() => void) | null;
  unsubscribeVisibility: (() => void) | null;
  // Once an auth 401 comes back from /api/hn-favorite we pause the
  // worker until the next start() — the local session is dead and
  // further attempts will keep 401-ing without making progress.
  stalledOnAuth: boolean;
}

let runtime: Runtime | null = null;

export interface LastBootstrap {
  at: number;
  ok: boolean;
  status?: number;
  idsAdded?: number;
  error?: string;
}

export interface LastWorkerAttempt {
  at: number;
  id: number;
  action: HnFavoriteAction;
  ok: boolean;
  status?: number;
  error?: string;
}

let lastBootstrap: LastBootstrap | null = null;
let lastWorkerAttempt: LastWorkerAttempt | null = null;

function isResponse(x: unknown): x is HnFavoritesListResponse {
  if (typeof x !== 'object' || x === null) return false;
  const obj = x as Record<string, unknown>;
  if (!Array.isArray(obj.ids)) return false;
  return obj.ids.every((v) => typeof v === 'number');
}

async function bootstrapPull(): Promise<void> {
  if (!runtime) return;
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await runtime.fetchImpl('/api/hn-favorites-list', { method: 'GET' });
  } catch (e) {
    lastBootstrap = {
      at: startedAt,
      ok: false,
      error: e instanceof Error ? e.message : 'network error',
    };
    return;
  }
  if (!res.ok) {
    lastBootstrap = { at: startedAt, ok: false, status: res.status };
    return;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    lastBootstrap = {
      at: startedAt,
      ok: false,
      status: res.status,
      error: 'invalid-json',
    };
    return;
  }
  if (!isResponse(body)) {
    lastBootstrap = {
      at: startedAt,
      ok: false,
      status: res.status,
      error: 'invalid-shape',
    };
    return;
  }

  const local = getAllFavoriteEntries();
  const merged = mergeHnFavorites(local, body.ids);
  const before = new Set(local.map((e) => e.id));
  const added = merged.filter((e) => !before.has(e.id)).length;

  if (added > 0) replaceFavoriteEntries(merged);
  if (runtime) runtime.bootstrapped = true;

  lastBootstrap = {
    at: startedAt,
    ok: true,
    status: res.status,
    idsAdded: added,
  };
}

// --- Worker that drains the HN-favorite queue -------------------------
//
// tick() picks ready entries one at a time, POSTs /api/hn-favorite for
// each, and applies the outcome to the queue. A single in-flight POST
// per worker keeps ordering stable (HN may care about
// favorite→unfavorite order for the same id; we already coalesce
// these in the queue, but serial draining is cheap insurance). On a
// non-retryable 4xx we drop; on 401 we stop the worker entirely; on
// 5xx / network we markFailure and let backoff do its work.

function subscribeVisibility(): () => void {
  if (typeof document === 'undefined') return () => {};
  const handler = () => {
    if (document.visibilityState !== 'visible') return;
    void tick();
  };
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}

function scheduleNextTick(): void {
  if (!runtime) return;
  if (runtime.retryTimer) {
    clearTimeout(runtime.retryTimer);
    runtime.retryTimer = null;
  }
  if (runtime.stalledOnAuth) return;
  const queue = listQueue(runtime.username);
  if (queue.length === 0) return;
  const earliest = queue.reduce(
    (m, e) => Math.min(m, e.nextAttemptAt),
    Infinity,
  );
  const delay = Math.max(0, earliest - Date.now());
  runtime.retryTimer = setTimeout(() => {
    if (!runtime) return;
    runtime.retryTimer = null;
    void tick();
  }, delay);
}

async function processOne(entry: {
  id: number;
  action: HnFavoriteAction;
}): Promise<'stop' | 'continue'> {
  if (!runtime) return 'stop';
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await runtime.fetchImpl('/api/hn-favorite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: entry.id, action: entry.action }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'network error';
    markFailure(runtime.username, entry.id, msg);
    lastWorkerAttempt = {
      at: startedAt,
      id: entry.id,
      action: entry.action,
      ok: false,
      error: msg,
    };
    return 'continue';
  }

  if (res.status === 204 || res.ok) {
    dropFromQueue(runtime.username, entry.id);
    lastWorkerAttempt = {
      at: startedAt,
      id: entry.id,
      action: entry.action,
      ok: true,
      status: res.status,
    };
    return 'continue';
  }

  if (res.status === 401) {
    runtime.stalledOnAuth = true;
    lastWorkerAttempt = {
      at: startedAt,
      id: entry.id,
      action: entry.action,
      ok: false,
      status: 401,
      error: 'auth',
    };
    return 'stop';
  }

  if (res.status === 400 || res.status === 404 || res.status === 405) {
    // Client-side bug or a permanently-bad request — dropping is
    // safer than looping. 404/405 shouldn't happen in practice but
    // treat them as terminal for defense-in-depth.
    dropFromQueue(runtime.username, entry.id);
    lastWorkerAttempt = {
      at: startedAt,
      id: entry.id,
      action: entry.action,
      ok: false,
      status: res.status,
      error: 'dropped',
    };
    return 'continue';
  }

  // 429, 502, 503, 504, or any other transient — retry.
  markFailure(runtime.username, entry.id, `status ${res.status}`);
  lastWorkerAttempt = {
    at: startedAt,
    id: entry.id,
    action: entry.action,
    ok: false,
    status: res.status,
    error: `status ${res.status}`,
  };
  return 'continue';
}

async function tick(): Promise<void> {
  if (!runtime) return;
  if (runtime.draining) return;
  if (runtime.stalledOnAuth) return;
  runtime.draining = true;
  try {
    // Loop until nothing's ready, handling each entry in turn.
    // peekReady returns a fresh view each iteration so a markFailure
    // that just bumped nextAttemptAt gets excluded on the next pass.
    while (runtime && !runtime.stalledOnAuth) {
      const ready = peekReady(runtime.username);
      if (ready.length === 0) break;
      const outcome = await processOne(ready[0]);
      if (outcome === 'stop') break;
    }
  } finally {
    if (runtime) runtime.draining = false;
    scheduleNextTick();
  }
}

// Called by useFavorites on a user-originated favorite/unfavorite.
// Safe to call when no sync is running (logged-out user) — it's a
// no-op in that case.
export function enqueueHnFavoriteAction(
  username: string,
  action: HnFavoriteAction,
  id: number,
): void {
  enqueueToQueue(username, action, id);
  if (runtime?.username === username) void tick();
}

export interface StartOptions {
  fetchImpl?: typeof fetch;
}

export async function startHnFavoritesSync(
  username: string,
  opts: StartOptions = {},
): Promise<void> {
  if (runtime && runtime.username === username) return;
  stopHnFavoritesSync();

  const fetchImpl = opts.fetchImpl ?? trackedFetch;
  runtime = {
    username,
    fetchImpl,
    bootstrapped: false,
    draining: false,
    retryTimer: null,
    unsubscribeOnline: null,
    unsubscribeVisibility: null,
    stalledOnAuth: false,
  };

  runtime.unsubscribeOnline = subscribeOnline((online) => {
    if (!online) return;
    // Reconnect — treat this as a nudge. If we were stalled on auth,
    // don't retry: the session is still dead until the user signs
    // back in, which restarts the whole sync.
    void tick();
  });
  runtime.unsubscribeVisibility = subscribeVisibility();

  await bootstrapPull();
  // Kick the worker in case there are pending queued actions from a
  // previous session that never got to drain.
  void tick();
}

export function stopHnFavoritesSync(): void {
  if (!runtime) return;
  const r = runtime;
  runtime = null;
  if (r.retryTimer) clearTimeout(r.retryTimer);
  r.unsubscribeOnline?.();
  r.unsubscribeVisibility?.();
}

export function getHnFavoritesSyncDebug(): {
  running: boolean;
  username: string | null;
  bootstrapped: boolean;
  queueLength: number;
  stalledOnAuth: boolean;
  lastBootstrap: LastBootstrap | null;
  lastWorkerAttempt: LastWorkerAttempt | null;
} {
  return {
    running: runtime !== null,
    username: runtime?.username ?? null,
    bootstrapped: runtime?.bootstrapped ?? false,
    queueLength: runtime ? listQueue(runtime.username).length : 0,
    stalledOnAuth: runtime?.stalledOnAuth ?? false,
    lastBootstrap,
    lastWorkerAttempt,
  };
}

// Test-only reset so cases don't leak state into each other.
export function _resetHnFavoritesSyncForTests(): void {
  if (runtime?.retryTimer) clearTimeout(runtime.retryTimer);
  runtime = null;
  lastBootstrap = null;
  lastWorkerAttempt = null;
}
