import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AppDrawer } from './AppDrawer';
import { HeaderAccountMenu } from './HeaderAccountMenu';
import { TooltipButton } from './TooltipButton';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import './AppHeader.css';

export function AppHeader() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const online = useOnlineStatus();

  const offlinePill = !online ? (
    <span
      className="app-header__offline"
      data-testid="offline-indicator"
      role="status"
      aria-live="polite"
      title="You are offline. Pinned and recently viewed stories remain available."
    >
      Offline
    </span>
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
          <span className="app-header__brand" aria-hidden="true">
            n
          </span>
          <span className="app-header__title">newshacker</span>
        </Link>
        <div className="app-header__actions">
          {offlinePill}
          <HeaderAccountMenu />
        </div>
      </header>
      <AppDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </>
  );
}
