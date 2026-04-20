import type { QueryClient } from '@tanstack/react-query';
import type { HNItem } from './hn';
import { getItem, getItems } from './hn';
import { summaryQueryOptions, SUMMARY_CACHE_TTL_MS } from '../hooks/useSummary';
import { commentsSummaryQueryOptions } from '../hooks/useCommentsSummary';
import { prefetchCommentBatch } from './commentPrefetch';

// When a user pins a story we try to make everything they'll need on the
// pinned page available without a second network trip: the item itself (for
// the title/domain/points row), the AI summary (article + comments), and the
// first page of top-level comments so offline readers see real discussion,
// not an empty thread. Everything rides the same 7-day persisted cache TTL
// as the pinned-ids list.
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
      // /api/items so a 30-comment warm is one HTTP request.
      prefetchCommentBatch(client, kidIds, getItems);
      if (kidIds.length > 0) {
        // Only pay for a /api/comments-summary call when there are
        // actually comments to summarize — otherwise the endpoint returns
        // 404 and we'd just burn a request.
        client.prefetchQuery(commentsSummaryQueryOptions(story.id));
      }
      return { item, kidIds };
    },
    staleTime: SUMMARY_CACHE_TTL_MS,
    gcTime: SUMMARY_CACHE_TTL_MS,
  });
  if (story.url) {
    client.prefetchQuery(summaryQueryOptions(story.url));
  }
}
