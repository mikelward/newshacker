import { getPinnedIds, removePinnedId } from './pinnedStories';
import { createEntryStore, isEntry, type StoreEntry } from './entryStore';

const STORAGE_KEY = 'newshacker:hiddenStoryIds';
const LEGACY_DISMISSED_KEY = 'newshacker:dismissedStoryIds';
const PIN_HIDE_MIGRATION_KEY = 'newshacker:pinHideCollisionMigrated';
export const HIDDEN_STORIES_CHANGE_EVENT = 'newshacker:hiddenStoriesChanged';
export const HIDDEN_STORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// See entryStore.ts for the tombstone rationale. Both additive entries and
// tombstones share the 7-day TTL: a hide older than a week no longer matters to
// the UX (the "recently hidden" page doesn't show it), and the sync layer doesn't
// need to resurrect-guard against a live copy older than a week either.
export type HiddenEntry = StoreEntry;

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

// One-shot migration: resolve legacy pin ∩ hidden pairs in favor of hidden.
// Before Pin became a shield against Hide (swipe-right and the row-menu "Hide"
// are now suppressed on pinned rows — see StoryListItem), a reader could hide a
// pinned story and leave both stores carrying the same id. That pair can't be
// produced now, but it can still be *stored* from a previous version. Hide is the
// more recent, specific signal, so we drop the pin to honor it, keeping /hidden
// and /pinned internally consistent (a story sits in exactly one).
//
// Apply the same TTL cutoff `readRaw` uses: an expired hide is a ghost that
// wouldn't affect the UI and shouldn't drop a pin the reader made months after a
// stale hide (reads prune in-memory but don't rewrite localStorage).
//
// Self-limiting: the version marker runs it at most once per install, and the
// 7-day TTL clears any surviving collision on its own. Runs as the store's
// `beforeRead` hook, so it reads localStorage directly rather than through the
// store (which would recurse). TODO: delete this function and the beforeRead wire
// after 2026-05-15 — by then every pre-shield hide is gone (expired) or migrated.
function migratePinHideCollisions(now: number): void {
  if (!hasWindow()) return;
  try {
    if (window.localStorage.getItem(PIN_HIDE_MIGRATION_KEY) === 'true') return;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    // No hidden entries at all → nothing to migrate; mark so we don't re-scan.
    if (!raw) {
      window.localStorage.setItem(PIN_HIDE_MIGRATION_KEY, 'true');
      return;
    }
    // Unparseable payload → leave the marker unset so a later load can retry
    // (cloud sync's replaceHiddenEntries might repair the store in between, and
    // the migration shouldn't silently never run against the repaired data).
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    const cutoff = now - HIDDEN_STORY_TTL_MS;
    const pinnedIds = getPinnedIds();
    for (const entry of parsed) {
      if (!isEntry(entry)) continue;
      if (entry.deleted === true) continue;
      if (entry.at < cutoff) continue;
      if (pinnedIds.has(entry.id)) removePinnedId(entry.id);
    }
    window.localStorage.setItem(PIN_HIDE_MIGRATION_KEY, 'true');
  } catch {
    // ignore storage failures; we'll retry on next load.
  }
}

// LEGACY_DISMISSED_KEY: one-shot rename of `dismissedStoryIds` → `hiddenStoryIds`
// (the term switched from "ignore"/"dismissed" to "hide"/"hidden").
const store = createEntryStore({
  storageKey: STORAGE_KEY,
  changeEvent: HIDDEN_STORIES_CHANGE_EVENT,
  ttlMs: HIDDEN_STORY_TTL_MS,
  legacyKey: LEGACY_DISMISSED_KEY,
  beforeRead: migratePinHideCollisions,
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
