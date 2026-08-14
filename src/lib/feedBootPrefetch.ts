import type { QueryClient } from '@tanstack/react-query';
import { getStoryIds } from './hn';

// The home feed's id list, fetched from the entry module instead of from
// a React effect.
//
// `['storyIds', 'top']` is the first link in the home page's serial
// chain: nothing about the feed can be fetched until it answers, because
// the `/api/items` batch needs the ids. Measured against a stubbed
// backend, a 3 s delay on this one request moves first paint by very
// nearly 3 s — it is on the critical path essentially 1:1, and the items
// batch waits behind it.
//
// It used to be prefetched from `<BootPrefetch>`'s effect, which is as
// early as React can manage but still costs the whole initial mount of
// the app tree before the request reaches the wire. From module scope it
// goes out while the bundle is still setting up React, overlapping the
// mount with the round trip instead of sequencing them.
//
// `prefetchQuery` is deliberately not gated on the persisted cache the
// way an observer is — React Query holds every *observer's* fetch while
// `isRestoring`, but not a direct `fetchQuery` — so this also skips the
// IndexedDB restore wait. `hydrate` overwrites only when the persisted
// copy is newer, so a restored id list still wins if this request is
// slower, and the mounted `useStoryIds` attaches to whatever is in
// flight rather than starting its own.
//
// Cost/reliability (rule 11): no new request. This is the same fetch
// `<BootPrefetch>` already made on every boot, at the same frequency,
// moved earlier — one Firebase read, no new infrastructure, $0. It is
// fired unconditionally rather than only on `/`, exactly as
// `<BootPrefetch>` was, so arriving on a thread and then navigating home
// still finds the list warm; the 5-minute `staleTime` means a
// same-session re-entry doesn't re-ask. A failure is invisible: the
// query is left in its error state and the feed's own observer retries
// under the id-list retry policy (`feedQueryRetry`, set in main.tsx).
export function prefetchHomeFeedIds(client: QueryClient): void {
  void client.prefetchQuery({
    queryKey: ['storyIds', 'top'],
    queryFn: ({ signal }) => getStoryIds('top', signal),
  });
}
