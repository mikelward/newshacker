import type { QueryClient } from '@tanstack/react-query';
import type { HNItem } from './hn';
import { getItem, getItems } from './hn';
import { summaryQueryOptions, SUMMARY_RETENTION_MS } from '../hooks/useSummary';
import { commentsSummaryQueryOptions } from '../hooks/useCommentsSummary';
import { prefetchCommentBatch } from './commentPrefetch';
import { getPinnedIds } from './pinnedStories';
import { lockPinnedQueryGcTime } from './pinnedQueryRetention';

type PinnedStoryPrefetchInput = Pick<HNItem, 'id' | 'url'> & Partial<HNItem>;

function hasStoryPayload(story: PinnedStoryPrefetchInput): boolean {
  return (
    story.type !== undefined ||
    story.title !== undefined ||
    story.text !== undefined ||
    story.by !== undefined ||
    story.score !== undefined ||
    story.descendants !== undefined ||
    story.dead !== undefined ||
    story.deleted !== undefined
  );
}

function seedItemRootFromStory(
  client: QueryClient,
  story: PinnedStoryPrefetchInput,
): void {
  if (!hasStoryPayload(story)) return;
  if (client.getQueryData(['itemRoot', story.id]) !== undefined) return;
  const item: HNItem = { ...story, id: story.id };
  const kidIds = item.deleted || item.dead ? [] : (item.kids ?? []);
  client.setQueryData(['itemRoot', story.id], { item, kidIds });
  void client.invalidateQueries({
    queryKey: ['itemRoot', story.id],
    exact: true,
    refetchType: 'none',
  });
}

// When a user pins a story we try to make everything they'll need on the
// pinned page available without a second network trip: the item itself (for
// the title/domain/points row), the AI summary (article + comments), and the
// first page of top-level comments so offline readers see real discussion,
// not an empty thread. When the story is actually pinned (vs. a feed
// drive-by warm via prefetchFeedStory), the queries are locked at gcTime
// `Infinity` so they outlive the regular 7-day retention window and
// survive arbitrarily long offline gaps — the pinned cache is never
// evicted. See src/lib/pinnedQueryRetention.ts.
//
// The four prefetches all fire in parallel at the top level — we have
// `story.id` and `story.url` at pin-time without waiting for anything, so
// there's no reason for the comments-summary prefetch to sit behind the HN
// item fetch. Stories that happen to have no comments yet will get a cheap
// edge 404 from /api/comments-summary, which is a fair trade for removing
// ~100ms from the common case.
export function prefetchPinnedStory(
  client: QueryClient,
  story: PinnedStoryPrefetchInput,
): void {
  // Pin state is consulted at call time. Feed warmers reuse this helper
  // for non-pinned trending rows (see prefetchFeedStory) and must keep
  // the 7-day retention; only the genuinely-pinned path opts into the
  // never-evict gcTime.
  const isPinned = getPinnedIds().has(story.id);
  const gcTime = isPinned ? Number.POSITIVE_INFINITY : SUMMARY_RETENTION_MS;

  seedItemRootFromStory(client, story);
  client.prefetchQuery({
    queryKey: ['itemRoot', story.id],
    queryFn: async ({ signal }) => {
      const item = await getItem(story.id, signal);
      if (!item) return null;
      const kidIds = item.deleted || item.dead ? [] : (item.kids ?? []);
      // Fire-and-forget: warm the top-level comment cache using the ids
      // we just got from the root. prefetchCommentBatch batches via
      // /api/items so a 30-comment warm is one HTTP request. Needs the
      // kidIds so it stays nested inside the item fetch.
      prefetchCommentBatch(client, kidIds, getItems, undefined, gcTime);
      return { item, kidIds };
    },
    staleTime: SUMMARY_RETENTION_MS,
    gcTime,
  });
  client.prefetchQuery({ ...commentsSummaryQueryOptions(story.id), gcTime });
  if (story.url) {
    client.prefetchQuery({ ...summaryQueryOptions(story.id), gcTime });
  }
  if (isPinned) {
    // prefetchQuery only flows new options to an existing query when it
    // actually triggers a fetch (staleTime not satisfied). For pin-then-
    // re-pin or pin-after-feed-warm flows the data is already fresh and
    // the prefetch is a no-op, so the existing cache entry would keep
    // its 7-day gcTime. Lock it explicitly here so every code path lands
    // at Infinity. Idempotent.
    lockPinnedQueryGcTime(client, story.id);
  }
}
