import { useQuery } from '@tanstack/react-query';

export interface SummaryResult {
  summary: string;
  cached?: boolean;
}

async function fetchSummary(url: string, signal?: AbortSignal): Promise<SummaryResult> {
  const res = await fetch(`/api/summary?url=${encodeURIComponent(url)}`, { signal });
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
  return (await res.json()) as SummaryResult;
}

export function useSummary(url: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['summary', url],
    queryFn: ({ signal }) => fetchSummary(url as string, signal),
    enabled: enabled && typeof url === 'string' && url.length > 0,
    retry: false,
    staleTime: 60 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
  });
}

export { fetchSummary as _fetchSummaryForTests };
