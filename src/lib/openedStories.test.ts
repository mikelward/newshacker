import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OPENED_STORY_TTL_MS,
  addOpenedId,
  clearOpenedIds,
  getArticleOpenedIds,
  getCommentsOpenedIds,
  getOpenedEntries,
  getOpenedIds,
  markArticleOpenedId,
  markCommentsOpenedId,
  removeOpenedId,
} from './openedStories';

describe('openedStories', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns an empty set when nothing is stored', () => {
    expect(getOpenedIds()).toEqual(new Set());
  });

  it('adds and retrieves opened ids', () => {
    addOpenedId(1);
    addOpenedId(2);
    expect(getOpenedIds()).toEqual(new Set([1, 2]));
  });

  it('does not duplicate an id that is added twice', () => {
    addOpenedId(1);
    addOpenedId(1);
    expect(getOpenedIds().size).toBe(1);
  });

  it('removes ids', () => {
    addOpenedId(1);
    addOpenedId(2);
    removeOpenedId(1);
    expect(getOpenedIds()).toEqual(new Set([2]));
  });

  it('clears all ids', () => {
    addOpenedId(1);
    addOpenedId(2);
    clearOpenedIds();
    expect(getOpenedIds()).toEqual(new Set());
  });

  it('expires entries older than the TTL', () => {
    const now = 1_000_000_000_000;
    addOpenedId(1, now - OPENED_STORY_TTL_MS - 1);
    addOpenedId(2, now - 1000);
    expect(getOpenedIds(now)).toEqual(new Set([2]));
  });

  it('refreshes the timestamp when an id is re-added', () => {
    const now = 1_000_000_000_000;
    addOpenedId(1, now - OPENED_STORY_TTL_MS - 1);
    addOpenedId(1, now);
    expect(getOpenedIds(now)).toEqual(new Set([1]));
  });

  it('ignores malformed storage data', () => {
    window.localStorage.setItem('hnews:openedStoryIds', 'not json');
    expect(getOpenedIds()).toEqual(new Set());
  });

  it('ignores entries that are not the expected shape', () => {
    window.localStorage.setItem(
      'hnews:openedStoryIds',
      JSON.stringify([1, 2, { id: 3, at: Date.now() }]),
    );
    expect(getOpenedIds()).toEqual(new Set([3]));
  });

  it('ignores storage data that is not an array', () => {
    window.localStorage.setItem(
      'hnews:openedStoryIds',
      JSON.stringify({ id: 1, at: Date.now() }),
    );
    expect(getOpenedIds()).toEqual(new Set());
  });

  it('does not collide with the dismissedStories key', () => {
    addOpenedId(5);
    expect(
      window.localStorage.getItem('hnews:dismissedStoryIds'),
    ).toBeNull();
    expect(
      window.localStorage.getItem('hnews:openedStoryIds'),
    ).toBeTruthy();
  });

  it('dispatches a change event on add and remove', () => {
    const events: Event[] = [];
    const handler = (e: Event) => events.push(e);
    window.addEventListener('hnews:openedStoriesChanged', handler);
    try {
      addOpenedId(1);
      removeOpenedId(1);
      expect(events.length).toBe(2);
    } finally {
      window.removeEventListener('hnews:openedStoriesChanged', handler);
    }
  });

  it('exposes entries sorted by insertion for ordering', () => {
    const now = 1_000_000_000_000;
    addOpenedId(1, now - 2000);
    addOpenedId(2, now - 1000);
    const entries = getOpenedEntries(now);
    const byId = new Map(entries.map((e) => [e.id, e.at]));
    expect(byId.get(1)).toBe(now - 2000);
    expect(byId.get(2)).toBe(now - 1000);
  });

  describe('per-kind tracking', () => {
    it('markArticleOpenedId only marks the article half', () => {
      markArticleOpenedId(1);
      expect(getArticleOpenedIds()).toEqual(new Set([1]));
      expect(getCommentsOpenedIds()).toEqual(new Set());
      expect(getOpenedIds()).toEqual(new Set([1]));
    });

    it('markCommentsOpenedId only marks the comments half', () => {
      markCommentsOpenedId(1);
      expect(getCommentsOpenedIds()).toEqual(new Set([1]));
      expect(getArticleOpenedIds()).toEqual(new Set());
      expect(getOpenedIds()).toEqual(new Set([1]));
    });

    it('marking both halves separately keeps both set', () => {
      markArticleOpenedId(1);
      markCommentsOpenedId(1);
      expect(getArticleOpenedIds()).toEqual(new Set([1]));
      expect(getCommentsOpenedIds()).toEqual(new Set([1]));
    });

    it('addOpenedId sets both halves', () => {
      addOpenedId(1);
      expect(getArticleOpenedIds()).toEqual(new Set([1]));
      expect(getCommentsOpenedIds()).toEqual(new Set([1]));
    });

    it('refreshes only the kind being marked', () => {
      const now = 1_000_000_000_000;
      markArticleOpenedId(1, now - 1000);
      markCommentsOpenedId(1, now);
      const entries = getOpenedEntries(now);
      const e = entries.find((x) => x.id === 1)!;
      expect(e.articleAt).toBe(now - 1000);
      expect(e.commentsAt).toBe(now);
      expect(e.at).toBe(now);
    });

    it('removeOpenedId clears both halves', () => {
      markArticleOpenedId(1);
      markCommentsOpenedId(1);
      removeOpenedId(1);
      expect(getArticleOpenedIds()).toEqual(new Set());
      expect(getCommentsOpenedIds()).toEqual(new Set());
    });

    it('reads legacy {id, at} entries as if both halves were opened', () => {
      window.localStorage.setItem(
        'hnews:openedStoryIds',
        JSON.stringify([{ id: 9, at: Date.now() }]),
      );
      expect(getArticleOpenedIds()).toEqual(new Set([9]));
      expect(getCommentsOpenedIds()).toEqual(new Set([9]));
    });
  });
});
