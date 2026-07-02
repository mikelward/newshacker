import { useCallback, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AppDrawer } from './AppDrawer';
import { HeaderAccountMenu } from './HeaderAccountMenu';
import { TooltipButton } from './TooltipButton';
import { useConnectivityStatus } from '../hooks/useOnlineStatus';
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

export function AppHeader() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const connectivity = useConnectivityStatus();
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
  // One pill, two evidence-labeled states: 'offline' means the device has no
  // network (or requests throw with no response); 'down' means the backend
  // answered a 5xx on the core data plane — reachable but erroring, so "you
  // are offline" would be the wrong message. Both link to /offline because
  // cached stories keep working either way.
  const offlinePill =
    connectivity === 'offline' ? (
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
    ) : connectivity === 'down' ? (
      <Link
        to="/offline"
        className="app-header__offline"
        data-testid="down-indicator"
        aria-label="Server down. View offline stories."
        title="The story server is having trouble. Stories cached on this device still work."
      >
        <span role="status" aria-live="polite">
          Down
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
          <HeaderAccountMenu />
        </div>
      </header>
      <AppDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </>
  );
}
