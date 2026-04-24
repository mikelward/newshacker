import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import App from './App';
import { startQueryCacheSync } from './lib/queryCacheSync';
import './styles/global.css';
import './styles/chromePreview.css';

// Bump when the shape of cached data changes in a way that would break
// hydrated readers — it busts all persisted queries in one go.
const CACHE_BUSTER = '2';
const ONE_HOUR = 60 * 60 * 1000;
// Saved stories prefetch their item data and AI summary at save-time; we
// want those to stay usable when the user comes back to /saved days later,
// so the persisted cache lives as long as the saved-story TTL.
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

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

const persister = createSyncStoragePersister({
  storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  key: 'newshacker:rq-cache',
  throttleTime: 1000,
});

// Bridge cache writes across tabs in real time so a pin/favorite in tab
// A doesn't force tab B to re-fetch what A already warmed. No cleanup —
// the channel is scoped to the tab's lifetime; the browser closes it
// on unload.
startQueryCacheSync(queryClient);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{ persister, maxAge: SEVEN_DAYS, buster: CACHE_BUSTER }}
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </PersistQueryClientProvider>
  </StrictMode>,
);
