// Shared factory for the localStorage-backed, tombstoned, last-write-wins entry
// stores (Pinned / Favorite / Hidden / Done). All four were hand-rolled copies of
// the same shape; this collapses the common core into one tested place and leaves
// each store as a thin config + its own extras (batched ops, one-shot migrations).
//
// Entries are additive (`{ id, at }`) or tombstones (`{ id, at, deleted: true }`).
// Tombstones exist so a cross-device sync pull can tell "never added" from "added
// on device A, then removed at `at`" — a stale additive copy from another device
// must not resurrect a removed id. See src/lib/cloudSync.ts for the merge.

import { reportStorageFailure } from './storageHealth';

export interface StoreEntry {
  id: number;
  at: number;
  deleted?: true;
}

export interface EntryStore {
  /** Custom event dispatched on every write, so hooks can re-read. */
  readonly changeEvent: string;
  /** Parsed, validated, (TTL-pruned) entries — additive AND tombstones. Exposed
   * so a store can build its own batched ops on the same read/write pair. */
  readRaw(now?: number): StoreEntry[];
  /** Overwrite the stored list after a sync merge — one change event for a
   * batch read. The one wholesale path: everything else is an operation, so a
   * change storage refuses can be replayed onto what is really there. */
  replaceEntries(entries: StoreEntry[]): void;
  /** Live (non-tombstoned) ids. */
  getIds(now?: number): Set<number>;
  /** Live (non-tombstoned) entries, tombstone flag stripped. */
  getEntries(now?: number): Array<{ id: number; at: number }>;
  /** Full entry list including tombstones (sync layer only; UI uses getEntries). */
  getAllEntries(now?: number): StoreEntry[];
  addId(id: number, now?: number): void;
  /** Batched `addId`: add many ids with a single write and change event. */
  addIds(ids: readonly number[], now?: number): void;
  removeId(id: number, now?: number): void;
  /** Batched `removeId`: tombstone many ids with a single read, write, and change
   * event. Ids that already carry a tombstone keep it (no `at` bump). */
  removeIds(ids: readonly number[], now?: number): void;
  /** Tombstone every currently-live id — the "forget all" the library pages
   * offer. NOT the same as `clearIds`: this keeps the resurrect-guard so a
   * cloudSync pull can't hand the whole list straight back. */
  forgetAll(now?: number): void;
  /** Hard wipe: drop every entry INCLUDING tombstones. Local-only reset (tests,
   * sign-out cleanup) — for a synced store use `forgetAll`, since a wipe leaves
   * nothing to stop the next `/api/sync` pull resurrecting the list. */
  clearIds(): void;
}

export interface EntryStoreConfig {
  storageKey: string;
  changeEvent: string;
  /** Prune entries (additive AND tombstones) older than this at read time. Omit
   * for a permanent store (Pinned / Favorite / Done). */
  ttlMs?: number;
  /** One-shot rename of an older localStorage key into storageKey, run lazily on
   * first read. */
  legacyKey?: string;
  /** Extra one-shot read-time migration (e.g. resolving pin∩hide collisions),
   * run after the legacy-key rename and before parsing. Receives the read `now`. */
  beforeRead?: (now: number) => void;
}

/**
 * One change, kept as the change rather than as the list it produced.
 *
 * Applied against whatever storage actually holds when it runs, so a stamp that
 * depends on the entry being replaced (see `stampPast`) is computed against the
 * real entry rather than against whatever this device could see at the time —
 * which, on storage that refuses reads, is nothing.
 *
 * Data rather than a closure, because the queue has to be COMPACTED: a later
 * operation naming an id supersedes an earlier one naming the same id, and a
 * queue that cannot say which ids an operation names cannot do that. See
 * `queueOp` for what an uncompacted queue costs.
 */
type PendingOp =
  | { kind: 'add'; ids: Set<number>; now: number }
  | { kind: 'remove'; ids: Set<number>; now: number }
  /** A whole list, from a sync merge. Its authority over what is already queued
   * depends on the read that built it having seen storage; see `mutate`. */
  | { kind: 'snapshot'; entries: StoreEntry[]; fromReadableStorage: boolean }
  /** A local reset: an absence, stated over whatever it finds. */
  | { kind: 'wipe' };

// Both merge sides (src/lib/cloudSync.ts and api/sync.ts `mergeEntries`) accept
// an incoming entry only when it is STRICTLY newer. `at` is wall-clock
// `Date.now()` from whichever device wrote the entry, so an entry synced from a
// device whose clock runs ahead can carry an `at` in this device's future — and
// a change stamped at our `now` would then lose the merge and be undone. Stamp
// one tick past the entry being replaced so the user's own action always wins
// its own merge, in both directions.
function stampPast(existing: StoreEntry | undefined, now: number): number {
  return existing ? Math.max(now, existing.at + 1) : now;
}

/** Replay one operation onto a list.
 *
 * A snapshot FOLDS here rather than replacing: it is whole only as of the list
 * it was built from, and it is being replayed precisely because it did not
 * land, so another writer may have moved the key since. Applied as the change
 * itself it does replace — see `mutate`. */
function applyOp(op: PendingOp, current: StoreEntry[]): StoreEntry[] {
  if (op.kind === 'wipe') return [];
  if (op.kind === 'snapshot') return mergeNewer(current, op.entries);
  const out: StoreEntry[] = [];
  const existing = new Map<number, StoreEntry>();
  for (const entry of current) {
    if (op.ids.has(entry.id)) existing.set(entry.id, entry);
    else out.push(entry);
  }
  for (const id of op.ids) {
    const prev = existing.get(id);
    if (op.kind === 'add') {
      // Idempotent per id, because a queued operation is replayed on every read
      // and on every write until storage takes one. Stamping again each time
      // would advance `at` on a list that already carries this pin — and a
      // moving timestamp reads as a fresh local change to cloudSync, which
      // would push, echo the snapshot back, and push again for as long as the
      // outage lasted.
      if (prev !== undefined && !prev.deleted && prev.at >= op.now) out.push(prev);
      else out.push({ id, at: stampPast(prev, op.now) });
    } else {
      // Idempotent on the same terms: once the list carries a tombstone at or
      // past this operation's `now`, replaying it changes nothing. An OLDER
      // tombstone is not that — it is somebody else's removal, and a live entry
      // synced from a device whose clock sits between the two would beat it and
      // resurrect what this user just removed. So it is stamped forward like
      // any other entry a removal replaces.
      if (prev?.deleted && prev.at >= op.now) out.push(prev);
      else out.push({ id, at: stampPast(prev, op.now), deleted: true });
    }
  }
  return out;
}

/** Fold `incoming` into `current` by the rule both merge sides already use
 * (src/lib/cloudSync.ts, api/sync.ts): per id the strictly newer `at` wins, so
 * a tie leaves what is already here. */
function mergeNewer(
  current: StoreEntry[],
  incoming: StoreEntry[],
): StoreEntry[] {
  const byId = new Map(current.map((e) => [e.id, e]));
  for (const entry of incoming) {
    const existing = byId.get(entry.id);
    if (existing === undefined || entry.at > existing.at) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

/** Validate a parsed value as a StoreEntry. Exported so a store's own one-shot
 * migration can scan the raw localStorage payload without re-implementing it. */
export function isEntry(x: unknown): x is StoreEntry {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  if (typeof e.id !== 'number') return false;
  if (typeof e.at !== 'number') return false;
  if ('deleted' in e && e.deleted !== true && e.deleted !== undefined) {
    return false;
  }
  return true;
}

export function createEntryStore(config: EntryStoreConfig): EntryStore {
  const { storageKey, changeEvent, ttlMs, legacyKey, beforeRead } = config;

  // Changes storage REFUSED — quota exhausted, or a private window — kept so
  // they don't silently vanish. These stores ARE the user's pinned / favorite /
  // done lists, and reads come straight back off localStorage, so a swallowed
  // write used to make a pin disappear the moment it was made with nothing to
  // say why.
  //
  // Kept as OPERATIONS, not as the list they produced. A list cannot say what
  // the user did: every id in it looks like a claim, when only one of them was
  // the change, and reconciling that against what turns up on disk means
  // guessing from timestamps — a guess this store got wrong in five different
  // ways before it was replaced (see TODO.md). An operation replayed onto the
  // real list needs no guess: it is what the user did, and it is applied to what
  // is actually there.
  //
  // Drained by the next write that storage accepts, or by any read that finds
  // storage readable again — there is no timer. Nothing already stored is
  // discarded: unlike a cache, a stale list here is the user's own data and
  // beats having none.
  let pending: PendingOp[] = [];

  // Whether this store's most recent read could see storage. A caller that
  // assembles a whole list does it from a read through this store (cloudSync
  // reads, merges, then writes back), and that read's status is what decides
  // whether its list is authoritative — not the read `mutate` takes a moment
  // later, which can succeed after the one the caller used had failed.
  let lastReadOk = true;

  // Storage failures are logged once per kind per session: reads run on every
  // render, so logging each one would bury the first — which is the one that
  // says when the outage started. The key is a constant, and the payload (the
  // user's own ids) never goes near the message.
  let loggedReadFailure = false;
  let loggedWriteFailure = false;
  let loggedMigrationFailure = false;
  let loggedMalformed = false;

  /** A read that reports whether storage answered at all, separately from what
   * it held — collapsing a refusal to `null` makes "storage is unreadable"
   * indistinguishable from "the key is absent". */
  function storedRead(): { ok: true; raw: string | null } | { ok: false } {
    try {
      return { ok: true, raw: window.localStorage.getItem(storageKey) };
    } catch (error) {
      if (!loggedReadFailure) {
        loggedReadFailure = true;
        console.debug(`entryStore: read of ${storageKey} failed`, error);
      }
      // A blocked read is a storage outage the user should hear about too, and
      // on the browser this message is most for — a private window refusing
      // storage outright — it is the ONLY signal: the write is never attempted,
      // because nothing is written over a list this device could not read.
      reportStorageFailure(error);
      return { ok: false };
    }
  }

  function tryStore(raw: string): boolean {
    try {
      window.localStorage.setItem(storageKey, raw);
      return true;
    } catch (error) {
      if (!loggedWriteFailure) {
        loggedWriteFailure = true;
        console.debug(`entryStore: write to ${storageKey} refused`, error);
      }
      // The change is held and replayed, so nothing is lost while the tab is
      // open — but it will not survive a reload, and that is the user's to
      // know. Reported per origin rather than per key (see storageHealth), and
      // deliberately on EVERY refusal: the threshold for saying something is
      // that module's to decide, not each store's.
      reportStorageFailure(error);
      return false;
    }
  }

  function parseEntries(raw: string | null, now: number): StoreEntry[] {
    if (raw === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (!loggedMalformed) {
        loggedMalformed = true;
        console.debug(`entryStore: stored payload at ${storageKey} is not JSON`);
      }
      return [];
    }
    if (!Array.isArray(parsed)) {
      if (!loggedMalformed) {
        loggedMalformed = true;
        console.debug(
          `entryStore: stored payload at ${storageKey} is not an array`,
        );
      }
      return [];
    }
    const out: StoreEntry[] = [];
    for (const item of parsed) {
      if (!isEntry(item)) continue;
      const entry: StoreEntry = { id: item.id, at: item.at };
      if (item.deleted === true) entry.deleted = true;
      out.push(entry);
    }
    return prune(out, now);
  }

  /** TTL prune — a no-op when `ttlMs` is unset. Applied to the REPLAYED list on
   * every read, not just to what was read off disk: an operation queued through
   * an outage longer than the TTL would otherwise keep re-adding an entry that
   * has expired, and the read that finally reaches storage would persist it. */
  function prune(entries: StoreEntry[], now: number): StoreEntry[] {
    if (ttlMs === undefined) return entries;
    const cutoff = now - ttlMs;
    return entries.filter((e) => e.at >= cutoff);
  }

  function migrateLegacyKey(): void {
    if (!hasWindow() || legacyKey === undefined) return;
    // Through storedRead, so a blocked read is reported once rather than on
    // every render — this runs at the top of every read.
    const current = storedRead();
    if (!current.ok || current.raw !== null) return;
    try {
      const legacy = window.localStorage.getItem(legacyKey);
      if (legacy === null) return;
      window.localStorage.setItem(storageKey, legacy);
      window.localStorage.removeItem(legacyKey);
    } catch (error) {
      if (!loggedMigrationFailure) {
        loggedMigrationFailure = true;
        console.debug(
          `entryStore: legacy-key migration to ${storageKey} failed`,
          error,
        );
      }
      // Nothing is lost: the key keeps its legacy name and the read below
      // returns [] until storage takes the rename. Still a refusal from the
      // same origin, so it counts toward telling the user.
      reportStorageFailure(error);
    }
  }

  function prepare(now: number): void {
    migrateLegacyKey();
    beforeRead?.(now);
  }

  /** What is on disk, and whether disk answered. */
  function stored(now: number): { ok: boolean; entries: StoreEntry[] } {
    const read = storedRead();
    lastReadOk = read.ok;
    return read.ok
      ? { ok: true, entries: parseEntries(read.raw, now) }
      : { ok: false, entries: [] };
  }

  /** What the user has: disk with the queued operations replayed on top. */
  function resolve(now: number): { ok: boolean; entries: StoreEntry[] } {
    const base = stored(now);
    if (pending.length === 0) return base;
    let entries = base.entries;
    for (const op of pending) entries = applyOp(op, entries);
    entries = prune(entries, now);
    // Storage answering a read is the first sign it may take a write again, so
    // the replay is the retry — and it only lands over a list this device could
    // actually see.
    if (base.ok && tryStore(JSON.stringify(entries))) pending = [];
    return { ok: base.ok, entries };
  }

  function readRaw(now: number = Date.now()): StoreEntry[] {
    if (!hasWindow()) return [];
    prepare(now);
    return resolve(now).entries;
  }

  /** Add one operation to the queue, superseding what it makes redundant.
   *
   * A queue that only appends is not idempotent on replay even when each
   * operation is: unpin-then-re-pin composes to "tombstone one tick past what
   * is there, then live one tick past THAT", so every replay advances `at` by
   * two and the moving timestamp reads to cloudSync as a fresh local change —
   * push, echo, push, for as long as the outage lasts. The user's intent for an
   * id is whatever they did to it LAST, so a later operation naming an id takes
   * that id off every earlier one. */
  function queueOp(op: PendingOp, subsumesQueue: boolean): void {
    if (op.kind === 'wipe' || subsumesQueue) {
      pending = [op];
      return;
    }
    if (op.kind === 'snapshot') {
      // Not authoritative over what is queued, so it goes underneath: those
      // operations replay on top of it, where their stamps are computed against
      // real entries rather than against nothing. Two folds in a row collapse
      // into one — applying them in order is the same as applying a single
      // merged fold (both are per-id strictly-newer), and a long outage can
      // echo a great many.
      const head = pending[0];
      pending =
        head?.kind === 'snapshot'
          ? [
              {
                kind: 'snapshot',
                entries: mergeNewer(op.entries, head.entries),
                fromReadableStorage: false,
              },
              ...pending.slice(1),
            ]
          : [op, ...pending];
      return;
    }
    const kept: PendingOp[] = [];
    for (const queued of pending) {
      if (queued.kind !== 'add' && queued.kind !== 'remove') {
        kept.push(queued);
        continue;
      }
      const ids = new Set([...queued.ids].filter((id) => !op.ids.has(id)));
      if (ids.size > 0) kept.push({ ...queued, ids });
    }
    pending = [...kept, op];
  }

  /**
   * Apply one operation: to storage if it will take it, to the queue if not.
   *
   * Installed BEFORE the change event, because subscribers re-read synchronously
   * from inside it — queued afterwards, the change is invisible to them and the
   * row does not re-render.
   */
  function mutate(op: PendingOp, now: number): void {
    if (!hasWindow()) return;
    prepare(now);
    const base = stored(now);

    // A snapshot subsumes the queue only when it was built from a list this
    // device could see: it then already accounts for those operations, and as
    // the change itself it replaces rather than folding. Built blind — whoever
    // assembled it read this store while storage was unreadable — it does not.
    const subsuming = op.kind === 'snapshot' && base.ok && op.fromReadableStorage;

    // What lands has to be exactly what a later replay would produce, so the
    // order here is the order `queueOp` puts these in: a blind snapshot goes
    // UNDER what is queued, so those operations replay on top of it whether the
    // write lands now or later. Composed the other way round, a write that
    // happens to succeed would persist the snapshot over them and drop them.
    const sequence: PendingOp[] = subsuming
      ? []
      : op.kind === 'snapshot'
        ? [op, ...pending]
        : [...pending, op];
    let entries = subsuming ? op.entries : base.entries;
    for (const queued of sequence) entries = applyOp(queued, entries);

    // Only over a list this device could actually see. A read that threw leaves
    // `base` empty, so what was just assembled is the queue alone — writing that
    // would replace the real stored list with a fragment. `resolve` holds the
    // same line, and it is the read recovering that drains the queue.
    if (base.ok && tryStore(JSON.stringify(entries))) {
      pending = [];
      window.dispatchEvent(new CustomEvent(changeEvent));
      return;
    }

    queueOp(op, subsuming);
    window.dispatchEvent(new CustomEvent(changeEvent));
  }

  function replaceEntries(entries: StoreEntry[]): void {
    mutate(
      {
        kind: 'snapshot',
        entries: entries.map((e) => ({ ...e })),
        fromReadableStorage: lastReadOk,
      },
      Date.now(),
    );
  }

  function getIds(now: number = Date.now()): Set<number> {
    return new Set(
      readRaw(now)
        .filter((e) => !e.deleted)
        .map((e) => e.id),
    );
  }

  function getEntries(
    now: number = Date.now(),
  ): Array<{ id: number; at: number }> {
    return readRaw(now)
      .filter((e) => !e.deleted)
      .map((e) => ({ id: e.id, at: e.at }));
  }

  function getAllEntries(now: number = Date.now()): StoreEntry[] {
    return readRaw(now).map((e) => ({ ...e }));
  }

  function addId(id: number, now: number = Date.now()): void {
    mutate({ kind: 'add', ids: new Set([id]), now }, now);
  }

  function addIds(ids: readonly number[], now: number = Date.now()): void {
    if (ids.length === 0) return;
    mutate({ kind: 'add', ids: new Set(ids), now }, now);
  }

  function removeId(id: number, now: number = Date.now()): void {
    // Writing a tombstone even when the id isn't present keeps sync honest:
    // another device may hold an additive entry we haven't pulled, and a newer
    // tombstone is what stops that ghost from reappearing. Skip only when a
    // tombstone is already there (nothing to bump) — this device has no news
    // about an id it can already see was removed.
    if (readRaw(now).find((e) => e.id === id)?.deleted) return;
    mutate({ kind: 'remove', ids: new Set([id]), now }, now);
  }

  function removeIds(ids: readonly number[], now: number = Date.now()): void {
    if (ids.length === 0) return;
    // Same skip as `removeId`, per id: a tombstone this device can already see
    // is not news, so the batch leaves its `at` alone. Filtering here rather
    // than inside the operation is what keeps that distinct from a tombstone
    // that only turns up when the operation replays — one the caller could not
    // see, which does not carry this removal's date (see `applyOp`).
    const visible = readRaw(now);
    const fresh = ids.filter(
      (id) => !visible.find((e) => e.id === id)?.deleted,
    );
    if (fresh.length === 0) return;
    mutate({ kind: 'remove', ids: new Set(fresh), now }, now);
  }

  function forgetAll(now: number = Date.now()): void {
    // Tombstone rather than wipe. A bare `writeRaw([])` looks right locally but
    // leaves the sync layer nothing to merge against: cloudSync's next pull
    // merges the server's still-live entries into an empty local list and the
    // whole list reappears, silently undoing the user's "Forget all".
    const live = readRaw(now).filter((e) => !e.deleted);
    if (live.length === 0) return;
    removeIds(
      live.map((e) => e.id),
      now,
    );
  }

  function clearIds(): void {
    // Deliberately NOT a snapshot: a wipe states an absence, and folding an
    // empty list into anything is a no-op. Queued, it re-applies over whatever
    // it finds — which is what a local reset means, and why it supersedes
    // everything queued before it.
    mutate({ kind: 'wipe' }, Date.now());
  }

  return {
    changeEvent,
    readRaw,
    getIds,
    getEntries,
    getAllEntries,
    addId,
    addIds,
    removeId,
    removeIds,
    forgetAll,
    clearIds,
    replaceEntries,
  };
}
