import { useQuery } from '@tanstack/react-query';
import { trackedFetch } from '../lib/networkStatus';

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
  // Jina returned 402 / 429: our paid quota is exhausted. Distinguished
  // from not_configured so we can render a transient "temporarily
  // unavailable" message instead of the permanent "not available" copy.
  | 'summary_budget_exhausted'
  | 'no_article'
  | 'low_score'
  | 'story_unreachable'
  // The fetched "article" was a CAPTCHA / bot-challenge page, so the
  // model had nothing to summarize. Detected after the fact from the
  // model's refusal text.
  | 'source_captcha';

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
    value === 'summary_budget_exhausted' ||
    value === 'no_article' ||
    value === 'low_score' ||
    value === 'story_unreachable' ||
    value === 'source_captcha'
  ) {
    return value;
  }
  return undefined;
}

async function fetchSummary(
  storyId: number,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const res = await trackedFetch(`/api/summary?id=${storyId}`, { signal });
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
