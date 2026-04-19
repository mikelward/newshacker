import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DISMISSED_STORY_TTL_MS,
  addDismissedId,
  clearDismissedIds,
  getDismissedEntries,
  getDismissedIds,
  removeDismissedId,
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
    window.localStorage.setItem('hnews:dismissedStoryIds', 'not json');
    expect(getDismissedIds()).toEqual(new Set());
  });

  it('ignores entries that are not the expected shape', () => {
    window.localStorage.setItem(
      'hnews:dismissedStoryIds',
      JSON.stringify([1, 2, { id: 3, at: Date.now() }]),
    );
    expect(getDismissedIds()).toEqual(new Set([3]));
  });

  it('dispatches a change event on add and remove', () => {
    const events: Event[] = [];
    const handler = (e: Event) => events.push(e);
    window.addEventListener('hnews:dismissedStoriesChanged', handler);
    try {
      addDismissedId(1);
      removeDismissedId(1);
      expect(events.length).toBe(2);
    } finally {
      window.removeEventListener(
        'hnews:dismissedStoriesChanged',
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
});
