import type { QueryClient } from '@tanstack/react-query';
import { SUMMARY_RETENTION_MS } from '../hooks/useSummary';
import { COMMENT_BATCH_LIMIT, prefetchCommentBatch } from './commentPrefetch';
import { getItems, type HNItem } from './hn';
import { getOnline } from './networkStatus';
import { getPinnedEntries } from './pinnedStories';

export const HOME_PINNED_REFRESH_STALE_MS = 6 * 60 * 60 * 1000;
export const HOME_PINNED_REFRESH_MAX_STORIES = 30;

const attemptedAtById = new Map<number, number>();

function shouldRefreshPinnedStory(
  client: QueryClient,
  id: number,
  now: number,
): boolean {
  const attemptedAt = attemptedAtById.get(id) ?? 0;
  if (attemptedAt > 0 && now - attemptedAt < HOME_PINNED_REFRESH_STALE_MS) {
    return false;
  }
  const query = client.getQueryState(['itemRoot', id]);
  const updatedAt = query?.dataUpdatedAt ?? 0;
  return updatedAt === 0 || now - updatedAt >= HOME_PINNED_REFRESH_STALE_MS;
}

async function refreshPinnedBatch(
  client: QueryClient,
  ids: readonly number[],
): Promise<void> {
  let items: Array<HNItem | null>;
  try {
    items = await getItems([...ids], undefined, { fields: 'full' });
  } catch {
    return;
  }

  const rootWrites: Array<Promise<void>> = [];
  const commentIds: number[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    const item = items[i];
    if (!item) continue;
    const kidIds = item.deleted || item.dead ? [] : (item.kids ?? []);
    const resolved = { item, kidIds };
    rootWrites.push(
      client.prefetchQuery({
        queryKey: ['itemRoot', ids[i]],
        queryFn: () => resolved,
        staleTime: 0,
        gcTime: SUMMARY_RETENTION_MS,
      }),
    );
    for (const kidId of kidIds) {
      if (commentIds.length >= COMMENT_BATCH_LIMIT) break;
      commentIds.push(kidId);
    }
  }
  await Promise.all(rootWrites);
  await prefetchCommentBatch(client, commentIds, getItems);
}

// Feed/home views are already a foreground network moment: the reader opened
// the app, and the feed itself refetches. Use that moment to keep pinned
// offline roots from quietly aging out, without a background timer. Cost is
// capped at one existing /api/items batch for the newest pins plus one capped
// comments batch; failures are fail-open and leave the previous cache intact.
export function refreshPinnedStoriesForHomeView(
  client: QueryClient,
  now: number = Date.now(),
): void {
  if (!getOnline()) return;
  const ids = getPinnedEntries()
    .sort((a, b) => b.at - a.at)
    .map((entry) => entry.id)
    .filter((id) => shouldRefreshPinnedStory(client, id, now))
    .slice(0, HOME_PINNED_REFRESH_MAX_STORIES);
  if (ids.length === 0) return;
  for (const id of ids) attemptedAtById.set(id, now);
  void refreshPinnedBatch(client, ids);
}

export function _resetHomePinnedRefreshForTests(): void {
  attemptedAtById.clear();
}
