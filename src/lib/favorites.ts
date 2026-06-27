import { createEntryStore, type StoreEntry } from './entryStore';

const STORAGE_KEY = 'newshacker:favoriteStoryIds';
export const FAVORITES_CHANGE_EVENT = 'newshacker:favoritesChanged';

// See entryStore.ts for the tombstone rationale — same shape applies here.
export type FavoriteEntry = StoreEntry;

const store = createEntryStore({
  storageKey: STORAGE_KEY,
  changeEvent: FAVORITES_CHANGE_EVENT,
});

export const getFavoriteIds = store.getIds;
export const getFavoriteEntries = store.getEntries;
export const getAllFavoriteEntries = store.getAllEntries;
export const addFavoriteId = store.addId;
export const removeFavoriteId = store.removeId;
export const clearFavoriteIds = store.clearIds;
export const replaceFavoriteEntries = store.replaceEntries;
