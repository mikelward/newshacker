import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addDoneId,
  clearDoneIds,
  getAllDoneEntries,
  getDoneEntries,
  getDoneIds,
  removeDoneId,
  replaceDoneEntries,
} from './doneStories';

describe('doneStories', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns an empty set when nothing is stored', () => {
    expect(getDoneIds()).toEqual(new Set());
  });

  it('adds and retrieves done ids', () => {
    addDoneId(1);
    addDoneId(2);
    expect(getDoneIds()).toEqual(new Set([1, 2]));
  });

  it('does not duplicate an id that is added twice', () => {
    addDoneId(1);
    addDoneId(1);
    expect(getDoneIds().size).toBe(1);
  });

  it('removes ids', () => {
    addDoneId(1);
    addDoneId(2);
    removeDoneId(1);
    expect(getDoneIds()).toEqual(new Set([2]));
  });

  it('clears all ids', () => {
    addDoneId(1);
    addDoneId(2);
    clearDoneIds();
    expect(getDoneIds()).toEqual(new Set());
  });

  it('does not expire entries over time (done is permanent until removed)', () => {
    const ancient = 1;
    addDoneId(1, ancient);
    expect(getDoneIds()).toEqual(new Set([1]));
    const entries = getDoneEntries();
    expect(entries).toEqual([{ id: 1, at: ancient }]);
  });

  it('refreshes the timestamp when an id is re-added', () => {
    addDoneId(1, 1000);
    addDoneId(1, 2000);
    const entries = getDoneEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ id: 1, at: 2000 });
  });

  it('ignores malformed storage data', () => {
    window.localStorage.setItem('newshacker:doneStoryIds', 'not json');
    expect(getDoneIds()).toEqual(new Set());
  });

  it('ignores entries that are not the expected shape', () => {
    window.localStorage.setItem(
      'newshacker:doneStoryIds',
      JSON.stringify([1, 2, { id: 3, at: Date.now() }]),
    );
    expect(getDoneIds()).toEqual(new Set([3]));
  });

  it('dispatches a change event on add and remove', () => {
    const events: Event[] = [];
    const handler = (e: Event) => events.push(e);
    window.addEventListener('newshacker:doneStoriesChanged', handler);
    try {
      addDoneId(1);
      removeDoneId(1);
      expect(events.length).toBe(2);
    } finally {
      window.removeEventListener('newshacker:doneStoriesChanged', handler);
    }
  });

  it('uses its own storage key', () => {
    addDoneId(42);
    expect(window.localStorage.getItem('newshacker:pinnedStoryIds')).toBeNull();
    expect(
      window.localStorage.getItem('newshacker:favoriteStoryIds'),
    ).toBeNull();
    expect(window.localStorage.getItem('newshacker:hiddenStoryIds')).toBeNull();
    expect(
      window.localStorage.getItem('newshacker:doneStoryIds'),
    ).toContain('"id":42');
  });

  it('exposes entries with timestamps for ordering', () => {
    addDoneId(1, 1000);
    addDoneId(2, 2000);
    const entries = getDoneEntries();
    const byId = new Map(entries.map((e) => [e.id, e.at]));
    expect(byId.get(1)).toBe(1000);
    expect(byId.get(2)).toBe(2000);
  });

  describe('tombstones for sync', () => {
    it('writes a tombstone on remove', () => {
      addDoneId(1, 1000);
      removeDoneId(1, 2000);
      expect(getDoneIds()).toEqual(new Set());
      expect(getAllDoneEntries()).toEqual([
        { id: 1, at: 2000, deleted: true },
      ]);
    });

    it('re-adding an id clears the tombstone', () => {
      addDoneId(1, 1000);
      removeDoneId(1, 2000);
      addDoneId(1, 3000);
      expect(getAllDoneEntries()).toEqual([{ id: 1, at: 3000 }]);
    });

    it('remove is a no-op if the id is already tombstoned', () => {
      addDoneId(1, 1000);
      removeDoneId(1, 2000);
      const events: Event[] = [];
      const handler = (e: Event) => events.push(e);
      window.addEventListener('newshacker:doneStoriesChanged', handler);
      try {
        removeDoneId(1, 3000);
      } finally {
        window.removeEventListener('newshacker:doneStoriesChanged', handler);
      }
      expect(events.length).toBe(0);
      expect(getAllDoneEntries()).toEqual([
        { id: 1, at: 2000, deleted: true },
      ]);
    });

    it('remove writes a tombstone even for an id that was never marked done', () => {
      removeDoneId(99, 5000);
      expect(getAllDoneEntries()).toEqual([
        { id: 99, at: 5000, deleted: true },
      ]);
    });

    it('getDoneEntries hides tombstones from UI code', () => {
      addDoneId(1, 1000);
      addDoneId(2, 2000);
      removeDoneId(1, 3000);
      expect(getDoneEntries()).toEqual([{ id: 2, at: 2000 }]);
    });
  });

  describe('replaceDoneEntries', () => {
    it('overwrites the list wholesale and fires one event', () => {
      addDoneId(1, 1000);
      const events: Event[] = [];
      const handler = (e: Event) => events.push(e);
      window.addEventListener('newshacker:doneStoriesChanged', handler);
      try {
        replaceDoneEntries([
          { id: 2, at: 2000 },
          { id: 3, at: 3000, deleted: true },
        ]);
      } finally {
        window.removeEventListener('newshacker:doneStoriesChanged', handler);
      }
      expect(events.length).toBe(1);
      expect(getDoneIds()).toEqual(new Set([2]));
      expect(getAllDoneEntries()).toEqual([
        { id: 2, at: 2000 },
        { id: 3, at: 3000, deleted: true },
      ]);
    });
  });
});
