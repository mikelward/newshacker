import { useCallback, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AppDrawer } from './AppDrawer';
import { HeaderAccountMenu } from './HeaderAccountMenu';
import { TooltipButton } from './TooltipButton';
import { isFeed } from '../lib/feeds';
import { useFeedBar } from '../hooks/useFeedBar';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import './AppHeader.css';

function useIsFeedPage(): boolean {
  const { pathname } = useLocation();
  // Home (`/`) renders the top feed inline, so it's a feed page for
  // header-chrome purposes (sweep, undo, offline pill).
  if (pathname === '/') return true;
  const first = pathname.split('/').filter(Boolean)[0];
  return !!first && isFeed(first);
}

// Material Symbols Outlined — Apache 2.0, Google. viewBox 0 -960 960 960,
// fill-based paths that take `color` via currentColor.
const MS_VIEWBOX = '0 -960 960 960';

function UndoIcon() {
  return (
    <svg
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="24"
      height="24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M280-200v-80h284q63 0 109.5-40T720-420q0-60-46.5-100T564-560H312l104 104-56 56-200-200 200-200 56 56-104 104h252q97 0 166.5 63T800-420q0 94-69.5 157T564-200H280Z" />
    </svg>
  );
}

function SweepIcon() {
  return (
    <svg
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="24"
      height="24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M400-240v-80h240v80H400Zm-158 0L15-467l57-57 170 170 366-366 57 57-423 423Zm318-160v-80h240v80H560Zm160-160v-80h240v80H720Z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="24"
      height="24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M784-120 532-372q-30 24-69 38t-83 14q-109 0-184.5-75.5T120-580q0-109 75.5-184.5T380-840q109 0 184.5 75.5T640-580q0 44-14 83t-38 69l252 252-56 56ZM380-440q58 0 99-41t41-99q0-58-41-99t-99-41q-58 0-99 41t-41 99q0 58 41 99t99 41Z" />
    </svg>
  );
}

export function AppHeader() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const {
    sweep,
    sweepCount,
    canUndo,
    undo,
  } = useFeedBar();
  const online = useOnlineStatus();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const onFeedPage = useIsFeedPage();
  // Search lives outside the feed-scoped action group so its position
  // stays put across feed / non-feed routes. Suppressed on /search
  // itself to avoid a button that navigates to the page you're on.
  const showSearchButton = pathname !== '/search';
  const goToSearch = useCallback(() => navigate('/search'), [navigate]);
  const searchButton = showSearchButton ? (
    <TooltipButton
      type="button"
      className="app-header__icon-btn"
      data-testid="search-btn"
      tooltip="Search"
      aria-label="Search Hacker News"
      onClick={goToSearch}
    >
      <SearchIcon />
    </TooltipButton>
  ) : null;
  // sweepCount is > 0 iff there are fully-visible, unpinned rows to hide;
  // the number itself is never surfaced to users.
  const canSweep = !!sweep && sweepCount > 0;
  const offlinePill = !online ? (
    <Link
      to="/offline"
      className="app-header__offline"
      data-testid="offline-indicator"
      aria-label="Offline. View offline stories."
      title="You are offline. View stories cached on this device."
    >
      <span role="status" aria-live="polite">
        Offline
      </span>
    </Link>
  ) : null;

  return (
    <>
      <header className="app-header" role="banner">
        <TooltipButton
          type="button"
          className="app-header__menu-btn"
          tooltip="Menu"
          aria-label="Open menu"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <span aria-hidden="true" className="app-header__menu-icon">
            ☰
          </span>
        </TooltipButton>
        <Link
          to="/"
          className="app-header__home"
          aria-label="newshacker home"
        >
          <span className="app-header__brand" aria-hidden="true" />
          <span className="app-header__title">newshacker</span>
        </Link>
        {onFeedPage ? (
          <div className="app-header__actions">
            {offlinePill}
            {searchButton}
            <TooltipButton
              type="button"
              className="app-header__icon-btn"
              data-testid="undo-btn"
              onClick={canUndo ? undo : undefined}
              disabled={!canUndo}
              tooltip={canUndo ? 'Undo hide' : 'Nothing to undo'}
              aria-label={canUndo ? 'Undo hide' : 'Nothing to undo'}
            >
              <UndoIcon />
            </TooltipButton>
            <TooltipButton
              type="button"
              className="app-header__icon-btn"
              data-testid="sweep-btn"
              onClick={canSweep ? sweep : undefined}
              disabled={!canSweep}
              tooltip={canSweep ? 'Hide unpinned' : 'Nothing to hide'}
              aria-label={canSweep ? 'Hide unpinned' : 'Nothing to hide'}
            >
              <SweepIcon />
            </TooltipButton>
            <HeaderAccountMenu />
          </div>
        ) : (
          <div className="app-header__actions">
            {offlinePill}
            {searchButton}
            <HeaderAccountMenu />
          </div>
        )}
      </header>
      <AppDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </>
  );
}
