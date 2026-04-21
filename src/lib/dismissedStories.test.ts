import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DISMISSED_STORY_TTL_MS,
  addDismissedId,
  clearDismissedIds,
  getAllDismissedEntries,
  getDismissedEntries,
  getDismissedIds,
  removeDismissedId,
  replaceDismissedEntries,
} from './dismissedStories';

describe('dismissedStories', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns an empty set when nothing is stored', () => {
    expect(getDismissedIds()).toEqual(new Set());
  });

  it('adds and retrieves dismissed ids', () => {
    addDismissedId(1);
    addDismissedId(2);
    expect(getDismissedIds()).toEqual(new Set([1, 2]));
  });

  it('does not duplicate an id that is added twice', () => {
    addDismissedId(1);
    addDismissedId(1);
    expect(getDismissedIds().size).toBe(1);
  });

  it('removes ids', () => {
    addDismissedId(1);
    addDismissedId(2);
    removeDismissedId(1);
    expect(getDismissedIds()).toEqual(new Set([2]));
  });

  it('clears all ids', () => {
    addDismissedId(1);
    addDismissedId(2);
    clearDismissedIds();
    expect(getDismissedIds()).toEqual(new Set());
  });

  it('expires entries older than the TTL', () => {
    const now = 1_000_000_000_000;
    addDismissedId(1, now - DISMISSED_STORY_TTL_MS - 1);
    addDismissedId(2, now - 1000);
    expect(getDismissedIds(now)).toEqual(new Set([2]));
  });

  it('refreshes the timestamp when an id is re-added', () => {
    const now = 1_000_000_000_000;
    addDismissedId(1, now - DISMISSED_STORY_TTL_MS - 1);
    addDismissedId(1, now);
    expect(getDismissedIds(now)).toEqual(new Set([1]));
  });

  it('ignores malformed storage data', () => {
    window.localStorage.setItem('newshacker:dismissedStoryIds', 'not json');
    expect(getDismissedIds()).toEqual(new Set());
  });

  it('ignores entries that are not the expected shape', () => {
    window.localStorage.setItem(
      'newshacker:dismissedStoryIds',
      JSON.stringify([1, 2, { id: 3, at: Date.now() }]),
    );
    expect(getDismissedIds()).toEqual(new Set([3]));
  });

  it('dispatches a change event on add and remove', () => {
    const events: Event[] = [];
    const handler = (e: Event) => events.push(e);
    window.addEventListener('newshacker:dismissedStoriesChanged', handler);
    try {
      addDismissedId(1);
      removeDismissedId(1);
      expect(events.length).toBe(2);
    } finally {
      window.removeEventListener(
        'newshacker:dismissedStoriesChanged',
        handler,
      );
    }
  });

  it('exposes entries with timestamps for ordering', () => {
    const now = 1_000_000_000_000;
    addDismissedId(1, now - 2000);
    addDismissedId(2, now - 1000);
    const entries = getDismissedEntries(now);
    expect(entries.map((e) => e.id).sort()).toEqual([1, 2]);
    const byId = new Map(entries.map((e) => [e.id, e.at]));
    expect(byId.get(1)).toBe(now - 2000);
    expect(byId.get(2)).toBe(now - 1000);
  });

  describe('tombstones for sync', () => {
    it('writes a tombstone on remove', () => {
      const now = 1_000_000_000_000;
      addDismissedId(1, now - 1000);
      removeDismissedId(1, now);
      expect(getDismissedIds(now)).toEqual(new Set());
      expect(getAllDismissedEntries(now)).toEqual([
        { id: 1, at: now, deleted: true },
      ]);
    });

    it('tombstones age out with the same TTL as live entries', () => {
      const now = 1_000_000_000_000;
      // Write a tombstone that's older than the TTL.
      removeDismissedId(1, now - DISMISSED_STORY_TTL_MS - 1);
      expect(getAllDismissedEntries(now)).toEqual([]);
    });

    it('re-adding an id clears the tombstone', () => {
      const now = 1_000_000_000_000;
      addDismissedId(1, now - 2000);
      removeDismissedId(1, now - 1000);
      addDismissedId(1, now);
      expect(getAllDismissedEntries(now)).toEqual([{ id: 1, at: now }]);
    });

    it('getDismissedEntries hides tombstones from UI code', () => {
      const now = 1_000_000_000_000;
      addDismissedId(1, now - 3000);
      addDismissedId(2, now - 2000);
      removeDismissedId(1, now - 1000);
      expect(getDismissedEntries(now)).toEqual([{ id: 2, at: now - 2000 }]);
    });
  });

  describe('replaceDismissedEntries', () => {
    it('overwrites the list wholesale and fires one event', () => {
      const now = 1_000_000_000_000;
      addDismissedId(1, now - 1000);
      const events: Event[] = [];
      const handler = (e: Event) => events.push(e);
      window.addEventListener(
        'newshacker:dismissedStoriesChanged',
        handler,
      );
      try {
        replaceDismissedEntries([
          { id: 2, at: now - 500 },
          { id: 3, at: now - 200, deleted: true },
        ]);
      } finally {
        window.removeEventListener(
          'newshacker:dismissedStoriesChanged',
          handler,
        );
      }
      expect(events.length).toBe(1);
      expect(getDismissedIds(now)).toEqual(new Set([2]));
      expect(getAllDismissedEntries(now)).toEqual([
        { id: 2, at: now - 500 },
        { id: 3, at: now - 200, deleted: true },
      ]);
    });
  });
});
