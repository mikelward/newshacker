import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HIDDEN_STORY_TTL_MS,
  addHiddenId,
  clearHiddenIds,
  getHiddenIds,
  removeHiddenId,
} from './hiddenStories';

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
      window.removeEventListener('newshacker:hiddenStoriesChanged', handler);
    }
  });
});
