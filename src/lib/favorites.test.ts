import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addFavoriteId,
  clearFavoriteIds,
  getAllFavoriteEntries,
  getFavoriteEntries,
  getFavoriteIds,
  removeFavoriteId,
  replaceFavoriteEntries,
} from './favorites';

describe('favorites', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns an empty set when nothing is stored', () => {
    expect(getFavoriteIds()).toEqual(new Set());
  });

  it('adds and retrieves favorite ids', () => {
    addFavoriteId(1);
    addFavoriteId(2);
    expect(getFavoriteIds()).toEqual(new Set([1, 2]));
  });

  it('does not duplicate an id that is added twice', () => {
    addFavoriteId(1);
    addFavoriteId(1);
    expect(getFavoriteIds().size).toBe(1);
  });

  it('removes ids', () => {
    addFavoriteId(1);
    addFavoriteId(2);
    removeFavoriteId(1);
    expect(getFavoriteIds()).toEqual(new Set([2]));
  });

  it('clears all ids', () => {
    addFavoriteId(1);
    addFavoriteId(2);
    clearFavoriteIds();
    expect(getFavoriteIds()).toEqual(new Set());
  });

  it('does not expire entries over time (favorites are permanent until removed)', () => {
    const ancient = 1;
    addFavoriteId(1, ancient);
    expect(getFavoriteIds()).toEqual(new Set([1]));
    const entries = getFavoriteEntries();
    expect(entries).toEqual([{ id: 1, at: ancient }]);
  });

  it('refreshes the timestamp when an id is re-added', () => {
    addFavoriteId(1, 1000);
    addFavoriteId(1, 2000);
    const entries = getFavoriteEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ id: 1, at: 2000 });
  });

  it('ignores malformed storage data', () => {
    window.localStorage.setItem('newshacker:favoriteStoryIds', 'not json');
    expect(getFavoriteIds()).toEqual(new Set());
  });

  it('ignores entries that are not the expected shape', () => {
    window.localStorage.setItem(
      'newshacker:favoriteStoryIds',
      JSON.stringify([1, 2, { id: 3, at: Date.now() }]),
    );
    expect(getFavoriteIds()).toEqual(new Set([3]));
  });

  it('dispatches a change event on add and remove', () => {
    const events: Event[] = [];
    const handler = (e: Event) => events.push(e);
    window.addEventListener('newshacker:favoritesChanged', handler);
    try {
      addFavoriteId(1);
      removeFavoriteId(1);
      expect(events.length).toBe(2);
    } finally {
      window.removeEventListener('newshacker:favoritesChanged', handler);
    }
  });

  it('uses a separate storage key from saved stories', () => {
    addFavoriteId(42);
    expect(window.localStorage.getItem('newshacker:savedStoryIds')).toBeNull();
    expect(
      window.localStorage.getItem('newshacker:favoriteStoryIds'),
    ).toContain('"id":42');
  });

  it('exposes entries with timestamps for ordering', () => {
    addFavoriteId(1, 1000);
    addFavoriteId(2, 2000);
    const entries = getFavoriteEntries();
    const byId = new Map(entries.map((e) => [e.id, e.at]));
    expect(byId.get(1)).toBe(1000);
    expect(byId.get(2)).toBe(2000);
  });

  describe('tombstones for sync', () => {
    it('writes a tombstone on remove', () => {
      addFavoriteId(1, 1000);
      removeFavoriteId(1, 2000);
      expect(getFavoriteIds()).toEqual(new Set());
      expect(getAllFavoriteEntries()).toEqual([
        { id: 1, at: 2000, deleted: true },
      ]);
    });

    it('re-adding an id clears the tombstone', () => {
      addFavoriteId(1, 1000);
      removeFavoriteId(1, 2000);
      addFavoriteId(1, 3000);
      expect(getAllFavoriteEntries()).toEqual([{ id: 1, at: 3000 }]);
    });

    it('remove is a no-op if the id is already tombstoned', () => {
      addFavoriteId(1, 1000);
      removeFavoriteId(1, 2000);
      const events: Event[] = [];
      const handler = (e: Event) => events.push(e);
      window.addEventListener('newshacker:favoritesChanged', handler);
      try {
        removeFavoriteId(1, 3000);
      } finally {
        window.removeEventListener('newshacker:favoritesChanged', handler);
      }
      expect(events.length).toBe(0);
      expect(getAllFavoriteEntries()).toEqual([
        { id: 1, at: 2000, deleted: true },
      ]);
    });

    it('remove writes a tombstone even for an id that was never favorited', () => {
      removeFavoriteId(99, 5000);
      expect(getAllFavoriteEntries()).toEqual([
        { id: 99, at: 5000, deleted: true },
      ]);
    });

    it('getFavoriteEntries hides tombstones from UI code', () => {
      addFavoriteId(1, 1000);
      addFavoriteId(2, 2000);
      removeFavoriteId(1, 3000);
      expect(getFavoriteEntries()).toEqual([{ id: 2, at: 2000 }]);
    });
  });

  describe('replaceFavoriteEntries', () => {
    it('overwrites the list wholesale and fires one event', () => {
      addFavoriteId(1, 1000);
      const events: Event[] = [];
      const handler = (e: Event) => events.push(e);
      window.addEventListener('newshacker:favoritesChanged', handler);
      try {
        replaceFavoriteEntries([
          { id: 2, at: 2000 },
          { id: 3, at: 3000, deleted: true },
        ]);
      } finally {
        window.removeEventListener('newshacker:favoritesChanged', handler);
      }
      expect(events.length).toBe(1);
      expect(getFavoriteIds()).toEqual(new Set([2]));
      expect(getAllFavoriteEntries()).toEqual([
        { id: 2, at: 2000 },
        { id: 3, at: 3000, deleted: true },
      ]);
    });
  });
});
