import type { QueryClient } from '@tanstack/react-query';
import type { HNItem } from './hn';
import { getItem, getItems } from './hn';
import { summaryQueryOptions, SUMMARY_RETENTION_MS } from '../hooks/useSummary';
import { commentsSummaryQueryOptions } from '../hooks/useCommentsSummary';
import { prefetchCommentBatch } from './commentPrefetch';

// When a user pins a story we try to make everything they'll need on the
// pinned page available without a second network trip: the item itself (for
// the title/domain/points row), the AI summary (article + comments), and the
// first page of top-level comments so offline readers see real discussion,
// not an empty thread. Everything rides the same 7-day persisted cache TTL
// as the pinned-ids list.
//
// The four prefetches all fire in parallel at the top level — we have
// `story.id` and `story.url` at pin-time without waiting for anything, so
// there's no reason for the comments-summary prefetch to sit behind the HN
// item fetch. Stories that happen to have no comments yet will get a cheap
// edge 404 from /api/comments-summary, which is a fair trade for removing
// ~100ms from the common case.
export function prefetchPinnedStory(
  client: QueryClient,
  story: Pick<HNItem, 'id' | 'url'>,
): void {
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
      prefetchCommentBatch(client, kidIds, getItems);
      return { item, kidIds };
    },
    staleTime: SUMMARY_RETENTION_MS,
    gcTime: SUMMARY_RETENTION_MS,
  });
  client.prefetchQuery(commentsSummaryQueryOptions(story.id));
  if (story.url) {
    client.prefetchQuery(summaryQueryOptions(story.id));
  }
}
