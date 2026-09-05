// Whether this device can store the user's lists, and telling them when it
// can't.
//
// `createEntryStore` keeps a refused write in memory and replays it (SPEC:
// "When the device cannot store the list"), so nothing is lost while the tab is
// open — but the edit is gone after a reload, and until now the only sign was a
// `console.debug`. A user whose pins quietly stop persisting has no way to know
// that, or that freeing space would fix it.
//
// Per ORIGIN, not per key. Quota and access are properties of the origin: once
// one write is refused the next one is too, and all four stores (Pinned,
// Favorite, Hidden, Done) share the condition. So the refusals report here and
// one message covers the lot, however many keys hit it.

export type StorageFailureKind =
  /** Out of space — the user can fix this by freeing some. */
  | 'quota'
  /** Storage is off: a private window, or blocked cookies. */
  | 'denied'
  /** Something else refused the write. */
  | 'unknown';

/** How many refusals of a kind it takes before the user is told.
 *
 * Out of space and blocked access both HOLD until the user does something, so
 * the first refusal is already the whole story. An unclassified failure could
 * be a one-off, and a message about a blip the user cannot act on is worse than
 * silence — so it waits to see the condition repeat. */
function threshold(kind: StorageFailureKind): number {
  return kind === 'unknown' ? 2 : 1;
}

function classify(error: unknown): StorageFailureKind {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    // Chrome and Safari throw `QuotaExceededError`; Firefox throws
    // `NS_ERROR_DOM_QUOTA_REACHED` with the legacy code 1014, and older
    // WebKit uses the legacy 22. Match on all three, since the name alone
    // misses Firefox and the code alone misses browsers that stopped setting
    // one.
    if (
      error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error.code === 22 ||
      error.code === 1014
    ) {
      return 'quota';
    }
    if (error.name === 'SecurityError') return 'denied';
  }
  return 'unknown';
}

type Listener = (kind: StorageFailureKind) => void;

const seen = new Map<StorageFailureKind, number>();
const announced = new Set<StorageFailureKind>();
const listeners = new Set<Listener>();
// Kinds that have reached their threshold and not yet been delivered — because
// nothing was listening yet (the stores are read on the very first render, so a
// blocked read can beat the watcher's mount), or because delivery is deferred.
let pending: StorageFailureKind[] = [];
let flushScheduled = false;

/** Deliver on a microtask, never inside the caller.
 *
 * A report can come from a READ, and reads happen during render — a hook's
 * `useMemo` calls into the store on the first frame. Calling a listener from
 * there would run `showToast` while another component is rendering: React
 * refuses the update ("Cannot update a component while rendering a different
 * component"), and under concurrent rendering it is unsafe rather than merely
 * noisy. A microtask runs once the stack has unwound, which is after React has
 * finished or yielded, so the toast is an ordinary update. */
function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    // Nothing listening yet: stay queued rather than drop it, and the next
    // subscribe schedules another flush.
    if (listeners.size === 0) return;
    const queued = pending;
    pending = [];
    for (const kind of queued) {
      for (const listener of listeners) listener(kind);
    }
  });
}

/** A `localStorage` read or write was refused. Called from the store's catches,
 * which already hold the exception.
 *
 * Reads count, not just writes: a private window that blocks storage outright
 * throws on `getItem` too, and the store then never attempts the write at all
 * (it will not overwrite a list it could not read). Reporting only refused
 * writes left exactly the user this message names — storage blocked — hearing
 * nothing. */
export function reportStorageFailure(error: unknown): void {
  const kind = classify(error);
  if (announced.has(kind)) return; // once per kind per session
  const count = (seen.get(kind) ?? 0) + 1;
  seen.set(kind, count);
  if (count < threshold(kind)) return;
  announced.add(kind);
  pending.push(kind);
  scheduleFlush();
}

/** Subscribe to storage refusals. Anything that reached its threshold before
 * this listener arrived is delivered too — on the same microtask as everything
 * else, since this runs from an effect and the caller has a render to finish. */
export function subscribeStorageFailure(listener: Listener): () => void {
  listeners.add(listener);
  if (pending.length > 0) scheduleFlush();
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forget what this session has seen, announced, and who is
 * listening — all of it is module-level, so without this one case's leftovers
 * decide the next one's behavior (a listener still registered is the difference
 * between a report being delivered and being queued). */
export function resetStorageHealthForTest(): void {
  seen.clear();
  announced.clear();
  pending = [];
  listeners.clear();
}
