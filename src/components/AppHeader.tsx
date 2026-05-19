import { useCallback, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AppDrawer } from './AppDrawer';
import { HeaderAccountMenu } from './HeaderAccountMenu';
import { TooltipButton } from './TooltipButton';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useShareCurrentPage } from '../hooks/useShareCurrentPage';
import './AppHeader.css';

// Material Symbols Outlined — Apache 2.0, Google. viewBox 0 -960 960 960,
// fill-based paths that take `color` via currentColor.
const MS_VIEWBOX = '0 -960 960 960';

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

function ShareIcon() {
  return (
    <svg
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="24"
      height="24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M680-80q-50 0-85-35t-35-85q0-6 3-28L282-392q-16 15-37 23.5t-45 8.5q-50 0-85-35t-35-85q0-50 35-85t85-35q24 0 45 8.5t37 23.5l281-164q-2-7-2.5-13.5T560-760q0-50 35-85t85-35q50 0 85 35t35 85q0 50-35 85t-85 35q-24 0-45-8.5T598-672L317-508q2 7 2.5 13.5t.5 14.5q0 8-.5 14.5T317-452l281 164q16-15 37-23.5t45-8.5q50 0 85 35t35 85q0 50-35 85t-85 35Z" />
    </svg>
  );
}

export function AppHeader() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const online = useOnlineStatus();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // Search lives outside any feed-scoped grouping so its position
  // stays put across routes. Suppressed on /search itself to avoid a
  // button that navigates to the page you're on.
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
  const sharePage = useShareCurrentPage();
  const shareButton = (
    <TooltipButton
      type="button"
      className="app-header__icon-btn"
      data-testid="share-page-btn"
      tooltip="Share page"
      aria-label="Share this page"
      onClick={sharePage}
    >
      <ShareIcon />
    </TooltipButton>
  );
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
        <div className="app-header__actions">
          {offlinePill}
          {searchButton}
          {shareButton}
          <HeaderAccountMenu />
        </div>
      </header>
      <AppDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </>
  );
}
