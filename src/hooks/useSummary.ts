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
  | 'not_configured';

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
    value === 'not_configured'
  ) {
    return value;
  }
  return undefined;
}

async function fetchSummary(url: string, signal?: AbortSignal): Promise<SummaryResult> {
  const res = await fetch(`/api/summary?url=${encodeURIComponent(url)}`, { signal });
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

export function summaryQueryKey(url: string) {
  return ['summary', url] as const;
}

export function summaryQueryOptions(url: string) {
  return {
    queryKey: summaryQueryKey(url),
    queryFn: ({ signal }: { signal?: AbortSignal }) => fetchSummary(url, signal),
    retry: false,
    staleTime: SUMMARY_CACHE_TTL_MS,
    gcTime: SUMMARY_CACHE_TTL_MS,
  } as const;
}

export function useSummary(url: string | undefined, enabled: boolean) {
  return useQuery({
    ...summaryQueryOptions(url ?? ''),
    enabled: enabled && typeof url === 'string' && url.length > 0,
  });
}

export { fetchSummary as _fetchSummaryForTests };
