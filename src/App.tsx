import { Navigate, Route, Routes } from 'react-router-dom';
import { AppHeader } from './components/AppHeader';
import { FeedPage } from './pages/FeedPage';
import { ItemPage } from './pages/ItemPage';
import { UserPage } from './pages/UserPage';
import { OpenedPage } from './pages/OpenedPage';
import { IgnoredPage } from './pages/IgnoredPage';
import { NotFoundPage } from './pages/NotFoundPage';

export default function App() {
  return (
    <>
      <AppHeader />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Navigate to="/top" replace />} />
          <Route path="/opened" element={<OpenedPage />} />
          <Route path="/ignored" element={<IgnoredPage />} />
          <Route path="/item/:id" element={<ItemPage />} />
          <Route path="/user/:id" element={<UserPage />} />
          <Route path="/:feed" element={<FeedPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </>
  );
}
