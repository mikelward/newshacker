import { afterEach, describe, expect, it } from 'vitest';
import {
  appendMore,
  compact,
  getFeedSnapshot,
  materialize,
  removeId,
  setFeedSnapshot,
  _clearFeedSnapshotsForTests,
  type FeedSnapshot,
} from './feedSnapshot';

const allRenderable = () => true;

afterEach(() => {
  _clearFeedSnapshotsForTests();
});

describe('materialize', () => {
  it('puts pins in the top block and the rest in the body, in order', () => {
    const snap = materialize({
      pinnedTopIds: [99, 50],
      bodyCandidateIds: [1, 2, 3],
      now: 1000,
    });
    expect(snap.topPinIds).toEqual([99, 50]);
    expect(snap.bodyIds).toEqual([1, 2, 3]);
    expect(snap.materializedAt).toBe(1000);
  });

  it('never renders a pinned id in both blocks', () => {
    // Story 2 is both a pin and a feed candidate — it belongs to the top
    // block only, exactly once.
    const snap = materialize({
      pinnedTopIds: [2],
      bodyCandidateIds: [1, 2, 3],
      now: 0,
    });
    expect(snap.topPinIds).toEqual([2]);
    expect(snap.bodyIds).toEqual([1, 3]);
  });
});

describe('compact', () => {
  const base: FeedSnapshot = {
    topPinIds: [99],
    bodyIds: [1, 2, 3, 4],
    materializedAt: 500,
  };

  it('drops done and hidden rows and collapses, keeping order', () => {
    const next = compact(base, {
      doneIds: new Set([2]),
      hiddenIds: new Set([4]),
      isBodyRenderable: allRenderable,
    });
    expect(next.bodyIds).toEqual([1, 3]);
    expect(next.topPinIds).toEqual([99]);
  });

  it('drops a top pin the reader marked done', () => {
    const next = compact(base, {
      doneIds: new Set([99]),
      hiddenIds: new Set(),
      isBodyRenderable: allRenderable,
    });
    expect(next.topPinIds).toEqual([]);
  });

  it('does not reorder or add — a server pin stays put, no new rows appear', () => {
    // 3 is now pinned (from another device) but compact must NOT lift it
    // to the top; and candidate 5 is a brand-new article compact must NOT
    // introduce.
    const next = compact(base, {
      doneIds: new Set(),
      hiddenIds: new Set(),
      isBodyRenderable: allRenderable,
    });
    expect(next.bodyIds).toEqual([1, 2, 3, 4]);
    expect(next.topPinIds).toEqual([99]);
  });

  it('preserves the materialize clock (compact is not a full materialize)', () => {
    const next = compact(base, {
      doneIds: new Set([2]),
      hiddenIds: new Set(),
      isBodyRenderable: allRenderable,
    });
    expect(next.materializedAt).toBe(500);
  });

  it('drops a body row that lost renderable data', () => {
    const next = compact(base, {
      doneIds: new Set(),
      hiddenIds: new Set(),
      isBodyRenderable: (id) => id !== 3,
    });
    expect(next.bodyIds).toEqual([1, 2, 4]);
  });

  it('returns the same reference when nothing dropped', () => {
    const next = compact(base, {
      doneIds: new Set(),
      hiddenIds: new Set(),
      isBodyRenderable: allRenderable,
    });
    expect(next).toBe(base);
  });
});

describe('appendMore', () => {
  const base: FeedSnapshot = {
    topPinIds: [99],
    bodyIds: [1, 2],
    materializedAt: 0,
  };

  it('appends new candidates to the tail of the body', () => {
    const next = appendMore(base, [3, 4]);
    expect(next.bodyIds).toEqual([1, 2, 3, 4]);
    expect(next.topPinIds).toEqual([99]);
  });

  it('skips ids already placed in either block', () => {
    const next = appendMore(base, [2, 99, 3]);
    expect(next.bodyIds).toEqual([1, 2, 3]);
  });

  it('returns the same reference when there is nothing new', () => {
    const next = appendMore(base, [1, 2, 99]);
    expect(next).toBe(base);
  });
});

describe('removeId', () => {
  const base: FeedSnapshot = {
    topPinIds: [99],
    bodyIds: [1, 2, 3],
    materializedAt: 0,
  };

  it('removes an id from the body (own dismiss)', () => {
    expect(removeId(base, 2).bodyIds).toEqual([1, 3]);
  });

  it('removes an id from the top block', () => {
    expect(removeId(base, 99).topPinIds).toEqual([]);
  });

  it('returns the same reference when the id is absent', () => {
    expect(removeId(base, 404)).toBe(base);
  });
});

describe('per-session store', () => {
  it('round-trips a snapshot by feed and starts empty', () => {
    expect(getFeedSnapshot('top')).toBeNull();
    const snap: FeedSnapshot = { topPinIds: [], bodyIds: [1], materializedAt: 1 };
    setFeedSnapshot('top', snap);
    expect(getFeedSnapshot('top')).toBe(snap);
    expect(getFeedSnapshot('new')).toBeNull();
  });
});
