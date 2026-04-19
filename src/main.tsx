import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import App from './App';
import './styles/global.css';

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
    },
  },
});

const persister = createSyncStoragePersister({
  storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  key: 'hnews:rq-cache',
  throttleTime: 1000,
});

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
