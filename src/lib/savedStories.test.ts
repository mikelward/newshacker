import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addSavedId,
  clearSavedIds,
  getSavedEntries,
  getSavedIds,
  removeSavedId,
} from './savedStories';

describe('savedStories', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns an empty set when nothing is stored', () => {
    expect(getSavedIds()).toEqual(new Set());
  });

  it('adds and retrieves saved ids', () => {
    addSavedId(1);
    addSavedId(2);
    expect(getSavedIds()).toEqual(new Set([1, 2]));
  });

  it('does not duplicate an id that is added twice', () => {
    addSavedId(1);
    addSavedId(1);
    expect(getSavedIds().size).toBe(1);
  });

  it('removes ids', () => {
    addSavedId(1);
    addSavedId(2);
    removeSavedId(1);
    expect(getSavedIds()).toEqual(new Set([2]));
  });

  it('clears all ids', () => {
    addSavedId(1);
    addSavedId(2);
    clearSavedIds();
    expect(getSavedIds()).toEqual(new Set());
  });

  it('does not expire entries over time (saves are permanent until unsaved)', () => {
    const ancient = 1; // epoch+1ms
    addSavedId(1, ancient);
    expect(getSavedIds()).toEqual(new Set([1]));
    const entries = getSavedEntries();
    expect(entries).toEqual([{ id: 1, at: ancient }]);
  });

  it('refreshes the timestamp when an id is re-added', () => {
    addSavedId(1, 1000);
    addSavedId(1, 2000);
    const entries = getSavedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ id: 1, at: 2000 });
  });

  it('ignores malformed storage data', () => {
    window.localStorage.setItem('newshacker:savedStoryIds', 'not json');
    expect(getSavedIds()).toEqual(new Set());
  });

  it('ignores entries that are not the expected shape', () => {
    window.localStorage.setItem(
      'newshacker:savedStoryIds',
      JSON.stringify([1, 2, { id: 3, at: Date.now() }]),
    );
    expect(getSavedIds()).toEqual(new Set([3]));
  });

  it('dispatches a change event on add and remove', () => {
    const events: Event[] = [];
    const handler = (e: Event) => events.push(e);
    window.addEventListener('newshacker:savedStoriesChanged', handler);
    try {
      addSavedId(1);
      removeSavedId(1);
      expect(events.length).toBe(2);
    } finally {
      window.removeEventListener(
        'newshacker:savedStoriesChanged',
        handler,
      );
    }
  });

  it('exposes entries with timestamps for ordering', () => {
    addSavedId(1, 1000);
    addSavedId(2, 2000);
    const entries = getSavedEntries();
    const byId = new Map(entries.map((e) => [e.id, e.at]));
    expect(byId.get(1)).toBe(1000);
    expect(byId.get(2)).toBe(2000);
  });
});
