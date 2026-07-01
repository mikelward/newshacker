import { createEntryStore, type StoreEntry } from './entryStore';

const STORAGE_KEY = 'newshacker:hiddenStoryIds';
const LEGACY_DISMISSED_KEY = 'newshacker:dismissedStoryIds';
export const HIDDEN_STORIES_CHANGE_EVENT = 'newshacker:hiddenStoriesChanged';
export const HIDDEN_STORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// See entryStore.ts for the tombstone rationale. Both additive entries and
// tombstones share the 7-day TTL: a hide older than a week no longer matters to
// the UX (the "recently hidden" page doesn't show it), and the sync layer doesn't
// need to resurrect-guard against a live copy older than a week either.
export type HiddenEntry = StoreEntry;

// LEGACY_DISMISSED_KEY: one-shot rename of `dismissedStoryIds` → `hiddenStoryIds`
// (the term switched from "ignore"/"dismissed" to "hide"/"hidden").
const store = createEntryStore({
  storageKey: STORAGE_KEY,
  changeEvent: HIDDEN_STORIES_CHANGE_EVENT,
  ttlMs: HIDDEN_STORY_TTL_MS,
  legacyKey: LEGACY_DISMISSED_KEY,
});

export const getHiddenIds = store.getIds;
export const getHiddenEntries = store.getEntries;
export const getAllHiddenEntries = store.getAllEntries;
export const addHiddenId = store.addId;
export const removeHiddenId = store.removeId;
export const clearHiddenIds = store.clearIds;
export const replaceHiddenEntries = store.replaceEntries;

// Batched form of addHiddenId: hide many ids with a single read, write, and
// change event. A bulk Sweep used to call addHiddenId once per row — re-parsing
// and re-serializing the whole list and firing a change event (→ a full list
// re-render) per swept row, O(rows × list size), which visibly stalled. Same
// semantics as addHiddenId per id: later ids win, no duplicates.
export function addHiddenIds(
  ids: readonly number[],
  now: number = Date.now(),
): void {
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  const entries = store.readRaw(now).filter((e) => !idSet.has(e.id));
  for (const id of idSet) entries.push({ id, at: now });
  store.writeRaw(entries);
}
