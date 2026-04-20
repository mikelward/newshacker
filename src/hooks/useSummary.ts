import { useQuery } from '@tanstack/react-query';

export const SUMMARY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SummaryResult {
  summary: string;
  cached?: boolean;
}

export type SummaryErrorReason =
  | 'source_timeout'
  | 'source_unreachable'
  | 'summarization_failed'
  | 'not_configured'
  | 'no_article'
  | 'story_unreachable';

export class SummaryError extends Error {
  readonly reason?: SummaryErrorReason;
  constructor(message: string, reason?: SummaryErrorReason) {
    super(message);
    this.name = 'SummaryError';
    this.reason = reason;
  }
}

function parseReason(value: unknown): SummaryErrorReason | undefined {
  if (
    value === 'source_timeout' ||
    value === 'source_unreachable' ||
    value === 'summarization_failed' ||
    value === 'not_configured' ||
    value === 'no_article' ||
    value === 'story_unreachable'
  ) {
    return value;
  }
  return undefined;
}

async function fetchSummary(
  storyId: number,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const res = await fetch(`/api/summary?id=${storyId}`, { signal });
  if (!res.ok) {
    let message = 'Summarization failed';
    let reason: SummaryErrorReason | undefined;
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') message = body.error;
      if (body) reason = parseReason(body.reason);
    } catch {
      // keep default
    }
    throw new SummaryError(message, reason);
  }
  return (await res.json()) as SummaryResult;
}

export function summaryQueryKey(storyId: number) {
  return ['summary', storyId] as const;
}

export function summaryQueryOptions(storyId: number) {
  return {
    queryKey: summaryQueryKey(storyId),
    queryFn: ({ signal }: { signal?: AbortSignal }) =>
      fetchSummary(storyId, signal),
    retry: false,
    staleTime: SUMMARY_CACHE_TTL_MS,
    gcTime: SUMMARY_CACHE_TTL_MS,
  } as const;
}

export function useSummary(storyId: number | undefined, enabled: boolean) {
  return useQuery({
    ...summaryQueryOptions(storyId ?? 0),
    enabled: enabled && typeof storyId === 'number' && storyId > 0,
  });
}

export { fetchSummary as _fetchSummaryForTests };
