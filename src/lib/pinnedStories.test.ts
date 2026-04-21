import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addPinnedId,
  clearPinnedIds,
  getAllPinnedEntries,
  getPinnedEntries,
  getPinnedIds,
  removePinnedId,
  replacePinnedEntries,
} from './pinnedStories';

describe('pinnedStories', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns an empty set when nothing is stored', () => {
    expect(getPinnedIds()).toEqual(new Set());
  });

  it('adds and retrieves pinned ids', () => {
    addPinnedId(1);
    addPinnedId(2);
    expect(getPinnedIds()).toEqual(new Set([1, 2]));
  });

  it('does not duplicate an id that is added twice', () => {
    addPinnedId(1);
    addPinnedId(1);
    expect(getPinnedIds().size).toBe(1);
  });

  it('removes ids', () => {
    addPinnedId(1);
    addPinnedId(2);
    removePinnedId(1);
    expect(getPinnedIds()).toEqual(new Set([2]));
  });

  it('clears all ids', () => {
    addPinnedId(1);
    addPinnedId(2);
    clearPinnedIds();
    expect(getPinnedIds()).toEqual(new Set());
  });

  it('does not expire entries over time (pins are permanent until unpinned)', () => {
    const ancient = 1;
    addPinnedId(1, ancient);
    expect(getPinnedIds()).toEqual(new Set([1]));
    const entries = getPinnedEntries();
    expect(entries).toEqual([{ id: 1, at: ancient }]);
  });

  it('refreshes the timestamp when an id is re-added', () => {
    addPinnedId(1, 1000);
    addPinnedId(1, 2000);
    const entries = getPinnedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ id: 1, at: 2000 });
  });

  it('ignores malformed storage data', () => {
    window.localStorage.setItem('newshacker:pinnedStoryIds', 'not json');
    expect(getPinnedIds()).toEqual(new Set());
  });

  it('ignores entries that are not the expected shape', () => {
    window.localStorage.setItem(
      'newshacker:pinnedStoryIds',
      JSON.stringify([1, 2, { id: 3, at: Date.now() }]),
    );
    expect(getPinnedIds()).toEqual(new Set([3]));
  });

  it('dispatches a change event on add and remove', () => {
    const events: Event[] = [];
    const handler = (e: Event) => events.push(e);
    window.addEventListener('newshacker:pinnedStoriesChanged', handler);
    try {
      addPinnedId(1);
      removePinnedId(1);
      expect(events.length).toBe(2);
    } finally {
      window.removeEventListener(
        'newshacker:pinnedStoriesChanged',
        handler,
      );
    }
  });

  it('exposes entries with timestamps for ordering', () => {
    addPinnedId(1, 1000);
    addPinnedId(2, 2000);
    const entries = getPinnedEntries();
    const byId = new Map(entries.map((e) => [e.id, e.at]));
    expect(byId.get(1)).toBe(1000);
    expect(byId.get(2)).toBe(2000);
  });

  describe('tombstones for sync', () => {
    it('writes a tombstone on remove instead of dropping the entry', () => {
      addPinnedId(1, 1000);
      removePinnedId(1, 2000);
      expect(getPinnedIds()).toEqual(new Set());
      const all = getAllPinnedEntries();
      expect(all).toEqual([{ id: 1, at: 2000, deleted: true }]);
    });

    it('re-adding an id clears the tombstone', () => {
      addPinnedId(1, 1000);
      removePinnedId(1, 2000);
      addPinnedId(1, 3000);
      const all = getAllPinnedEntries();
      expect(all).toEqual([{ id: 1, at: 3000 }]);
    });

    it('remove is a no-op if the id is already tombstoned', () => {
      addPinnedId(1, 1000);
      removePinnedId(1, 2000);
      const events: Event[] = [];
      const handler = (e: Event) => events.push(e);
      window.addEventListener('newshacker:pinnedStoriesChanged', handler);
      try {
        removePinnedId(1, 3000);
      } finally {
        window.removeEventListener(
          'newshacker:pinnedStoriesChanged',
          handler,
        );
      }
      expect(events.length).toBe(0);
      const all = getAllPinnedEntries();
      expect(all).toEqual([{ id: 1, at: 2000, deleted: true }]);
    });

    it('remove writes a tombstone even for an id that was never pinned', () => {
      // Sync scenario: another device had the pin; we never pulled it
      // locally, but the user triggers "unpin" from a surfaced UI. The
      // tombstone is what prevents that ghost pin from reappearing on
      // the next sync round.
      removePinnedId(99, 5000);
      const all = getAllPinnedEntries();
      expect(all).toEqual([{ id: 99, at: 5000, deleted: true }]);
    });

    it('getPinnedEntries hides tombstones from UI code', () => {
      addPinnedId(1, 1000);
      addPinnedId(2, 2000);
      removePinnedId(1, 3000);
      expect(getPinnedEntries()).toEqual([{ id: 2, at: 2000 }]);
    });
  });

  describe('replacePinnedEntries', () => {
    it('overwrites the local list wholesale and fires one event', () => {
      addPinnedId(1, 1000);
      const events: Event[] = [];
      const handler = (e: Event) => events.push(e);
      window.addEventListener('newshacker:pinnedStoriesChanged', handler);
      try {
        replacePinnedEntries([
          { id: 2, at: 2000 },
          { id: 3, at: 3000, deleted: true },
        ]);
      } finally {
        window.removeEventListener(
          'newshacker:pinnedStoriesChanged',
          handler,
        );
      }
      expect(events.length).toBe(1);
      expect(getPinnedIds()).toEqual(new Set([2]));
      expect(getAllPinnedEntries()).toEqual([
        { id: 2, at: 2000 },
        { id: 3, at: 3000, deleted: true },
      ]);
    });
  });

  describe('legacy savedStoryIds migration', () => {
    it('migrates an existing savedStoryIds payload to pinnedStoryIds on first read', () => {
      const legacy = JSON.stringify([
        { id: 11, at: 1000 },
        { id: 22, at: 2000 },
      ]);
      window.localStorage.setItem('newshacker:savedStoryIds', legacy);

      expect(getPinnedIds()).toEqual(new Set([11, 22]));
      expect(window.localStorage.getItem('newshacker:savedStoryIds')).toBeNull();
      expect(window.localStorage.getItem('newshacker:pinnedStoryIds')).toBe(
        legacy,
      );
    });

    it('does not overwrite an existing pinnedStoryIds list with the legacy one', () => {
      const legacy = JSON.stringify([{ id: 99, at: 1 }]);
      const current = JSON.stringify([{ id: 7, at: 2 }]);
      window.localStorage.setItem('newshacker:savedStoryIds', legacy);
      window.localStorage.setItem('newshacker:pinnedStoryIds', current);

      expect(getPinnedIds()).toEqual(new Set([7]));
      // Legacy is left in place when the new key already exists, so we don't
      // silently clobber the user's choice; another module / older client can
      // still read it if it needs to.
      expect(window.localStorage.getItem('newshacker:savedStoryIds')).toBe(
        legacy,
      );
    });

    it('does nothing when there is no legacy data', () => {
      expect(getPinnedIds()).toEqual(new Set());
      expect(window.localStorage.getItem('newshacker:savedStoryIds')).toBeNull();
      expect(
        window.localStorage.getItem('newshacker:pinnedStoryIds'),
      ).toBeNull();
    });
  });
});
