import { useQuery } from '@tanstack/react-query';
import { trackedFetch } from '../lib/networkStatus';

// Retention: how long we keep the bytes around (React Query gcTime, SW
// Cache Storage, persister). Matches the service-worker `ai-summaries`
// entry TTL in `vite.config.ts` so a pinned story that sits for a week
// still has a warm local copy.
export const SUMMARY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Freshness: how long we trust the local copy before asking the server
// for a newer one (React Query staleTime). 30 min matches the
// warm-summaries cron's default check interval
// (`WARM_REFRESH_CHECK_INTERVAL_SECONDS`, see CRON.md), so we never ask
// for a version newer than what the cron could have produced.
//
// Interaction with the service worker's StaleWhileRevalidate: when
// React Query refetches after staleTime expires, the SW returns the
// *cached* response synchronously (which React Query then treats as
// the latest answer for another staleTime window) and kicks off a
// background revalidation that updates the SW cache. The newly-fetched
// bytes are therefore only observed on the *next* React Query refetch
// cycle, so worst-case visible lag is roughly 2× staleTime — not
// "instant." That's fine for AI summaries, which change rarely and
// don't need to be minute-fresh, but don't shorten staleTime expecting
// SWR to close the gap: it won't, and you'd just double the request
// volume to the SW. If a future feature needs tighter freshness
// (live-updating summary, e.g.), switch that route's SW handler to
// NetworkFirst so the refetch path actually sees the network response.
export const SUMMARY_FRESHNESS_MS = 30 * 60 * 1000;

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
  | 'source_captcha'
  // Per-IP rate limit on cache-miss generations (shared bucket with
  // /api/comments-summary). Returned as HTTP 429.
  | 'rate_limited';

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
    value === 'source_captcha' ||
    value === 'rate_limited'
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
    staleTime: SUMMARY_FRESHNESS_MS,
    gcTime: SUMMARY_RETENTION_MS,
  } as const;
}

export function useSummary(storyId: number | undefined, enabled: boolean) {
  return useQuery({
    ...summaryQueryOptions(storyId ?? 0),
    enabled: enabled && typeof storyId === 'number' && storyId > 0,
  });
}

export { fetchSummary as _fetchSummaryForTests };
