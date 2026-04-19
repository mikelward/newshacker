import { Navigate, Route, Routes } from 'react-router-dom';
import { AppHeader } from './components/AppHeader';
import { BootPrefetch } from './components/BootPrefetch';
import { ScrollToTop } from './components/ScrollToTop';
import { FeedBarProvider } from './components/FeedBarContext';
import { ToastProvider } from './components/Toast';
import { FeedPage } from './pages/FeedPage';
import { ItemPage } from './pages/ItemPage';
import { UserPage } from './pages/UserPage';
import { OpenedPage } from './pages/OpenedPage';
import { IgnoredPage } from './pages/IgnoredPage';
import { PinnedPage } from './pages/PinnedPage';
import { FavoritesPage } from './pages/FavoritesPage';
import { HelpPage } from './pages/HelpPage';
import { AboutPage } from './pages/AboutPage';
import { NotFoundPage } from './pages/NotFoundPage';

export default function App() {
  return (
    <ToastProvider>
      <FeedBarProvider>
        <BootPrefetch />
        <ScrollToTop />
        <AppHeader />
        <main className="app-main">
          <Routes>
            <Route path="/" element={<Navigate to="/top" replace />} />
            <Route path="/opened" element={<OpenedPage />} />
            <Route path="/ignored" element={<IgnoredPage />} />
            <Route path="/pinned" element={<PinnedPage />} />
            <Route path="/favorites" element={<FavoritesPage />} />
            <Route path="/help" element={<HelpPage />} />
            <Route path="/about" element={<AboutPage />} />
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
