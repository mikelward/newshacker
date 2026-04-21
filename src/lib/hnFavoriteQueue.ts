// Pending HN favorite/unfavorite actions, persisted in localStorage so
// a reload / offline stretch doesn't lose the user's intent.
//
// The queue records the *intent* to mutate HN. The local favorites
// store (src/lib/favorites.ts) is the authoritative UI state — a
// queued action may eventually get dropped (e.g. after max retries or
// on 4xx from HN) without rolling the local state back. That mismatch
// is intentional: local wins the LWW merge, and the worst case is that
// HN's favorites page stays out of sync until the user retaps.
//
// Coalescing: if a new action cancels a pending one for the same id
// (favorite → unfavorite or vice versa) we drop both, because the net
// change to HN is zero. This is the key correctness property — without
// it, a rapid toggle could race the worker and leave HN set to the
// wrong value.
//
// Backoff: `nextAttemptAt` is bumped after each failure using a
// capped exponential schedule. The worker only picks up entries whose
// `nextAttemptAt <= now`. After MAX_ATTEMPTS the entry is dropped.
//
// Storage key is namespaced under the logged-in username so switching
// accounts doesn't mix queues. Phase B's worker reads/writes through
// this module; this slice ships the store only.

const STORAGE_KEY_PREFIX = 'newshacker:hnFavoriteQueue:';
export const HN_FAVORITE_QUEUE_CHANGE_EVENT =
  'newshacker:hnFavoriteQueueChanged';

export type HnFavoriteAction = 'favorite' | 'unfavorite';

export interface QueuedHnFavoriteAction {
  id: number;
  action: HnFavoriteAction;
  at: number;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
}

// Capped exponential backoff, in ms. First retry ~2 s; 10th ~5 min.
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 5 * 60 * 1000;
export const MAX_ATTEMPTS = 10;

export function backoffDelayMs(attempts: number): number {
  // attempts=1 → 2s, 2 → 4s, 3 → 8s, 4 → 16s, 5 → 32s, ...,
  // capped at BACKOFF_CAP_MS.
  const exp = Math.min(attempts - 1, 20);
  const raw = BACKOFF_BASE_MS * 2 ** exp;
  return Math.min(raw, BACKOFF_CAP_MS);
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function storageKey(username: string): string {
  return `${STORAGE_KEY_PREFIX}${username}`;
}

function isQueued(x: unknown): x is QueuedHnFavoriteAction {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== 'number' || !Number.isSafeInteger(o.id) || o.id <= 0) {
    return false;
  }
  if (o.action !== 'favorite' && o.action !== 'unfavorite') return false;
  if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return false;
  if (
    typeof o.attempts !== 'number' ||
    !Number.isFinite(o.attempts) ||
    o.attempts < 0
  ) {
    return false;
  }
  if (
    typeof o.nextAttemptAt !== 'number' ||
    !Number.isFinite(o.nextAttemptAt)
  ) {
    return false;
  }
  if ('lastError' in o && typeof o.lastError !== 'string') return false;
  return true;
}

function readRaw(username: string): QueuedHnFavoriteAction[] {
  if (!hasWindow()) return [];
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(storageKey(username));
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: QueuedHnFavoriteAction[] = [];
  for (const raw of parsed) {
    if (!isQueued(raw)) continue;
    const entry: QueuedHnFavoriteAction = {
      id: raw.id,
      action: raw.action,
      at: raw.at,
      attempts: raw.attempts,
      nextAttemptAt: raw.nextAttemptAt,
    };
    if (typeof raw.lastError === 'string' && raw.lastError) {
      entry.lastError = raw.lastError;
    }
    out.push(entry);
  }
  return out;
}

function writeRaw(username: string, entries: QueuedHnFavoriteAction[]): void {
  if (!hasWindow()) return;
  try {
    if (entries.length === 0) {
      window.localStorage.removeItem(storageKey(username));
    } else {
      window.localStorage.setItem(storageKey(username), JSON.stringify(entries));
    }
  } catch {
    // quota / privacy-mode failures are non-fatal — the worker will
    // just see an empty queue on next read.
  }
  window.dispatchEvent(new CustomEvent(HN_FAVORITE_QUEUE_CHANGE_EVENT));
}

export function listQueue(username: string): QueuedHnFavoriteAction[] {
  return readRaw(username).map((e) => ({ ...e }));
}

// Enqueue a new action. Coalesces against any existing entry for the
// same id: if it cancels the pending action, both are dropped; if it
// matches, the existing entry stays (idempotent re-enqueue — no
// reason to reset attempts or bump nextAttemptAt).
export function enqueue(
  username: string,
  action: HnFavoriteAction,
  id: number,
  now: number = Date.now(),
): void {
  const current = readRaw(username);
  const existing = current.find((e) => e.id === id);
  if (existing) {
    if (existing.action === action) {
      // Duplicate — leave the existing entry alone so its retry
      // schedule isn't reset by a no-op re-enqueue.
      return;
    }
    // Canceling op — drop the pending one, don't add the new one.
    writeRaw(
      username,
      current.filter((e) => e.id !== id),
    );
    return;
  }
  const next: QueuedHnFavoriteAction = {
    id,
    action,
    at: now,
    attempts: 0,
    nextAttemptAt: now,
  };
  writeRaw(username, [...current, next]);
}

// Entries whose `nextAttemptAt <= now`, in enqueue order. The worker
// picks one at a time; this is just a peek helper.
export function peekReady(
  username: string,
  now: number = Date.now(),
): QueuedHnFavoriteAction[] {
  return readRaw(username)
    .filter((e) => e.nextAttemptAt <= now)
    .map((e) => ({ ...e }));
}

export function drop(username: string, id: number): void {
  const current = readRaw(username);
  const next = current.filter((e) => e.id !== id);
  if (next.length === current.length) return;
  writeRaw(username, next);
}

// Record a failed attempt. If the entry has hit MAX_ATTEMPTS it's
// dropped; otherwise `attempts` and `nextAttemptAt` are bumped and
// `lastError` stored. Returns true iff the entry survives and will
// be retried.
export function markFailure(
  username: string,
  id: number,
  error: string,
  now: number = Date.now(),
): boolean {
  const current = readRaw(username);
  const idx = current.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  const entry = current[idx];
  const attempts = entry.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    const next = current.slice();
    next.splice(idx, 1);
    writeRaw(username, next);
    return false;
  }
  const bumped: QueuedHnFavoriteAction = {
    ...entry,
    attempts,
    nextAttemptAt: now + backoffDelayMs(attempts),
    lastError: error,
  };
  const next = current.slice();
  next[idx] = bumped;
  writeRaw(username, next);
  return true;
}

export function clearQueue(username: string): void {
  writeRaw(username, []);
}

// Test-only: expose the internal storage key so tests can assert
// per-user namespacing.
export function _storageKeyForTests(username: string): string {
  return storageKey(username);
}
