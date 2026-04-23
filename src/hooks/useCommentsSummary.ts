import { useQuery } from '@tanstack/react-query';
import { trackedFetch } from '../lib/networkStatus';

// Retention / freshness split mirrors `useSummary.ts`: we keep the
// bytes for 7 days (so a pinned thread revisited mid-week is a
// synchronous cache hit) but mark the entry stale after 30 min so the
// next mount refetches and picks up cron-regenerated updates. The
// service worker's StaleWhileRevalidate absorbs that refetch latency.
export const COMMENTS_SUMMARY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const COMMENTS_SUMMARY_FRESHNESS_MS = 30 * 60 * 1000;

export interface CommentsSummaryResult {
  insights: string[];
  cached?: boolean;
}

async function fetchCommentsSummary(
  storyId: number,
  signal?: AbortSignal,
): Promise<CommentsSummaryResult> {
  const res = await trackedFetch(`/api/comments-summary?id=${storyId}`, { signal });
  if (!res.ok) {
    let message = 'Summarization failed';
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') message = body.error;
    } catch {
      // keep default
    }
    throw new Error(message);
  }
  return (await res.json()) as CommentsSummaryResult;
}

export function commentsSummaryQueryKey(storyId: number) {
  return ['comments-summary', storyId] as const;
}

export function commentsSummaryQueryOptions(storyId: number) {
  return {
    queryKey: commentsSummaryQueryKey(storyId),
    queryFn: ({ signal }: { signal?: AbortSignal }) =>
      fetchCommentsSummary(storyId, signal),
    retry: false,
    staleTime: COMMENTS_SUMMARY_FRESHNESS_MS,
    gcTime: COMMENTS_SUMMARY_RETENTION_MS,
  } as const;
}

export function useCommentsSummary(
  storyId: number | undefined,
  enabled: boolean,
) {
  return useQuery({
    ...commentsSummaryQueryOptions(storyId ?? 0),
    enabled: enabled && typeof storyId === 'number' && storyId > 0,
  });
}

export { fetchCommentsSummary as _fetchCommentsSummaryForTests };
