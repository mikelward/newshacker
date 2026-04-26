import { Navigate, Route, Routes } from 'react-router-dom';
import { Analytics } from '@vercel/analytics/react';
import { AppHeader } from './components/AppHeader';
import { AppUpdateWatcher } from './components/AppUpdateWatcher';
import { BootPrefetch } from './components/BootPrefetch';
import { ScrollToTop } from './components/ScrollToTop';
import { FeedBarProvider } from './components/FeedBarContext';
import { HomePromoCard } from './components/HomePromoCard';
import { HotStoryList, StoryList } from './components/StoryList';
import { ToastProvider } from './components/Toast';
import { useCloudSync } from './hooks/useCloudSync';
import { useHnFavoritesSync } from './hooks/useHnFavoritesSync';
import { useHomeFeed } from './hooks/useHomeFeed';
import { FeedPage } from './pages/FeedPage';
import { ItemPage } from './pages/ItemPage';
import { UserPage } from './pages/UserPage';
import { OpenedPage } from './pages/OpenedPage';
import { HiddenPage } from './pages/HiddenPage';
import { DonePage } from './pages/DonePage';
import { PinnedPage } from './pages/PinnedPage';
import { FavoritesPage } from './pages/FavoritesPage';
import { HelpPage } from './pages/HelpPage';
import { AboutPage } from './pages/AboutPage';
import { DebugPage } from './pages/DebugPage';
import { AdminPage } from './pages/AdminPage';
import { ThresholdTuningPage } from './pages/ThresholdTuningPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';

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
  // Default home: top feed with a one-row dismissible banner pointing
  // readers at `/hot` (see SPEC.md *Story feeds → /hot* → home promo).
  // Banner is gone once dismissed; on `/hot` itself the `<HotRuleCard>`
  // already sits in this slot, so we don't double-stack.
  return (
    <>
      <HomePromoCard />
      <StoryList feed="top" />
    </>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Analytics />
      <AppUpdateWatcher />
      <FeedBarProvider>
        <BootPrefetch />
        <CloudSyncBridge />
        <HnFavoritesSyncBridge />
        <ScrollToTop />
        <AppHeader />
        <main className="app-main">
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
            <Route path="/item/:id" element={<ItemPage />} />
            <Route path="/user/:id" element={<UserPage />} />
            <Route path="/:feed" element={<FeedPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
      </FeedBarProvider>
    </ToastProvider>
  );
}
