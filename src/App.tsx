import { Navigate, Route, Routes } from 'react-router-dom';
import { Analytics } from '@vercel/analytics/react';
import { AppHeader } from './components/AppHeader';
import { BootPrefetch } from './components/BootPrefetch';
import { PwaUpdateToast } from './components/PwaUpdateToast';
import { ScrollToTop } from './components/ScrollToTop';
import { FeedBarProvider } from './components/FeedBarContext';
import { ToastProvider } from './components/Toast';
import { useCloudSync } from './hooks/useCloudSync';
import { FeedPage } from './pages/FeedPage';
import { ItemPage } from './pages/ItemPage';
import { UserPage } from './pages/UserPage';
import { OpenedPage } from './pages/OpenedPage';
import { HiddenPage } from './pages/HiddenPage';
import { PinnedPage } from './pages/PinnedPage';
import { FavoritesPage } from './pages/FavoritesPage';
import { HelpPage } from './pages/HelpPage';
import { AboutPage } from './pages/AboutPage';
import { DebugPage } from './pages/DebugPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';

function CloudSyncBridge() {
  useCloudSync();
  return null;
}

export default function App() {
  return (
    <ToastProvider>
      <Analytics />
      <PwaUpdateToast />
      <FeedBarProvider>
        <BootPrefetch />
        <CloudSyncBridge />
        <ScrollToTop />
        <AppHeader />
        <main className="app-main">
          <Routes>
            <Route path="/" element={<Navigate to="/top" replace />} />
            <Route path="/opened" element={<OpenedPage />} />
            <Route path="/hidden" element={<HiddenPage />} />
            <Route
              path="/ignored"
              element={<Navigate to="/hidden" replace />}
            />
            <Route path="/pinned" element={<PinnedPage />} />
            <Route path="/favorites" element={<FavoritesPage />} />
            <Route path="/help" element={<HelpPage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="/debug" element={<DebugPage />} />
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
