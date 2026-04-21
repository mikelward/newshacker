const STORAGE_KEY = 'newshacker:pinnedStoryIds';
const LEGACY_SAVED_KEY = 'newshacker:savedStoryIds';
export const PINNED_STORIES_CHANGE_EVENT = 'newshacker:pinnedStoriesChanged';

// Entries can be additive ({ id, at }) or tombstones ({ id, at, deleted:
// true }). Tombstones exist so a cross-device sync pull can tell the
// difference between "this id was never pinned" and "this id was pinned
// on device A, then unpinned at `at`, and the other device's stale
// additive copy must not resurrect it". See src/lib/cloudSync.ts.
export interface PinnedEntry {
  id: number;
  at: number;
  deleted?: true;
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function isEntry(x: unknown): x is PinnedEntry {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  if (typeof e.id !== 'number') return false;
  if (typeof e.at !== 'number') return false;
  if ('deleted' in e && e.deleted !== true && e.deleted !== undefined) {
    return false;
  }
  return true;
}

// One-shot rename of the legacy `savedStoryIds` key to `pinnedStoryIds` so
// existing readers don't lose their list when we rename "Saved" to "Pinned".
// Cheap (one localStorage get when there's nothing to migrate) and self-erasing.
function migrateLegacyKey(): void {
  if (!hasWindow()) return;
  try {
    if (window.localStorage.getItem(STORAGE_KEY) !== null) return;
    const legacy = window.localStorage.getItem(LEGACY_SAVED_KEY);
    if (legacy === null) return;
    window.localStorage.setItem(STORAGE_KEY, legacy);
    window.localStorage.removeItem(LEGACY_SAVED_KEY);
  } catch {
    // ignore storage failures; reads return [] in that case.
  }
}

function readRaw(): PinnedEntry[] {
  if (!hasWindow()) return [];
  migrateLegacyKey();
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
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
  const out: PinnedEntry[] = [];
  for (const raw of parsed) {
    if (!isEntry(raw)) continue;
    const entry: PinnedEntry = { id: raw.id, at: raw.at };
    if (raw.deleted === true) entry.deleted = true;
    out.push(entry);
  }
  return out;
}

function writeRaw(entries: PinnedEntry[]): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // quota or privacy-mode failures are non-fatal
  }
  window.dispatchEvent(new CustomEvent(PINNED_STORIES_CHANGE_EVENT));
}

export function getPinnedIds(): Set<number> {
  return new Set(
    readRaw()
      .filter((e) => !e.deleted)
      .map((e) => e.id),
  );
}

export function getPinnedEntries(): Array<{ id: number; at: number }> {
  return readRaw()
    .filter((e) => !e.deleted)
    .map((e) => ({ id: e.id, at: e.at }));
}

// Full entry list including tombstones. Only the sync layer should need
// this; UI code should use `getPinnedEntries` / `getPinnedIds`.
export function getAllPinnedEntries(): PinnedEntry[] {
  return readRaw().map((e) => ({ ...e }));
}

export function addPinnedId(id: number, now: number = Date.now()): void {
  const entries = readRaw().filter((e) => e.id !== id);
  entries.push({ id, at: now });
  writeRaw(entries);
}

export function removePinnedId(id: number, now: number = Date.now()): void {
  const before = readRaw();
  const existing = before.find((e) => e.id === id);
  // If the id isn't in the store, writing a tombstone keeps sync
  // honest: another device might have an additive entry we haven't
  // pulled yet, and a tombstone with a newer `at` is what prevents
  // that ghost pin from reappearing.
  if (existing && existing.deleted) return;
  const after = before.filter((e) => e.id !== id);
  after.push({ id, at: now, deleted: true });
  writeRaw(after);
}

export function clearPinnedIds(): void {
  writeRaw([]);
}

// Overwrite the local entry list wholesale. Used by the sync layer
// after merging a server pull — the change event fires once, so UI
// hooks re-read in a single batch.
export function replacePinnedEntries(entries: PinnedEntry[]): void {
  writeRaw(entries.map((e) => ({ ...e })));
}
