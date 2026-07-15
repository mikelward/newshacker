import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import {
  clearEntryReloadBudget,
  installStaleChunkRecovery,
} from './lib/staleEntryRecovery';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import App from './App';
import { feedQueryRetry, feedQueryRetryDelay } from './hooks/useStoryList';
import { shouldDehydrateAppQuery } from './hooks/useAuth';
import {
  isRetryableFetchError,
  setConnectivityProbeUrl,
} from './lib/networkStatus';
import { createAppPersister } from './lib/idbPersister';
import { startQueryCacheSync } from './lib/queryCacheSync';
import {
  lockAllPinnedQueriesGcTime,
  startPinnedQueryRetention,
} from './lib/pinnedQueryRetention';
import {
  startPinnedOfflineSync,
  syncPinnedStoriesForOffline,
} from './lib/pinnedOfflineSync';
// Self-hosted Roboto (Fontsource, variable wght axis) so the UI renders in a
// consistent face instead of whatever sans the OS happens to map. The bundled
// woff2 only fetches when text actually paints in this family; until then the
// system fallback stack (--font-system) carries the first paint.
import '@fontsource-variable/roboto/wght.css';
import './styles/global.css';
import './styles/chromePreview.css';

declare global {
  interface Window {
    // Set by the inline boot guard in index.html; lets the entry tear that
    // guard's listener down once we've proven the entry loaded.
    __nhBootGuardOff?: () => void;
  }
}

// Reaching this line proves the entry module loaded and executed, so the
// stale-entry reload budget can be released — a *later* stale-entry failure in
// this same session is then free to reload once more. Tear down the inline
// boot guard too, so post-boot chunk failures are owned solely by the handlers
// installed just below (the separate `nh:chunk-reload` budget). A permanently
// broken entry never reaches here, so its single reload stands — loop-safe.
clearEntryReloadBudget();
window.__nhBootGuardOff?.();
installStaleChunkRecovery();

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
      // One retry, and only for true statusless network blips (a thrown
      // fetch, our read-cap timeout). Never retry a response that carried an
      // HTTP status: a 4xx won't change, and retrying 5xx storms a struggling
      // backend — the connectivity tracker's 'down' state + rate-bounded
      // recovery probe own that recovery path.
      retry: (failureCount, error) =>
        failureCount < 1 && isRetryableFetchError(error),
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
  retry: feedQueryRetry,
  retryDelay: feedQueryRetryDelay,
});

// IndexedDB-backed persister (with a one-shot migration of the old
// localStorage blob and a localStorage fallback when IDB is missing).
// See src/lib/idbPersister.ts for the quota/main-thread rationale.
const persister = createAppPersister();

// Point the connectivity tracker at our liveness endpoint. `/api/me` is a pure
// origin-reachability check: its handler only reads the session cookie and
// returns 200/401 with no upstream dependency (no Redis, no HN round-trip — see
// api/me.ts; it never touches a database, so it stays up while the data plane
// fails). It's same-origin and deliberately NOT in the service worker's
// runtimeCaching, so the probe always hits the network (never a cache hit that
// lies about being online). Configuring it also opts the tracker into pausing
// React Query's onlineManager on fetch evidence — safe only because the probe
// guarantees a resume path (see syncOnlineManager in networkStatus.ts). Cost is
// negligible: the probe fires on failure transitions, hedged slow reads,
// connection-change events, focus regain, and a 30s recovery interval while in
// doubt — coalesced to one in flight, and while genuinely offline it fails
// without ever reaching the server.
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

// Download pinned content (item root, first comments, both AI summaries)
// the moment the pinned set changes — which is how a pin made on another
// device arrives here via cloud sync — and when connectivity returns, so
// "pin it anywhere, it's readable offline everywhere" doesn't wait for
// the reader to visit the home feed. The home feed's own mount/focus
// calls remain as the periodic staleness refresh moments; all paths
// share a 6 h per-story attempt throttle. See pinnedOfflineSync.ts for
// the cost bounds.
startPinnedOfflineSync(queryClient);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: PERSIST_MAX_AGE,
        buster: CACHE_BUSTER,
        // Persist a data-bearing `['me']` query even in its error state, so
        // a signed-in user retained through a failed background /api/me
        // refetch survives a reload during the same failure window instead
        // of being dropped from IndexedDB (the default persists only
        // successful queries). See shouldDehydrateAppQuery in useAuth.
        dehydrateOptions: { shouldDehydrateQuery: shouldDehydrateAppQuery },
      }}
      onSuccess={() => {
        // Persister rehydrate creates queries with the queryClient's
        // default gcTime (1 h); without this, any pinned-story query
        // restored from disk would be GC'd within an hour of boot if
        // no observer attached. Lock them at Infinity immediately.
        lockAllPinnedQueriesGcTime(queryClient);
        // Then top up anything a pinned story is still missing for
        // offline reading (root, comments, either AI summary). Runs
        // after rehydrate on purpose: the staleness/missing checks
        // must see the restored cache, not an empty one — otherwise
        // every boot would re-download all pins. Landing on a thread
        // link directly (no home view) still syncs this way.
        syncPinnedStoriesForOffline(queryClient);
      }}
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </PersistQueryClientProvider>
  </StrictMode>,
);
