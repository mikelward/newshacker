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

// Kept narrow for now — only the reasons Thread.tsx needs to render
// specific copy. Anything else bubbles up as a plain Error via
// `message`. If more reasons turn out to be user-visible, add them
// here and in the card's switch.
export type CommentsSummaryErrorReason = 'rate_limited';

export class CommentsSummaryError extends Error {
  readonly reason?: CommentsSummaryErrorReason;
  constructor(message: string, reason?: CommentsSummaryErrorReason) {
    super(message);
    this.name = 'CommentsSummaryError';
    this.reason = reason;
  }
}

function parseCommentsReason(
  value: unknown,
): CommentsSummaryErrorReason | undefined {
  if (value === 'rate_limited') return value;
  return undefined;
}

async function fetchCommentsSummary(
  storyId: number,
  signal?: AbortSignal,
): Promise<CommentsSummaryResult> {
  const res = await trackedFetch(`/api/comments-summary?id=${storyId}`, { signal });
  if (!res.ok) {
    let message = 'Summarization failed';
    let reason: CommentsSummaryErrorReason | undefined;
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') message = body.error;
      if (body) reason = parseCommentsReason(body.reason);
    } catch {
      // keep default
    }
    throw new CommentsSummaryError(message, reason);
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
