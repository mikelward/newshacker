import { lazy, Suspense } from 'react';
import type React from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { clearChunkReloadBudget } from './lib/staleEntryRecovery';
import { Analytics } from '@vercel/analytics/react';
import { AppHeader } from './components/AppHeader';
import { AppUpdateWatcher } from './components/AppUpdateWatcher';
import { ScrollToTop } from './components/ScrollToTop';
import { FeedBarProvider } from './components/FeedBarContext';
import { KeyboardShortcutsOverlay } from './components/KeyboardShortcutsOverlay';
import { HotStoryList, StoryList } from './components/StoryList';
import { ToastProvider } from './components/Toast';
import { LoginDialogProvider } from './components/LoginDialog';
import { useCloudSync } from './hooks/useCloudSync';
import { useHnFavoritesSync } from './hooks/useHnFavoritesSync';
import { useHomeFeed } from './hooks/useHomeFeed';
import { FeedPage } from './pages/FeedPage';
import { ItemPage } from './pages/ItemPage';
import { OpenedPage } from './pages/OpenedPage';
import { HiddenPage } from './pages/HiddenPage';
import { DonePage } from './pages/DonePage';
import { PinnedPage } from './pages/PinnedPage';
import { FavoritesPage } from './pages/FavoritesPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { usePinchFontSize } from './hooks/usePinchFontSize';

// Secondary surfaces load on demand so the entry chunk carries only what a
// reader hits on a normal visit: the feeds, the thread page, and the library
// pages that share their components. The operator pages alone (/admin +
// /tuning) were ~8% of the old single-chunk bundle, downloaded and parsed by
// every visitor. After the first visit the service worker precaches every
// chunk, so installed-PWA readers never pay the extra request; first-time web
// readers pay one same-origin round trip on these rarely-entered routes.
//
// Every loader re-arms the stale-chunk reload budget on success: a chunk
// resolving proves this session can load the current build's assets, so a
// LATER deploy that strands a different chunk is free to recover with its own
// one-shot reload. Without this the budget stays spent after its first use
// and the session's next stale chunk dead-ends on the loading state (see
// clearChunkReloadBudget in staleEntryRecovery.ts — clearing must hang off
// lazy-route success, never boot, or a genuinely-gone chunk would loop).
function lazyPage<M>(
  load: () => Promise<M>,
  pick: (m: M) => React.ComponentType,
) {
  return lazy(() =>
    load().then((m) => {
      clearChunkReloadBudget();
      return { default: pick(m) };
    }),
  );
}

const UserPage = lazyPage(
  () => import('./pages/UserPage'),
  (m) => m.UserPage,
);
const OfflinePage = lazyPage(
  () => import('./pages/OfflinePage'),
  (m) => m.OfflinePage,
);
const HelpPage = lazyPage(
  () => import('./pages/HelpPage'),
  (m) => m.HelpPage,
);
const AboutPage = lazyPage(
  () => import('./pages/AboutPage'),
  (m) => m.AboutPage,
);
const DebugPage = lazyPage(
  () => import('./pages/DebugPage'),
  (m) => m.DebugPage,
);
const AdminPage = lazyPage(
  () => import('./pages/AdminPage'),
  (m) => m.AdminPage,
);
const ThresholdTuningPage = lazyPage(
  () => import('./pages/ThresholdTuningPage'),
  (m) => m.ThresholdTuningPage,
);
const LoginPage = lazyPage(
  () => import('./pages/LoginPage'),
  (m) => m.LoginPage,
);
const SearchPage = lazyPage(
  () => import('./pages/SearchPage'),
  (m) => m.SearchPage,
);
const SettingsPage = lazyPage(
  () => import('./pages/SettingsPage'),
  (m) => m.SettingsPage,
);

function CloudSyncBridge() {
  useCloudSync();
  return null;
}

function HnFavoritesSyncBridge() {
  useHnFavoritesSync();
  return null;
}

function HomeRoute() {
  const { homeFeed } = useHomeFeed();
  if (homeFeed === 'hot') return <HotStoryList />;
  // Default home: top feed with the toolbar's one-row dismissible
  // "Try the Hot view" promo on the left (see SPEC.md *Story feeds →
  // /hot* → home promo). The promo lives inside `<ListToolbar>` so the
  // bar stays single-row; on `/hot` itself the Hot customize panel
  // already occupies the toolbar's left slot, so we don't double-stack.
  return <StoryList feed="top" homePromo />;
}

export default function App() {
  // Two-finger pinch anywhere in the app steps the "Text size" ladder. Mounted
  // here rather than on the thread alone: text size is one app-wide setting, so
  // the gesture that changes it works on every screen, sign-in included.
  usePinchFontSize();

  return (
    <ToastProvider>
      <LoginDialogProvider>
        <Analytics />
        <AppUpdateWatcher />
        <FeedBarProvider>
          <CloudSyncBridge />
          <HnFavoritesSyncBridge />
          <ScrollToTop />
          <AppHeader />
          <main className="app-main">
            {/* The fallback matches the pages' own loading convention
                (AdminPage / SearchPage / UserPage all render an aria-busy
                paragraph while their data loads), so a slow chunk fetch
                reads as the same brief loading state. */}
            <Suspense fallback={<p aria-busy="true">Loading…</p>}>
              <Routes>
                {/* `/` renders the user's chosen home feed inline (top or
                    hot, default top) — same chrome as the deep-link route
                    for that feed, no redirect, URL stays `/`. The
                    preference is read via `useHomeFeed`; see SPEC.md
                    *Story feeds → /hot* and the drawer's Home picker. */}
                <Route path="/" element={<HomeRoute />} />
                {/* `/hot` is the heavily-filtered Top ∪ New view — see
                    SPEC.md *Story feeds → /hot*. Declared explicitly
                    ahead of the dynamic `/:feed` route so the latter
                    doesn't catch it and redirect to /top via FeedPage's
                    isFeed() guard. */}
                <Route path="/hot" element={<HotStoryList />} />
                <Route path="/opened" element={<OpenedPage />} />
                <Route path="/hidden" element={<HiddenPage />} />
                <Route
                  path="/ignored"
                  element={<Navigate to="/hidden" replace />}
                />
                <Route path="/done" element={<DonePage />} />
                <Route path="/pinned" element={<PinnedPage />} />
                <Route path="/favorites" element={<FavoritesPage />} />
                <Route path="/offline" element={<OfflinePage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/help" element={<HelpPage />} />
                <Route path="/about" element={<AboutPage />} />
                <Route path="/debug" element={<DebugPage />} />
                <Route path="/admin" element={<AdminPage />} />
                {/* `/tuning` — operator-only Hot threshold tuning UI;
                    same auth gate as `/admin`. Pulled out of the
                    AdminPage so the event list and expression
                    preview have proper room. */}
                <Route path="/tuning" element={<ThresholdTuningPage />} />
                <Route path="/login" element={<LoginPage />} />
                <Route path="/search" element={<SearchPage />} />
                <Route path="/item/:id" element={<ItemPage />} />
                <Route path="/user/:id" element={<UserPage />} />
                <Route path="/:feed" element={<FeedPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </Suspense>
          </main>
          <KeyboardShortcutsOverlay />
        </FeedBarProvider>
      </LoginDialogProvider>
    </ToastProvider>
  );
}
