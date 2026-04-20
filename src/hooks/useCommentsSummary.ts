import { useQuery } from '@tanstack/react-query';

// Matches the conservative end of the server-side TTL (the server may
// regenerate after 30 min for young stories). The client holds onto the
// response for an hour so repeat visits within a single browsing session
// don't trigger an immediate refetch.
export const COMMENTS_SUMMARY_CACHE_TTL_MS = 60 * 60 * 1000;

export interface CommentInsight {
  text: string;
  authors?: string[];
}

export interface CommentsSummaryResult {
  insights: CommentInsight[];
  cached?: boolean;
}

async function fetchCommentsSummary(
  storyId: number,
  signal?: AbortSignal,
): Promise<CommentsSummaryResult> {
  const res = await fetch(`/api/comments-summary?id=${storyId}`, { signal });
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
    staleTime: COMMENTS_SUMMARY_CACHE_TTL_MS,
    gcTime: COMMENTS_SUMMARY_CACHE_TTL_MS,
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
