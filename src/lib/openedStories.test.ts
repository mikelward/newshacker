import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OPENED_STORY_TTL_MS,
  addOpenedId,
  clearOpenedIds,
  getArticleOpenedIds,
  getCommentsAt,
  getCommentsOpenedIds,
  getOpenedEntries,
  getOpenedIds,
  getSeenCommentCounts,
  markArticleOpenedId,
  markCommentsOpenedId,
  markCommentsSeenCount,
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
    window.localStorage.setItem('newshacker:openedStoryIds', 'not json');
    expect(getOpenedIds()).toEqual(new Set());
  });

  it('ignores entries that are not the expected shape', () => {
    window.localStorage.setItem(
      'newshacker:openedStoryIds',
      JSON.stringify([1, 2, { id: 3, at: Date.now() }]),
    );
    expect(getOpenedIds()).toEqual(new Set([3]));
  });

  it('ignores storage data that is not an array', () => {
    window.localStorage.setItem(
      'newshacker:openedStoryIds',
      JSON.stringify({ id: 1, at: Date.now() }),
    );
    expect(getOpenedIds()).toEqual(new Set());
  });

  it('does not collide with the hiddenStories key', () => {
    addOpenedId(5);
    expect(
      window.localStorage.getItem('newshacker:hiddenStoryIds'),
    ).toBeNull();
    expect(
      window.localStorage.getItem('newshacker:openedStoryIds'),
    ).toBeTruthy();
  });

  it('dispatches a change event on add and remove', () => {
    const events: Event[] = [];
    const handler = (e: Event) => events.push(e);
    window.addEventListener('newshacker:openedStoriesChanged', handler);
    try {
      addOpenedId(1);
      removeOpenedId(1);
      expect(events.length).toBe(2);
    } finally {
      window.removeEventListener('newshacker:openedStoriesChanged', handler);
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
        'newshacker:openedStoryIds',
        JSON.stringify([{ id: 9, at: Date.now() }]),
      );
      expect(getArticleOpenedIds()).toEqual(new Set([9]));
      expect(getCommentsOpenedIds()).toEqual(new Set([9]));
    });
  });

  describe('seen comment count snapshotting', () => {
    it('stores the count passed to markCommentsOpenedId', () => {
      markCommentsOpenedId(1, Date.now(), 12);
      expect(getSeenCommentCounts().get(1)).toBe(12);
    });

    it('stores zero explicitly', () => {
      markCommentsOpenedId(1, Date.now(), 0);
      expect(getSeenCommentCounts().get(1)).toBe(0);
    });

    it('omits the id when no count has ever been recorded', () => {
      markCommentsOpenedId(1);
      expect(getSeenCommentCounts().has(1)).toBe(false);
    });

    it('updates the snapshot when the thread is re-opened', () => {
      markCommentsOpenedId(1, Date.now(), 3);
      markCommentsOpenedId(1, Date.now(), 8);
      expect(getSeenCommentCounts().get(1)).toBe(8);
    });

    it('keeps the prior snapshot when the article half is opened later', () => {
      markCommentsOpenedId(1, Date.now(), 3);
      markArticleOpenedId(1);
      expect(getSeenCommentCounts().get(1)).toBe(3);
    });

    it('addOpenedId also records the snapshot', () => {
      addOpenedId(1, Date.now(), 7);
      expect(getSeenCommentCounts().get(1)).toBe(7);
    });
  });

  describe('markCommentsSeenCount (count without touching commentsAt)', () => {
    it('records the seen count without setting commentsAt', () => {
      markCommentsSeenCount(1, 5);
      expect(getSeenCommentCounts().get(1)).toBe(5);
      expect(getCommentsAt(1)).toBeUndefined();
      expect(getCommentsOpenedIds().has(1)).toBe(false);
    });

    it('updates the seen count on a subsequent call', () => {
      markCommentsSeenCount(1, 3);
      markCommentsSeenCount(1, 11);
      expect(getSeenCommentCounts().get(1)).toBe(11);
    });

    it('leaves an existing commentsAt intact when called after markCommentsOpenedId', () => {
      const then = Date.now() - 1000;
      markCommentsOpenedId(1, then, 2);
      markCommentsSeenCount(1, 9);
      expect(getCommentsAt(1)).toBe(then);
      expect(getSeenCommentCounts().get(1)).toBe(9);
    });

    it('does not collide with articleAt', () => {
      markArticleOpenedId(1);
      markCommentsSeenCount(1, 4);
      expect(getArticleOpenedIds().has(1)).toBe(true);
      expect(getCommentsOpenedIds().has(1)).toBe(false);
    });

    it('dispatches a change event so subscribers re-render', () => {
      const events: Event[] = [];
      const handler = (e: Event) => events.push(e);
      window.addEventListener('newshacker:openedStoriesChanged', handler);
      try {
        markCommentsSeenCount(1, 4);
        expect(events.length).toBe(1);
      } finally {
        window.removeEventListener(
          'newshacker:openedStoriesChanged',
          handler,
        );
      }
    });
  });

  describe('getCommentsAt', () => {
    it('returns undefined when the story has never been opened', () => {
      expect(getCommentsAt(999)).toBeUndefined();
    });

    it('returns the commentsAt value set by markCommentsOpenedId', () => {
      const then = Date.now() - 5000;
      markCommentsOpenedId(5, then, 3);
      expect(getCommentsAt(5)).toBe(then);
    });

    it('returns undefined when only the article has been opened', () => {
      markArticleOpenedId(5);
      expect(getCommentsAt(5)).toBeUndefined();
    });

    it('returns undefined when only the seen count has been recorded', () => {
      markCommentsSeenCount(5, 2);
      expect(getCommentsAt(5)).toBeUndefined();
    });
  });
});
