import { Navigate, Route, Routes } from 'react-router-dom';
import { Analytics } from '@vercel/analytics/react';
import { AppHeader } from './components/AppHeader';
import { AppUpdateWatcher } from './components/AppUpdateWatcher';
import { BootPrefetch } from './components/BootPrefetch';
import { ScrollToTop } from './components/ScrollToTop';
import { FeedBarProvider } from './components/FeedBarContext';
import { StoryList } from './components/StoryList';
import { ToastProvider } from './components/Toast';
import { useCloudSync } from './hooks/useCloudSync';
import { useHnFavoritesSync } from './hooks/useHnFavoritesSync';
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
            {/* `/` renders the top feed inline — same chrome as /top, no
                redirect, URL stays `/`. Both routes share the same
                underlying StoryList so the two entry points behave
                identically. A future change will read a user setting
                here to pick which feed `/` serves; see TODO.md. */}
            <Route path="/" element={<StoryList feed="top" />} />
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
