import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AppDrawer } from './AppDrawer';
import { isFeed } from '../lib/feeds';
import { useFeedBar } from '../hooks/useFeedBar';
import './AppHeader.css';

function useIsFeedPage(): boolean {
  const { pathname } = useLocation();
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

export function AppHeader() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const {
    sweep,
    sweepCount,
    canUndo,
    undo,
  } = useFeedBar();

  const onFeedPage = useIsFeedPage();
  // sweepCount is > 0 iff there are fully-visible, unpinned rows to dismiss;
  // the number itself is never surfaced to users.
  const canSweep = !!sweep && sweepCount > 0;

  return (
    <>
      <header className="app-header" role="banner">
        <button
          type="button"
          className="app-header__menu-btn"
          aria-label="Open menu"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <span aria-hidden="true" className="app-header__menu-icon">
            ☰
          </span>
        </button>
        <Link
          to="/top"
          className="app-header__home"
          aria-label="hnews.app home"
        >
          <span className="app-header__brand" aria-hidden="true">
            h
          </span>
          <span className="app-header__title">hnews.app</span>
        </Link>
        {onFeedPage ? (
          <div className="app-header__actions">
            <button
              type="button"
              className="app-header__icon-btn"
              data-testid="undo-btn"
              onClick={canUndo ? undo : undefined}
              disabled={!canUndo}
              aria-label={canUndo ? 'Undo dismiss' : 'Nothing to undo'}
              title={canUndo ? 'Undo dismiss' : 'Nothing to undo'}
            >
              <UndoIcon />
            </button>
            <button
              type="button"
              className="app-header__icon-btn"
              data-testid="sweep-btn"
              onClick={canSweep ? sweep : undefined}
              disabled={!canSweep}
              aria-label={canSweep ? 'Dismiss unpinned' : 'Nothing to dismiss'}
              title={canSweep ? 'Dismiss unpinned' : 'Nothing to dismiss'}
            >
              <SweepIcon />
            </button>
          </div>
        ) : null}
      </header>
      <AppDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </>
  );
}
