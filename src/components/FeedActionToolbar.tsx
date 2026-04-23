import { TooltipButton } from './TooltipButton';
import { useFeedBar } from '../hooks/useFeedBar';
import './FeedActionToolbar.css';

// Material Symbols Outlined — Apache 2.0, Google. Kept inline so the
// toolbar doesn't have to reach into AppHeader for its glyphs.
const MS_VIEWBOX = '0 -960 960 960';

function UndoIcon() {
  return (
    <svg
      className="feed-action-toolbar__icon"
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
      className="feed-action-toolbar__icon"
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

export function FeedActionToolbar() {
  const { sweep, sweepCount, canUndo, undo } = useFeedBar();
  const canSweep = !!sweep && sweepCount > 0;

  return (
    <div className="feed-action-toolbar" role="toolbar" aria-label="Feed actions">
      <TooltipButton
        type="button"
        className="feed-action-toolbar__btn"
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
        className="feed-action-toolbar__btn"
        data-testid="sweep-btn"
        onClick={canSweep ? sweep : undefined}
        disabled={!canSweep}
        tooltip={canSweep ? 'Hide unpinned' : 'Nothing to hide'}
        aria-label={canSweep ? 'Hide unpinned' : 'Nothing to hide'}
      >
        <SweepIcon />
      </TooltipButton>
    </div>
  );
}
