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
  const {
    sweep,
    sweepCount,
    refresh,
    canUndo,
    undo,
  } = useFeedBar();
  const online = useOnlineStatus();
  const [refreshing, setRefreshing] = useState(false);

  const onFeedPage = useIsFeedPage();
  // sweepCount is > 0 iff there are fully-visible, unpinned rows to hide;
  // the number itself is never surfaced to users.
  const canSweep = !!sweep && sweepCount > 0;
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
          aria-label="nack.news home"
        >
          <span className="app-header__brand" aria-hidden="true" />
          <span className="app-header__title">nack.news</span>
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
            <HeaderAccountMenu />
          </div>
        )}
      </header>
      <AppDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </>
  );
}
