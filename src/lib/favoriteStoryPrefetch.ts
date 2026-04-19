import type { QueryClient } from '@tanstack/react-query';
import type { HNItem } from './hn';
import { getItem } from './hn';
import { summaryQueryOptions, SUMMARY_CACHE_TTL_MS } from '../hooks/useSummary';

// Mirror of prefetchPinnedStory for the Favorites list. Favorites are the
// permanent keepsake shelf — we want to guarantee the title/domain/points
// row and the AI summary are available on /favorites even days later when
// the user is offline, so we lock the item root and the summary into the
// same 7-day persisted cache at favorite-time.
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
      return { item, kidIds };
    },
    staleTime: SUMMARY_CACHE_TTL_MS,
    gcTime: SUMMARY_CACHE_TTL_MS,
  });
  if (story.url) {
    client.prefetchQuery(summaryQueryOptions(story.url));
  }
}
