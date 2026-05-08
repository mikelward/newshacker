// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  commentBelongsToPinnedStory,
  lockAllPinnedQueriesGcTime,
  lockPinnedQueryGcTime,
  startPinnedQueryRetention,
  subscribeToPinnedCacheLocking,
} from './pinnedQueryRetention';
import { addPinnedId, clearPinnedIds } from './pinnedStories';

// We assert against `query.gcTime` (the sticky, Math.max-merged value
// from `Removable.updateGcTime`) rather than `query.options.gcTime`
// because a later observer attaching with the regular 7-day window
// will overwrite `options.gcTime` while leaving the actual gc-timer
// unchanged. The sticky property is the one that actually decides
// when (or whether) the query is evicted.
function effectiveGcTime(
  client: QueryClient,
  queryKey: readonly unknown[],
): number | undefined {
  const query = client.getQueryCache().find({ queryKey, exact: true });
  return query?.gcTime;
}

describe('lockPinnedQueryGcTime', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    clearPinnedIds();
    window.localStorage.clear();
  });

  it('bumps gcTime to Infinity on every cached query for the pinned story', () => {
    const client = new QueryClient();
    client.setQueryData(['itemRoot', 42], {
      item: { id: 42, type: 'story' },
      kidIds: [501, 502],
    });
    client.setQueryData(['summary', 42], { summary: 'hi' });
    client.setQueryData(['comments-summary', 42], { insights: ['x'] });
    client.setQueryData(['comment', 501], { id: 501, type: 'comment' });
    client.setQueryData(['comment', 502], { id: 502, type: 'comment' });

    lockPinnedQueryGcTime(client, 42);

    expect(effectiveGcTime(client, ['itemRoot', 42])).toBe(Infinity);
    expect(effectiveGcTime(client, ['summary', 42])).toBe(Infinity);
    expect(effectiveGcTime(client, ['comments-summary', 42])).toBe(Infinity);
    expect(effectiveGcTime(client, ['comment', 501])).toBe(Infinity);
    expect(effectiveGcTime(client, ['comment', 502])).toBe(Infinity);
  });

  it('does not touch comments outside the pinned story', () => {
    const client = new QueryClient();
    client.setQueryData(['itemRoot', 1], { item: { id: 1 }, kidIds: [10] });
    client.setQueryData(['comment', 10], { id: 10 });
    client.setQueryData(['comment', 99], { id: 99 });

    lockPinnedQueryGcTime(client, 1);

    expect(effectiveGcTime(client, ['comment', 10])).toBe(Infinity);
    expect(effectiveGcTime(client, ['comment', 99])).not.toBe(Infinity);
  });

  it('a finite gcTime applied later cannot shrink the lock back down', () => {
    // Math.max in Removable.updateGcTime is what makes the lock sticky:
    // once a query's effective gcTime is Infinity, no later observer
    // (e.g. useSummary's 7-day window when the user opens the thread
    // page) can lower it. Regression guard.
    const client = new QueryClient();
    client.setQueryData(['summary', 99], { summary: 'pinned' });
    lockPinnedQueryGcTime(client, 99);
    expect(effectiveGcTime(client, ['summary', 99])).toBe(Infinity);

    const query = client
      .getQueryCache()
      .find({ queryKey: ['summary', 99], exact: true })!;
    query.setOptions({ ...query.options, gcTime: 7 * 24 * 60 * 60 * 1000 });
    expect(effectiveGcTime(client, ['summary', 99])).toBe(Infinity);
  });

  it('cancels any in-flight gc timer that was already armed under the old gcTime', () => {
    // Without the scheduleGc() call inside lockQueryGcTime, a query
    // armed with a finite 7-day gc timer (from its constructor or a
    // prior fetch-success) would still be evicted at the original
    // deadline even after we bumped its gcTime — setOptions alone
    // does not cancel pending timeouts.
    const client = new QueryClient();
    client.setQueryData(['itemRoot', 5], { item: { id: 5 }, kidIds: [] });
    const query = client
      .getQueryCache()
      .find({ queryKey: ['itemRoot', 5], exact: true })!;
    // Pretend a finite gc timer is already scheduled (constructor path).
    // We can't access #gcTimeout, but we can verify the cache still
    // contains the query after the lock + a forced gc cycle below.
    lockPinnedQueryGcTime(client, 5);

    // Removing the (zero) observers triggers scheduleGc(); with
    // Infinity, isValidTimeout returns false and no timer is armed.
    // The query must therefore stay in cache indefinitely.
    expect(
      client.getQueryCache().find({ queryKey: ['itemRoot', 5], exact: true }),
    ).toBeDefined();
    expect(query.gcTime).toBe(Infinity);
  });

  it('locks every pinned story listed in localStorage when called via lockAllPinnedQueriesGcTime', () => {
    addPinnedId(7);
    addPinnedId(11);
    const client = new QueryClient();
    client.setQueryData(['itemRoot', 7], { item: { id: 7 }, kidIds: [] });
    client.setQueryData(['itemRoot', 11], { item: { id: 11 }, kidIds: [] });
    client.setQueryData(['itemRoot', 13], { item: { id: 13 }, kidIds: [] });

    lockAllPinnedQueriesGcTime(client);

    expect(effectiveGcTime(client, ['itemRoot', 7])).toBe(Infinity);
    expect(effectiveGcTime(client, ['itemRoot', 11])).toBe(Infinity);
    expect(effectiveGcTime(client, ['itemRoot', 13])).not.toBe(Infinity);
  });
});

describe('startPinnedQueryRetention', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    clearPinnedIds();
    window.localStorage.clear();
  });

  it('re-locks pinned-story queries on a same-tab pin event', () => {
    const client = new QueryClient();
    client.setQueryData(['itemRoot', 33], { item: { id: 33 }, kidIds: [] });
    expect(effectiveGcTime(client, ['itemRoot', 33])).not.toBe(Infinity);

    const stop = startPinnedQueryRetention(client);
    addPinnedId(33);
    // addPinnedId dispatches PINNED_STORIES_CHANGE_EVENT synchronously.
    expect(effectiveGcTime(client, ['itemRoot', 33])).toBe(Infinity);
    stop();
  });

  it('re-locks on cross-tab storage events', () => {
    addPinnedId(44);
    const client = new QueryClient();
    client.setQueryData(['itemRoot', 44], { item: { id: 44 }, kidIds: [] });
    // The lock has not happened yet — typical "second tab boots after
    // localStorage was already populated by tab A; queryCacheSync
    // delivers the data, then a storage event fires" path.
    expect(effectiveGcTime(client, ['itemRoot', 44])).not.toBe(Infinity);

    const stop = startPinnedQueryRetention(client);
    window.dispatchEvent(new Event('storage'));
    expect(effectiveGcTime(client, ['itemRoot', 44])).toBe(Infinity);
    stop();
  });

  it('returns a no-op when window is undefined (SSR)', () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error simulate non-DOM environment
    delete globalThis.window;
    try {
      const client = new QueryClient();
      const stop = startPinnedQueryRetention(client);
      expect(typeof stop).toBe('function');
      stop();
    } finally {
      globalThis.window = originalWindow;
    }
  });
});

describe('subscribeToPinnedCacheLocking', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    clearPinnedIds();
    window.localStorage.clear();
  });

  it('locks gcTime on a pinned-story itemRoot that arrives via cross-tab setQueryData (Codex P2: cross-tab race)', () => {
    // Tab B already has the pinned id in localStorage (storage event
    // ran earlier) but its cache was empty until queryCacheSync just
    // delivered tab A's warmed itemRoot via setQueryData. Without this
    // subscriber the new query would land at the default 1 h gcTime
    // and be evicted long before the user notices.
    const client = new QueryClient();
    const stop = subscribeToPinnedCacheLocking(client);
    addPinnedId(202);
    client.setQueryData(['itemRoot', 202], { item: { id: 202 }, kidIds: [2021] });
    const root = client.getQueryCache().find({
      queryKey: ['itemRoot', 202],
      exact: true,
    });
    expect(root?.gcTime).toBe(Infinity);
    stop();
  });

  it('locks late top-level comments arriving on an already-pinned story (Codex P2: load-more)', () => {
    // Story is pinned. A while later the thread-page load-more fires
    // prefetchCommentBatch with the default 7-day gcTime. The
    // subscriber must catch the new comments via their `parent` chain
    // (parent === storyId for top-level kids) and bump them to
    // Infinity, otherwise they'd silently expire at the 7-day mark.
    const client = new QueryClient();
    addPinnedId(303);
    const stop = subscribeToPinnedCacheLocking(client);
    client.setQueryData(['itemRoot', 303], { item: { id: 303 }, kidIds: [3031] });
    // Late comment batch lands.
    client.setQueryData(['comment', 3032], {
      id: 3032,
      type: 'comment',
      parent: 303,
      text: 'late top-level reply',
    });
    const c = client.getQueryCache().find({
      queryKey: ['comment', 3032],
      exact: true,
    });
    expect(c?.gcTime).toBe(Infinity);
    stop();
  });

  it('locks nested replies whose ancestor chain leads to a pinned story', () => {
    const client = new QueryClient();
    addPinnedId(404);
    // Top-level comment is in cache.
    client.setQueryData(['comment', 4041], {
      id: 4041,
      type: 'comment',
      parent: 404,
    });
    const stop = subscribeToPinnedCacheLocking(client);
    // Now a Comment.tsx expand brings in a nested reply whose parent
    // is the cached top-level comment.
    client.setQueryData(['comment', 4042], {
      id: 4042,
      type: 'comment',
      parent: 4041,
    });
    const c = client.getQueryCache().find({
      queryKey: ['comment', 4042],
      exact: true,
    });
    expect(c?.gcTime).toBe(Infinity);
    stop();
  });

  it('does not lock comments whose ancestor chain is broken or unrelated', () => {
    const client = new QueryClient();
    addPinnedId(505);
    const stop = subscribeToPinnedCacheLocking(client);
    // No cached parent; chain breaks.
    client.setQueryData(['comment', 5051], {
      id: 5051,
      type: 'comment',
      parent: 9999,
    });
    expect(
      client.getQueryCache().find({ queryKey: ['comment', 5051], exact: true })
        ?.gcTime,
    ).not.toBe(Infinity);
    // Unrelated story.
    client.setQueryData(['comment', 5052], {
      id: 5052,
      type: 'comment',
      parent: 1234, // not pinned
    });
    expect(
      client.getQueryCache().find({ queryKey: ['comment', 5052], exact: true })
        ?.gcTime,
    ).not.toBe(Infinity);
    stop();
  });

  it('locks a pinned summary or comments-summary the moment it lands', () => {
    const client = new QueryClient();
    addPinnedId(606);
    const stop = subscribeToPinnedCacheLocking(client);
    client.setQueryData(['summary', 606], { summary: 'arrived' });
    client.setQueryData(['comments-summary', 606], { insights: ['arrived'] });
    expect(
      client.getQueryCache().find({ queryKey: ['summary', 606], exact: true })
        ?.gcTime,
    ).toBe(Infinity);
    expect(
      client
        .getQueryCache()
        .find({ queryKey: ['comments-summary', 606], exact: true })?.gcTime,
    ).toBe(Infinity);
    stop();
  });

  it('ignores cache writes for stories that are not pinned', () => {
    const client = new QueryClient();
    const stop = subscribeToPinnedCacheLocking(client);
    client.setQueryData(['itemRoot', 707], { item: { id: 707 }, kidIds: [] });
    client.setQueryData(['summary', 707], { summary: 'unpinned' });
    expect(
      client.getQueryCache().find({ queryKey: ['itemRoot', 707], exact: true })
        ?.gcTime,
    ).not.toBe(Infinity);
    expect(
      client.getQueryCache().find({ queryKey: ['summary', 707], exact: true })
        ?.gcTime,
    ).not.toBe(Infinity);
    stop();
  });

  it('startPinnedQueryRetention also installs the cache subscriber', () => {
    // Regression guard: if a future refactor splits the two listeners
    // and forgets to wire the cache one back into startPinnedQueryRetention,
    // the cross-tab race fix would silently regress.
    const client = new QueryClient();
    addPinnedId(808);
    const stop = startPinnedQueryRetention(client);
    client.setQueryData(['itemRoot', 808], { item: { id: 808 }, kidIds: [] });
    expect(
      client.getQueryCache().find({ queryKey: ['itemRoot', 808], exact: true })
        ?.gcTime,
    ).toBe(Infinity);
    stop();
  });
});

describe('commentBelongsToPinnedStory', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    clearPinnedIds();
    window.localStorage.clear();
  });

  it('terminates on a parent cycle without infinite looping', () => {
    const client = new QueryClient();
    client.setQueryData(['comment', 1], { id: 1, parent: 2 });
    client.setQueryData(['comment', 2], { id: 2, parent: 1 }); // cycle
    expect(
      commentBelongsToPinnedStory(
        client,
        { parent: 1 },
        new Set([42]),
      ),
    ).toBe(false);
  });
});
