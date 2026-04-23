import type { QueryClient } from '@tanstack/react-query';
import type { HNItem } from './hn';
import { getItem, getItems } from './hn';
import { summaryQueryOptions, SUMMARY_RETENTION_MS } from '../hooks/useSummary';
import { commentsSummaryQueryOptions } from '../hooks/useCommentsSummary';
import { prefetchCommentBatch } from './commentPrefetch';

// Mirror of prefetchPinnedStory for the Favorites list. Favorites are the
// permanent keepsake shelf — we want to guarantee the title/domain/points
// row, both AI summaries (article + comments), and the first page of
// top-level comments are available on /favorites even days later when the
// user is offline, so we lock everything into the same 7-day persisted
// cache at favorite-time. All prefetches fire in parallel at the top level;
// see prefetchPinnedStory for the rationale.
export function prefetchFavoriteStory(
  client: QueryClient,
  story: Pick<HNItem, 'id' | 'url'>,
): void {
  client.prefetchQuery({
    queryKey: ['itemRoot', story.id],
    queryFn: async ({ signal }) => {
      const item = await getItem(story.id, signal);
      if (!item) return null;
      const kidIds = item.deleted || item.dead ? [] : (item.kids ?? []);
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
