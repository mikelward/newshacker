import type { QueryClient } from '@tanstack/react-query';
import { commentsSummaryQueryOptions } from '../hooks/useCommentsSummary';
import { loadRoot } from '../hooks/useItemTree';
import { SUMMARY_RETENTION_MS, summaryQueryOptions } from '../hooks/useSummary';

// `/item/123` — the only route whose content is fully determined by the
// URL, and the one a companion app (Readmo) deep-links into.
const ITEM_PATH = /^\/item\/(\d+)\/*$/;

export function parseDeepLinkedItemId(pathname: string): number | null {
  const match = ITEM_PATH.exec(pathname);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Start a deep-linked thread's fetches from the entry module, before
// React mounts and before the persisted cache finishes rehydrating.
//
// Opening `/item/123` cold used to reach the network only at the end of
// a chain the reader watches: parse and run the bundle → mount React →
// wait out the IndexedDB restore (React Query holds every *observer's*
// fetch while `isRestoring`) → fetch the item → and only then, because
// the summary card doesn't exist until the item says the story has a
// `url` or a `text` body, fetch the summary. Four waits, of which the
// URL already told us enough to skip the first three.
//
// So all three go out here in parallel. The keys match what `useItemTree`
// / `useSummary` / `useCommentsSummary` use, so the observers that mount
// a moment later attach to these in-flight fetches instead of starting
// their own, and `hydrate` only overwrites a query whose persisted copy
// is *newer* than what's in the client — a cached thread still hydrates
// from disk, and a fresher live response isn't clobbered by it.
//
// Cost/reliability (rule 11): three requests the thread page was about
// to make anyway, so the normal case adds nothing. Two cases pay: a
// re-open inside the 30-minute summary freshness window re-asks for a
// summary the cache would have served, and a deep link to a *comment*
// — indistinguishable from a story by URL — asks for two summaries that
// don't exist. Both reject from Redis-backed validation that sits
// before the rate-limit gate and before any Gemini/Jina call: **no
// model spend and no AI quota consumed**, so the whole cost is Vercel
// invocations plus one or two Upstash reads each.
//
// Numbers. Deep links are the share/companion-app path, not routine
// navigation — call it 50 cold opens a day for a heavy single user, of
// which the wasteful subset (fresh re-opens plus comment permalinks)
// is a minority; take all 50 as the worst case and it's **≤100 extra
// invocations/day, ~3k/month**. Vercel Pro includes 1M function
// invocations a month, so this is ~0.3% of the included quota:
// **$0/month**, and it would take roughly 300× this traffic to reach
// the paid threshold at all. Upstash sees ≤2 reads per call, ~6k/month
// against a free tier measured in tens of thousands of commands a day
// — also $0. The same shape applies to the cold-pin warm in
// pinnedOfflineSync.ts, which is bounded far tighter (only pins this
// device has never downloaded, ≤30 per sync run, one run per 6 h per
// story).
//
// Failures are invisible: a prefetch that errors leaves the thread's
// own query to fetch and report as it always did — and Thread renders
// cached data over a failed refresh rather than the error screen (see
// the `isError && !data` gate there), so a failed prefetch can't take a
// hydrated thread off the screen either.
export function prefetchDeepLinkedItem(
  client: QueryClient,
  pathname: string = typeof window === 'undefined'
    ? ''
    : window.location.pathname,
): void {
  const id = parseDeepLinkedItemId(pathname);
  if (id === null) return;
  void client.prefetchQuery({
    queryKey: ['itemRoot', id],
    queryFn: ({ signal }) => loadRoot(id, signal, client),
    gcTime: SUMMARY_RETENTION_MS,
  });
  void client.prefetchQuery(summaryQueryOptions(id));
  void client.prefetchQuery(commentsSummaryQueryOptions(id));
}
