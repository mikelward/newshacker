import type { QueryClient } from '@tanstack/react-query';
import type { HNItem } from './hn';
import { prefetchPinnedStory } from './pinnedStoryPrefetch';

// Score threshold above which we opportunistically warm the thread cache
// from the list view. A "trending" story on /top has >100 points within
// minutes; below that the tap-through rate isn't worth the extra requests.
export const FEED_PREFETCH_SCORE_THRESHOLD = 100;

// Warm React Query's caches for a story the user is very likely to tap
// next (i.e. currently trending on the feed they're looking at).
//
// Uses the same prefetch shape as pin-time — item root, top-level
// comments, article summary, comments summary — so a drive-by warm
// from the feed lands the thread at tap-time indistinguishable from a
// previously pinned read. Keeping the two code paths in sync means
// behavior doesn't drift between "I pinned this" and "this was
// already hot on /top".
//
// Idempotent: skips if `['itemRoot', id]` is already cached, so
// re-rendering the feed row does not re-fetch. Callers are still
// expected to de-dupe per session (see StoryList's `warmedIdsRef`)
// to avoid the `prefetchPinnedStory` summary-prefetch paths firing
// repeatedly while the item root is still in flight.
export function prefetchFeedStory(
  client: QueryClient,
  story: Pick<HNItem, 'id' | 'url'>,
): void {
  if (client.getQueryData(['itemRoot', story.id]) !== undefined) return;
  prefetchPinnedStory(client, story);
}
