import { createEntryStore, type StoreEntry } from './entryStore';

const STORAGE_KEY = 'newshacker:pinnedStoryIds';
const LEGACY_SAVED_KEY = 'newshacker:savedStoryIds';
export const PINNED_STORIES_CHANGE_EVENT = 'newshacker:pinnedStoriesChanged';

// Additive ({ id, at }) or tombstone ({ id, at, deleted: true }) — see
// entryStore.ts for the tombstone rationale (cross-device resurrect-guard).
export type PinnedEntry = StoreEntry;

// LEGACY_SAVED_KEY: one-shot rename of `savedStoryIds` → `pinnedStoryIds` so
// existing readers don't lose their list when "Saved" became "Pinned".
const store = createEntryStore({
  storageKey: STORAGE_KEY,
  changeEvent: PINNED_STORIES_CHANGE_EVENT,
  legacyKey: LEGACY_SAVED_KEY,
});

export const getPinnedIds = store.getIds;
export const getPinnedEntries = store.getEntries;
// Full entry list including tombstones. Only the sync layer should need this;
// UI code should use getPinnedEntries / getPinnedIds.
export const getAllPinnedEntries = store.getAllEntries;
export const addPinnedId = store.addId;
export const removePinnedId = store.removeId;
export const clearPinnedIds = store.clearIds;
// Overwrite the local entry list wholesale (sync layer, after merging a pull).
export const replacePinnedEntries = store.replaceEntries;

// Batched form of removePinnedId: tombstone many ids with a single read, write,
// and change event. The bulk Sweep path unpins every swept row (the Pin ↔ Hide
// shield); doing that one id at a time re-parsed and re-serialized the whole list
// — and fired a change event — per row. Same semantics as removePinnedId per id:
// an id that already carries a tombstone keeps it untouched; the rest get a fresh
// tombstone at `now`.
export function removePinnedIds(
  ids: readonly number[],
  now: number = Date.now(),
): void {
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  const before = store.readRaw(now);
  const after: PinnedEntry[] = [];
  const kept = new Set<number>();
  for (const e of before) {
    if (!idSet.has(e.id)) {
      after.push(e);
    } else if (e.deleted) {
      // Preserve the existing tombstone rather than bumping its `at`, matching
      // removePinnedId's early return for already-deleted ids.
      after.push(e);
      kept.add(e.id);
    }
    // Live entries that match are dropped here and re-added as tombstones below.
  }
  for (const id of idSet) {
    if (kept.has(id)) continue;
    after.push({ id, at: now, deleted: true });
  }
  store.writeRaw(after);
}
