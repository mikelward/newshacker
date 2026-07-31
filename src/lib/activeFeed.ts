import type { Feed } from './feeds';

// The feed the reader most recently viewed — Top/New/Best/Ask/Show/Jobs or
// `'hot'` for the `/hot` route. `<FeedKeepWarm>` (mounted above the router)
// subscribes to this so it can hold an observer on that feed's React Query
// queries even while the reader is off on a thread page.
//
// Why this exists: React Query aborts a query's in-flight fetch the moment
// its *last* observer unmounts (verified — the fetch's AbortSignal fires and
// the resolved value is discarded). Opening a story unmounts the feed, so a
// refresh kicked on open (see `FeedItemsState.refreshStale`) would be
// cancelled before it lands and the list wouldn't be ready on return. Keeping
// a second, render-less observer alive across navigation prevents the abort,
// so the on-open refresh completes while the reader is in the thread.
export type ActiveFeed = Feed | 'hot';

let current: ActiveFeed | null = null;
const listeners = new Set<() => void>();

export function setActiveFeed(feed: ActiveFeed): void {
  if (current === feed) return;
  current = feed;
  for (const listener of listeners) listener();
}

export function getActiveFeed(): ActiveFeed | null {
  return current;
}

export function subscribeActiveFeed(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Test-only: reset the module singleton between tests so a feed set in one
// test doesn't leak into the next.
export function _resetActiveFeedForTests(): void {
  current = null;
  listeners.clear();
}
