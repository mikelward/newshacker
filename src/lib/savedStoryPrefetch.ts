import type { QueryClient } from '@tanstack/react-query';
import type { HNItem } from './hn';
import { getItem } from './hn';
import { summaryQueryOptions, SUMMARY_CACHE_TTL_MS } from '../hooks/useSummary';

// When a user saves a story we try to make everything they'll need on the
// saved page available without a second network trip: the item itself (for
// the title/domain/points row) and the AI summary. Both ride the same 7-day
// persisted cache TTL as the saved-ids list.
export function prefetchSavedStory(
  client: QueryClient,
  story: Pick<HNItem, 'id' | 'url'>,
): void {
  client.prefetchQuery({
    queryKey: ['itemRoot', story.id],
    queryFn: async ({ signal }) => {
      const item = await getItem(story.id, signal);
      if (!item) return null;
      const kidIds = item.deleted || item.dead ? [] : (item.kids ?? []);
      return { item, kidIds };
    },
    staleTime: SUMMARY_CACHE_TTL_MS,
    gcTime: SUMMARY_CACHE_TTL_MS,
  });
  if (story.url) {
    client.prefetchQuery(summaryQueryOptions(story.url));
  }
}
