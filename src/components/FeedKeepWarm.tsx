import { useSyncExternalStore } from 'react';
import type { Feed } from '../lib/feeds';
import {
  getActiveFeed,
  subscribeActiveFeed,
  type ActiveFeed,
} from '../lib/activeFeed';
import { useFeedItems } from '../hooks/useStoryList';
import { useHotFeedItems } from '../hooks/useHotFeedItems';
import { useHotThresholds } from '../hooks/useHotThresholds';
import { isHotStory } from '../lib/format';
import type { HNItem } from '../lib/hn';

// Render-less observer that keeps the most-recently-viewed feed's React Query
// queries alive while the reader is off on a thread page. Without it, opening
// a story unmounts the feed and React Query aborts the on-open background
// refresh (`FeedItemsState.refreshStale`) the instant the feed's last
// observer leaves — see `src/lib/activeFeed.ts` for the full rationale. This
// component is mounted once, above the router, so it never unmounts on
// navigation and its observer is the one that survives.
//
// It subscribes to whichever feed the reader last looked at (the feed views
// call `setActiveFeed` on mount). While the feed route is *also* mounted,
// both observers share the same query and React Query dedupes their fetches,
// so keeping-warm costs nothing extra there; the second observer only earns
// its keep once the feed route unmounts.
export function FeedKeepWarm() {
  const feed = useSyncExternalStore(
    subscribeActiveFeed,
    getActiveFeed,
    () => null,
  );
  if (feed === null) return null;
  if (feed === 'hot') return <HotKeepWarm />;
  return <StandardKeepWarm feed={feed} />;
}

// Standard feed observer (Top/New/Best/Ask/Show/Jobs). Calling the same
// `useFeedItems` hook the feed route uses keeps `['storyIds', feed]` and
// `['feedItems', feed]` observed with their real query functions — no
// duplicated fetch logic.
function StandardKeepWarm({ feed }: { feed: Feed }) {
  useFeedItems(feed);
  return null;
}

// `/hot` observer. Mirrors `HotStoryList`'s predicate (built fresh each
// render, closed over the current thresholds and wall clock) so it observes
// the same `['storyIds', 'top']`, `['storyIds', 'new']`, and
// `['feedItems', 'hot']` queries the route does.
function HotKeepWarm() {
  const { prefs: hotThresholds } = useHotThresholds();
  const hotNow = new Date();
  const hotPredicate = (item: HNItem) =>
    isHotStory(item, hotNow, hotThresholds);
  useHotFeedItems(hotPredicate);
  return null;
}

export type { ActiveFeed };
