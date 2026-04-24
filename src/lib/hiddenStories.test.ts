import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HIDDEN_STORY_TTL_MS,
  addHiddenId,
  clearHiddenIds,
  getAllHiddenEntries,
  getHiddenEntries,
  getHiddenIds,
  removeHiddenId,
  replaceHiddenEntries,
} from './hiddenStories';
import {
  addPinnedId,
  getAllPinnedEntries,
  getPinnedIds,
} from './pinnedStories';

describe('hiddenStories', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns an empty set when nothing is stored', () => {
    expect(getHiddenIds()).toEqual(new Set());
  });

  it('adds and retrieves hidden ids', () => {
    addHiddenId(1);
    addHiddenId(2);
    expect(getHiddenIds()).toEqual(new Set([1, 2]));
  });

  it('does not duplicate an id that is added twice', () => {
    addHiddenId(1);
    addHiddenId(1);
    expect(getHiddenIds().size).toBe(1);
  });

  it('removes ids', () => {
    addHiddenId(1);
    addHiddenId(2);
    removeHiddenId(1);
    expect(getHiddenIds()).toEqual(new Set([2]));
  });

  it('clears all ids', () => {
    addHiddenId(1);
    addHiddenId(2);
    clearHiddenIds();
    expect(getHiddenIds()).toEqual(new Set());
  });

  it('expires entries older than the TTL', () => {
    const now = 1_000_000_000_000;
    addHiddenId(1, now - HIDDEN_STORY_TTL_MS - 1);
    addHiddenId(2, now - 1000);
    expect(getHiddenIds(now)).toEqual(new Set([2]));
  });

  it('refreshes the timestamp when an id is re-added', () => {
    const now = 1_000_000_000_000;
    addHiddenId(1, now - HIDDEN_STORY_TTL_MS - 1);
    addHiddenId(1, now);
    expect(getHiddenIds(now)).toEqual(new Set([1]));
  });

  it('ignores malformed storage data', () => {
    window.localStorage.setItem('newshacker:hiddenStoryIds', 'not json');
    expect(getHiddenIds()).toEqual(new Set());
  });

  it('ignores entries that are not the expected shape', () => {
    window.localStorage.setItem(
      'newshacker:hiddenStoryIds',
      JSON.stringify([1, 2, { id: 3, at: Date.now() }]),
    );
    expect(getHiddenIds()).toEqual(new Set([3]));
  });

  it('dispatches a change event on add and remove', () => {
    const events: Event[] = [];
    const handler = (e: Event) => events.push(e);
    window.addEventListener('newshacker:hiddenStoriesChanged', handler);
    try {
      addHiddenId(1);
      removeHiddenId(1);
      expect(events.length).toBe(2);
    } finally {
      window.removeEventListener(
        'newshacker:hiddenStoriesChanged',
        handler,
      );
    }
  });

  it('exposes entries with timestamps for ordering', () => {
    const now = 1_000_000_000_000;
    addHiddenId(1, now - 2000);
    addHiddenId(2, now - 1000);
    const entries = getHiddenEntries(now);
    expect(entries.map((e) => e.id).sort()).toEqual([1, 2]);
    const byId = new Map(entries.map((e) => [e.id, e.at]));
    expect(byId.get(1)).toBe(now - 2000);
    expect(byId.get(2)).toBe(now - 1000);
  });

  describe('tombstones for sync', () => {
    it('writes a tombstone on remove', () => {
      const now = 1_000_000_000_000;
      addHiddenId(1, now - 1000);
      removeHiddenId(1, now);
      expect(getHiddenIds(now)).toEqual(new Set());
      expect(getAllHiddenEntries(now)).toEqual([
        { id: 1, at: now, deleted: true },
      ]);
    });

    it('tombstones age out with the same TTL as live entries', () => {
      const now = 1_000_000_000_000;
      // Write a tombstone that's older than the TTL.
      removeHiddenId(1, now - HIDDEN_STORY_TTL_MS - 1);
      expect(getAllHiddenEntries(now)).toEqual([]);
    });

    it('re-adding an id clears the tombstone', () => {
      const now = 1_000_000_000_000;
      addHiddenId(1, now - 2000);
      removeHiddenId(1, now - 1000);
      addHiddenId(1, now);
      expect(getAllHiddenEntries(now)).toEqual([{ id: 1, at: now }]);
    });

    it('getHiddenEntries hides tombstones from UI code', () => {
      const now = 1_000_000_000_000;
      addHiddenId(1, now - 3000);
      addHiddenId(2, now - 2000);
      removeHiddenId(1, now - 1000);
      expect(getHiddenEntries(now)).toEqual([{ id: 2, at: now - 2000 }]);
    });
  });

  describe('replaceHiddenEntries', () => {
    it('overwrites the list wholesale and fires one event', () => {
      const now = 1_000_000_000_000;
      addHiddenId(1, now - 1000);
      const events: Event[] = [];
      const handler = (e: Event) => events.push(e);
      window.addEventListener(
        'newshacker:hiddenStoriesChanged',
        handler,
      );
      try {
        replaceHiddenEntries([
          { id: 2, at: now - 500 },
          { id: 3, at: now - 200, deleted: true },
        ]);
      } finally {
        window.removeEventListener(
          'newshacker:hiddenStoriesChanged',
          handler,
        );
      }
      expect(events.length).toBe(1);
      expect(getHiddenIds(now)).toEqual(new Set([2]));
      expect(getAllHiddenEntries(now)).toEqual([
        { id: 2, at: now - 500 },
        { id: 3, at: now - 200, deleted: true },
      ]);
    });
  });

  describe('legacy key migration', () => {
    it('migrates the legacy newshacker:dismissedStoryIds key on first read', () => {
      const now = 1_000_000_000_000;
      window.localStorage.setItem(
        'newshacker:dismissedStoryIds',
        JSON.stringify([{ id: 42, at: now - 1000 }]),
      );
      expect(getHiddenIds(now)).toEqual(new Set([42]));
      expect(
        window.localStorage.getItem('newshacker:dismissedStoryIds'),
      ).toBeNull();
      expect(
        window.localStorage.getItem('newshacker:hiddenStoryIds'),
      ).not.toBeNull();
    });

    it('does not overwrite an existing new key with the legacy value', () => {
      const now = 1_000_000_000_000;
      window.localStorage.setItem(
        'newshacker:hiddenStoryIds',
        JSON.stringify([{ id: 1, at: now - 500 }]),
      );
      window.localStorage.setItem(
        'newshacker:dismissedStoryIds',
        JSON.stringify([{ id: 999, at: now - 1000 }]),
      );
      expect(getHiddenIds(now)).toEqual(new Set([1]));
    });
  });

  // TODO: delete this describe block together with
  // `migratePinHideCollisions` in hiddenStories.ts after 2026-05-15.
  describe('pin ∩ hidden one-shot migration', () => {
    it('drops the pin for ids that are live in hiddenIds (dismiss wins)', () => {
      addPinnedId(1);
      addPinnedId(2);
      addPinnedId(3);
      // Directly seed hidden storage without going through the
      // library, so the migration marker is unset when readRaw runs.
      window.localStorage.setItem(
        'newshacker:hiddenStoryIds',
        JSON.stringify([
          { id: 2, at: Date.now() },
          { id: 3, at: Date.now() },
        ]),
      );
      expect(getPinnedIds()).toEqual(new Set([1, 2, 3]));

      // First read of hidden triggers the migration.
      getHiddenIds();

      expect(getPinnedIds()).toEqual(new Set([1]));
      expect(
        window.localStorage.getItem(
          'newshacker:pinHideCollisionMigrated',
        ),
      ).toBe('true');
    });

    it('is a no-op on a fresh install (no pins, no hidden)', () => {
      getHiddenIds();
      expect(getAllPinnedEntries()).toEqual([]);
      expect(
        window.localStorage.getItem(
          'newshacker:pinHideCollisionMigrated',
        ),
      ).toBe('true');
    });

    it('does not drop a pin for an id that is only tombstoned in hidden', () => {
      addPinnedId(1);
      window.localStorage.setItem(
        'newshacker:hiddenStoryIds',
        JSON.stringify([{ id: 1, at: Date.now(), deleted: true }]),
      );
      getHiddenIds();
      expect(getPinnedIds().has(1)).toBe(true);
    });

    it('short-circuits on subsequent reads once the marker is set', () => {
      window.localStorage.setItem(
        'newshacker:pinHideCollisionMigrated',
        'true',
      );
      addPinnedId(1);
      window.localStorage.setItem(
        'newshacker:hiddenStoryIds',
        JSON.stringify([{ id: 1, at: Date.now() }]),
      );
      getHiddenIds();
      // Pin survives because the migration didn't run.
      expect(getPinnedIds().has(1)).toBe(true);
    });

    it('ignores expired hidden entries when deciding collisions', () => {
      // Story 1 was hidden 10 days ago (past the 7-day TTL) and
      // later pinned. The expired hide is a ghost that wouldn't
      // surface in the UI; the migration must not drop the pin
      // based on it. Reads prune in-memory but don't rewrite
      // localStorage, so the old entry can still be there.
      const now = Date.now();
      addPinnedId(1);
      window.localStorage.setItem(
        'newshacker:hiddenStoryIds',
        JSON.stringify([
          { id: 1, at: now - 10 * 24 * 60 * 60 * 1000 },
        ]),
      );
      getHiddenIds(now);
      expect(getPinnedIds().has(1)).toBe(true);
    });
  });
});
