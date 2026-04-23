import { useQuery } from '@tanstack/react-query';
import { trackedFetch } from '../lib/networkStatus';
// Both summary hooks share the same freshness/retention pair: they are
// warmed by the same cron on the same cadence (see
// `api/warm-summaries.ts` and CRON.md), so the knobs must stay aligned.
// Importing the article-summary constants here keeps a single source of
// truth — divergence would be a bug.
import { SUMMARY_FRESHNESS_MS, SUMMARY_RETENTION_MS } from './useSummary';

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
    staleTime: SUMMARY_FRESHNESS_MS,
    gcTime: SUMMARY_RETENTION_MS,
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
