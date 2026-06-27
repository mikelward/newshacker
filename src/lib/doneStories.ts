import { createEntryStore, type StoreEntry } from './entryStore';

const STORAGE_KEY = 'newshacker:doneStoryIds';
export const DONE_STORIES_CHANGE_EVENT = 'newshacker:doneStoriesChanged';

// Done is the user's completion log — "I engaged with this thread and I'm
// finished" — meant to survive across sessions and devices. Permanent store
// (no TTL), tombstoned like Pinned/Favorite; see entryStore.ts for the rationale.
//
// TODO(retention): consider a TTL for entries and tombstones. See
// TODO.md § "Retention policy".
export type DoneEntry = StoreEntry;

const store = createEntryStore({
  storageKey: STORAGE_KEY,
  changeEvent: DONE_STORIES_CHANGE_EVENT,
});

export const getDoneIds = store.getIds;
export const getDoneEntries = store.getEntries;
export const getAllDoneEntries = store.getAllEntries;
export const addDoneId = store.addId;
export const removeDoneId = store.removeId;
export const clearDoneIds = store.clearIds;
export const replaceDoneEntries = store.replaceEntries;
