import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AppDrawer } from './AppDrawer';
import { isFeed } from '../lib/feeds';
import { useFeedBar } from '../hooks/useFeedBar';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { toggleRecording, useLayoutDebug } from '../hooks/useLayoutDebug';
import { useToast } from '../hooks/useToast';
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

// Material Symbols "straighten" — a ruler. Used for the temporary layout
// debug toggle; remove with the rest of the instrumentation once the
// skeleton sizes are dialed in.
function RulerIcon() {
  return (
    <svg
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="24"
      height="24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M120-120v-720h720v720H120Zm80-80h560v-560H200v560Zm40-120v-80h80v-80h-80v-80h80v-80h-80v-80h80v-80h80v560h-80v-80h-80Zm240 0v-80h80v-80h-80v-80h80v-80h-80v-80h80v-80h80v560h-80Z" />
    </svg>
  );
}

function LayoutDebugButton() {
  const { recording, count } = useLayoutDebug();
  const { showToast } = useToast();

  const handleClick = async () => {
    const result = toggleRecording();
    if (result.kind === 'started') {
      showToast({
        message: 'Recording layout data. Tap the ruler again to stop.',
        groupKey: 'layout-debug',
      });
      return;
    }
    if (result.samples.length === 0) {
      showToast({
        message: 'No samples recorded — visit some threads first.',
        groupKey: 'layout-debug',
      });
      return;
    }
    const text = JSON.stringify(result.samples, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      showToast({
        message: `Copied ${result.samples.length} sample${result.samples.length === 1 ? '' : 's'} to clipboard.`,
        groupKey: 'layout-debug',
      });
    } catch {
      showToast({
        message: `Recorded ${result.samples.length} sample${result.samples.length === 1 ? '' : 's'} — clipboard copy failed.`,
        groupKey: 'layout-debug',
      });
    }
  };

  return (
    <button
      type="button"
      className={
        'app-header__icon-btn' +
        (recording ? ' app-header__icon-btn--recording' : '')
      }
      data-testid="layout-debug-btn"
      onClick={handleClick}
      aria-label={
        recording
          ? `Stop layout recording (${count} sample${count === 1 ? '' : 's'})`
          : 'Start layout recording'
      }
      title={recording ? `Stop recording (${count})` : 'Record layout data'}
    >
      <RulerIcon />
      {recording && count > 0 ? (
        <span className="app-header__icon-badge" aria-hidden="true">
          {count}
        </span>
      ) : null}
    </button>
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

  const onFeedPage = useIsFeedPage();
  // sweepCount is > 0 iff there are fully-visible, unpinned rows to dismiss;
  // the number itself is never surfaced to users.
  const canSweep = !!sweep && sweepCount > 0;
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
          aria-label="newshacker home"
        >
          <span className="app-header__brand" aria-hidden="true">
            n
          </span>
          <span className="app-header__title">newshacker</span>
        </Link>
        <div className="app-header__actions">
          {offlinePill}
          {onFeedPage ? (
            <>
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
            </>
          ) : null}
          <LayoutDebugButton />
        </div>
      </header>
      <AppDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </>
  );
}
