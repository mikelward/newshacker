import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import App from './App';
import { FEED_QUERY_RETRY, feedQueryRetryDelay } from './hooks/useStoryList';
import { setConnectivityProbeUrl } from './lib/networkStatus';
import { startQueryCacheSync } from './lib/queryCacheSync';
import {
  lockAllPinnedQueriesGcTime,
  startPinnedQueryRetention,
} from './lib/pinnedQueryRetention';
// Self-hosted Roboto (Fontsource, variable wght axis) so the UI renders in a
// consistent face instead of whatever sans the OS happens to map. The bundled
// woff2 only fetches when text actually paints in this family; until then the
// system fallback stack (--font-system) carries the first paint.
import '@fontsource-variable/roboto/wght.css';
import './styles/global.css';
import './styles/chromePreview.css';

// Bump when the shape of cached data changes in a way that would break
// hydrated readers — it busts all persisted queries in one go (pinned
// entries included; intentional, the data shape on disk no longer
// matches what the new readers expect).
const CACHE_BUSTER = '2';
const ONE_HOUR = 60 * 60 * 1000;
// Persister maxAge is intentionally Infinity. Pinned stories must
// survive arbitrarily long offline gaps, and the persister discards
// the entire blob if it's older than maxAge — so any finite ceiling
// would silently evict the pinned cache after the user is away that
// long. Per-query gcTime still bounds non-pinned entries (default 1 h
// in memory, 7 d for itemRoot/summary/comments-summary/comment), so
// the persisted blob doesn't grow unboundedly: GC'd queries fall out
// of the next dehydrate. Pinned-story queries are explicitly locked
// at gcTime Infinity in prefetchPinnedStory + lockPinnedQueryGcTime.
const PERSIST_MAX_AGE = Number.POSITIVE_INFINITY;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Serve cached data as fresh for 5 minutes; long enough that
      // navigation within a session never blocks on the network, short
      // enough that vote/comment counts refresh naturally.
      staleTime: 5 * 60 * 1000,
      gcTime: ONE_HOUR,
      retry: 1,
      refetchOnWindowFocus: false,
      // The Workbox service worker answers from the Cache API when it
      // can, so we want queries to run the fetch even when the browser
      // reports offline — otherwise React Query's default 'online' mode
      // pauses uncached requests in a never-resolving pending state
      // (spinner hangs). With 'offlineFirst', the fetch runs, the SW
      // serves a cached response if it has one, and a true miss surfaces
      // as an error so the offline UI can render.
      networkMode: 'offlineFirst',
    },
  },
});

// The feed id-list (`['storyIds', feed]`) is the freshness signal behind
// "are these the current top stories?" and is the most fragile read in the
// app: it's the one request that goes straight to Firebase from the client
// (items are proxied via /api/items), so a flaky radio or a momentarily
// blocked/slow request on open is exactly what leaves a returning reader
// staring at the persisted snapshot. Give just that query a few retries
// with exponential backoff — scoped here by key rather than on the global
// default so we don't multiply retries (and cost) on the LLM-backed
// summary queries. The "More" page fetch deliberately keeps the default
// (no extra retries) so its bail-on-failure chase behavior is preserved.
queryClient.setQueryDefaults(['storyIds'], {
  retry: FEED_QUERY_RETRY,
  retryDelay: feedQueryRetryDelay,
});

const persister = createSyncStoragePersister({
  storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  key: 'newshacker:rq-cache',
  throttleTime: 1000,
});

// Point the connectivity tracker at our liveness endpoint. `/api/me` is a pure
// origin-reachability check: its handler only reads the session cookie and
// returns 200/401 with no upstream dependency (no Redis, no HN round-trip — see
// api/me.ts), so a slow/down dependency can never make a reachable origin look
// offline. It's same-origin and deliberately NOT in the service worker's
// runtimeCaching, so the probe always hits the network (never a cache hit that
// lies about being online). Used only to confirm recovery while we're showing
// the offline pill — it fires at most every 30s, and while genuinely offline it
// fails without ever reaching the server, so the cost is negligible.
setConnectivityProbeUrl('/api/me');

// Bridge cache writes across tabs in real time so a pin/favorite in tab
// A doesn't force tab B to re-fetch what A already warmed. No cleanup —
// the channel is scoped to the tab's lifetime; the browser closes it
// on unload.
startQueryCacheSync(queryClient);

// Same lifecycle: re-lock every pinned story's gcTime to Infinity on
// any pin/unpin event (incl. cross-tab via the storage event), so a
// story pinned in tab A also stops being evictable in tab B once
// queryCacheSync delivers its data.
startPinnedQueryRetention(queryClient);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{ persister, maxAge: PERSIST_MAX_AGE, buster: CACHE_BUSTER }}
      onSuccess={() => {
        // Persister rehydrate creates queries with the queryClient's
        // default gcTime (1 h); without this, any pinned-story query
        // restored from disk would be GC'd within an hour of boot if
        // no observer attached. Lock them at Infinity immediately.
        lockAllPinnedQueriesGcTime(queryClient);
      }}
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </PersistQueryClientProvider>
  </StrictMode>,
);
