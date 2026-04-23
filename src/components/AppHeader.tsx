import { useCallback, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
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
  // header-chrome purposes (refresh button, sweep, offline pill).
  if (pathname === '/') return true;
  const first = pathname.split('/').filter(Boolean)[0];
  return !!first && isFeed(first);
}

// Material Symbols Outlined — Apache 2.0, Google. viewBox 0 -960 960 960,
// fill-based paths that take `color` via currentColor.
const MS_VIEWBOX = '0 -960 960 960';

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="24"
      height="24"
      aria-hidden="true"
      focusable="false"
      className={
        'app-header__refresh-icon' +
        (spinning ? ' app-header__refresh-icon--spinning' : '')
      }
    >
      <path d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" />
    </svg>
  );
}

export function AppHeader() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { refresh } = useFeedBar();
  const online = useOnlineStatus();
  const [refreshing, setRefreshing] = useState(false);

  const onFeedPage = useIsFeedPage();
  const canRefresh = !!refresh && online && !refreshing;
  const handleRefresh = useCallback(async () => {
    if (!refresh || refreshing) return;
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh, refreshing]);
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
        {onFeedPage ? (
          <div className="app-header__actions">
            {offlinePill}
            <TooltipButton
              type="button"
              className="app-header__icon-btn"
              data-testid="refresh-btn"
              onClick={canRefresh ? handleRefresh : undefined}
              disabled={!canRefresh}
              tooltip={
                refreshing
                  ? 'Refreshing'
                  : online
                    ? 'Refresh'
                    : 'Refresh (offline)'
              }
              aria-label={refreshing ? 'Refreshing' : 'Refresh'}
              aria-busy={refreshing || undefined}
            >
              <RefreshIcon spinning={refreshing} />
            </TooltipButton>
            <HeaderAccountMenu />
          </div>
        ) : (
          <div className="app-header__actions">
            {offlinePill}
            <HeaderAccountMenu />
          </div>
        )}
      </header>
      <AppDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </>
  );
}
