// Shared factory for the localStorage-backed, tombstoned, last-write-wins entry
// stores (Pinned / Favorite / Hidden / Done). All four were hand-rolled copies of
// the same shape; this collapses the common core into one tested place and leaves
// each store as a thin config + its own extras (batched ops, one-shot migrations).
//
// Entries are additive (`{ id, at }`) or tombstones (`{ id, at, deleted: true }`).
// Tombstones exist so a cross-device sync pull can tell "never added" from "added
// on device A, then removed at `at`" — a stale additive copy from another device
// must not resurrect a removed id. See src/lib/cloudSync.ts for the merge.

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
  /** Overwrite the stored list and fire the change event once. */
  writeRaw(entries: StoreEntry[]): void;
  /** Live (non-tombstoned) ids. */
  getIds(now?: number): Set<number>;
  /** Live (non-tombstoned) entries, tombstone flag stripped. */
  getEntries(now?: number): Array<{ id: number; at: number }>;
  /** Full entry list including tombstones (sync layer only; UI uses getEntries). */
  getAllEntries(now?: number): StoreEntry[];
  addId(id: number, now?: number): void;
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
  /** Overwrite wholesale after a sync merge — one change event for a batch read. */
  replaceEntries(entries: StoreEntry[]): void;
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

  function migrateLegacyKey(): void {
    if (!hasWindow() || legacyKey === undefined) return;
    try {
      if (window.localStorage.getItem(storageKey) !== null) return;
      const legacy = window.localStorage.getItem(legacyKey);
      if (legacy === null) return;
      window.localStorage.setItem(storageKey, legacy);
      window.localStorage.removeItem(legacyKey);
    } catch {
      // ignore storage failures; reads return [] in that case.
    }
  }

  function readRaw(now: number = Date.now()): StoreEntry[] {
    if (!hasWindow()) return [];
    migrateLegacyKey();
    beforeRead?.(now);
    let raw: string | null;
    try {
      raw = window.localStorage.getItem(storageKey);
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
    const cutoff = ttlMs === undefined ? -Infinity : now - ttlMs;
    const out: StoreEntry[] = [];
    for (const item of parsed) {
      if (!isEntry(item)) continue;
      if (item.at < cutoff) continue; // TTL prune (no-op when ttlMs is unset)
      const entry: StoreEntry = { id: item.id, at: item.at };
      if (item.deleted === true) entry.deleted = true;
      out.push(entry);
    }
    return out;
  }

  function writeRaw(entries: StoreEntry[]): void {
    if (!hasWindow()) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(entries));
    } catch {
      // quota or privacy-mode failures are non-fatal
    }
    window.dispatchEvent(new CustomEvent(changeEvent));
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
    const entries = readRaw(now).filter((e) => e.id !== id);
    entries.push({ id, at: now });
    writeRaw(entries);
  }

  // Both merge sides (src/lib/cloudSync.ts and api/sync.ts `mergeEntries`) accept
  // an incoming entry only when it is STRICTLY newer. `at` is wall-clock
  // `Date.now()` from whichever device wrote the entry, so a live entry synced
  // from a device whose clock runs ahead can carry an `at` in this device's
  // future — and a tombstone stamped at our `now` would then lose the merge and
  // the removed id would come straight back. Stamp the tombstone one tick past
  // the live entry it replaces so removal always wins its own merge.
  function tombstoneAt(existing: StoreEntry | undefined, now: number): number {
    return existing ? Math.max(now, existing.at + 1) : now;
  }

  function removeId(id: number, now: number = Date.now()): void {
    const before = readRaw(now);
    const existing = before.find((e) => e.id === id);
    // Writing a tombstone even when the id isn't present keeps sync honest:
    // another device may hold an additive entry we haven't pulled, and a newer
    // tombstone is what stops that ghost from reappearing. Skip only when a
    // tombstone is already there (nothing to bump).
    if (existing && existing.deleted) return;
    const after = before.filter((e) => e.id !== id);
    after.push({ id, at: tombstoneAt(existing, now), deleted: true });
    writeRaw(after);
  }

  function removeIds(ids: readonly number[], now: number = Date.now()): void {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const before = readRaw(now);
    const after: StoreEntry[] = [];
    const kept = new Set<number>();
    const replaced = new Map<number, StoreEntry>();
    for (const e of before) {
      if (!idSet.has(e.id)) {
        after.push(e);
      } else if (e.deleted) {
        // Preserve the existing tombstone rather than bumping its `at`, matching
        // removeId's early return for already-deleted ids.
        after.push(e);
        kept.add(e.id);
      } else {
        // Live entries that match are dropped here and re-added as tombstones
        // below — keep the entry so the tombstone can out-date it (see
        // `tombstoneAt`).
        replaced.set(e.id, e);
      }
    }
    for (const id of idSet) {
      if (kept.has(id)) continue;
      after.push({ id, at: tombstoneAt(replaced.get(id), now), deleted: true });
    }
    writeRaw(after);
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
    writeRaw([]);
  }

  function replaceEntries(entries: StoreEntry[]): void {
    writeRaw(entries.map((e) => ({ ...e })));
  }

  return {
    changeEvent,
    readRaw,
    writeRaw,
    getIds,
    getEntries,
    getAllEntries,
    addId,
    removeId,
    removeIds,
    forgetAll,
    clearIds,
    replaceEntries,
  };
}
