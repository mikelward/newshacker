import { useCallback, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useFeedBar } from '../hooks/useFeedBar';
import { useHotThresholds } from '../hooks/useHotThresholds';
import {
  DEFAULT_HOT_THRESHOLDS,
  HOT_THRESHOLD_BOUNDS,
  getStoredHotThresholds,
  hasAnyEnabledBranch,
  type HotThresholds,
} from '../lib/hotThresholds';
import {
  dismissHomePromo,
  isHomePromoDismissed,
} from '../lib/homePromo';
import { TooltipButton } from './TooltipButton';
import './ListToolbar.css';

// List-view toolbar — the bar pinned above every list view (feed and
// library). Always shows the Undo and Sweep buttons on the right; on
// `/hot` it also hosts the Hot rule customize button + expandable panel
// on the left. On `/` (home top feed) it instead hosts the one-row
// dismissible promo link pointing readers at `/hot`. Sits inside the
// same logical column as the story list (full width, 12px gutter
// matching `.story-row`'s padding).
//
// Right-aligned controls (Sweep, Undo) hug the right edge via
// `margin-left: auto`. Future per-source visibility toggles for
// `/top`, `/new`, pinned overlay etc. would slot in next to them.

interface Props {
  /** When true, the bar renders the Hot rule customize button (with
   *  the expanded panel below it). Only `/hot` sets this. */
  showHotCustomize?: boolean;
  /** When true, the bar renders the one-row "Try the Hot view" link
   *  on the left + a dismiss button. Only `/` (home top feed) sets
   *  this; suppressed once the reader has dismissed the promo. */
  showHomePromo?: boolean;
}

interface BranchControlsProps {
  legend: string;
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  numA: {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    onChange: (next: number) => void;
  };
  numB: {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    onChange: (next: number) => void;
  };
}

function BranchControls({
  legend,
  enabled,
  onEnabledChange,
  numA,
  numB,
}: BranchControlsProps) {
  const enabledId = useId();
  const aId = useId();
  const bId = useId();
  return (
    <fieldset className="hot-rule-card__branch">
      <legend className="hot-rule-card__legend">
        <input
          id={enabledId}
          type="checkbox"
          className="hot-rule-card__toggle"
          checked={enabled}
          onChange={(e) => onEnabledChange(e.target.checked)}
        />
        <label htmlFor={enabledId} className="hot-rule-card__legend-label">
          {legend}
        </label>
      </legend>
      <div
        className="hot-rule-card__rows"
        data-disabled={enabled ? undefined : 'true'}
      >
        <div className="hot-rule-card__row">
          <label htmlFor={aId} className="hot-rule-card__row-label">
            {numA.label}
            <span className="hot-rule-card__row-value">{numA.value}</span>
          </label>
          <input
            id={aId}
            type="range"
            className="hot-rule-card__slider"
            min={numA.min}
            max={numA.max}
            step={numA.step}
            value={numA.value}
            disabled={!enabled}
            onChange={(e) => numA.onChange(Number(e.target.value))}
          />
        </div>
        <div className="hot-rule-card__row">
          <label htmlFor={bId} className="hot-rule-card__row-label">
            {numB.label}
            <span className="hot-rule-card__row-value">{numB.value}</span>
          </label>
          <input
            id={bId}
            type="range"
            className="hot-rule-card__slider"
            min={numB.min}
            max={numB.max}
            step={numB.step}
            value={numB.value}
            disabled={!enabled}
            onChange={(e) => numB.onChange(Number(e.target.value))}
          />
        </div>
      </div>
    </fieldset>
  );
}

// Material Symbols Outlined — Apache 2.0, Google.
const MS_VIEWBOX = '0 -960 960 960';

function TuneIcon() {
  return (
    <svg
      className="list-toolbar__icon"
      viewBox={MS_VIEWBOX}
      width="24"
      height="24"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M440-120v-240h80v80h320v80H520v80h-80Zm-320-80v-80h240v80H120Zm160-160v-80H120v-80h160v-80h80v240h-80Zm160-80v-80h400v80H440Zm160-160v-240h80v80h160v80H680v80h-80Zm-480-80v-80h400v80H120Z"
      />
    </svg>
  );
}

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

function CloseIcon() {
  return (
    <svg
      viewBox={MS_VIEWBOX}
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z"
      />
    </svg>
  );
}

// One-row promo pointing readers at `/hot` from the default home view —
// rendered inline in the toolbar so the bar stays single-row. The link
// is the stretched left tap zone; the dismiss button sits between it
// and the right-aligned Undo / Sweep group. Once dismissed, the flag
// persists to localStorage (see `lib/homePromo`) and the link never
// re-renders for that browser — but the rest of the toolbar
// (Undo / Sweep) stays put.
function HomePromoLink() {
  const [dismissed, setDismissed] = useState<boolean>(() =>
    isHomePromoDismissed(),
  );

  if (dismissed) return null;

  const onDismiss = () => {
    dismissHomePromo();
    setDismissed(true);
  };

  return (
    <>
      <Link
        to="/hot"
        className="list-toolbar__promo-link"
        data-testid="home-promo-link"
      >
        Try the Hot view
      </Link>
      <TooltipButton
        type="button"
        tooltip="Dismiss"
        aria-label="Dismiss"
        className="list-toolbar__button"
        onClick={onDismiss}
        data-testid="home-promo-dismiss"
      >
        <CloseIcon />
      </TooltipButton>
    </>
  );
}

interface HotPanelProps {
  panelId: string;
}

function HotPanel({ panelId }: HotPanelProps) {
  const { prefs, save } = useHotThresholds();
  // Re-read the stored prefs at apply time rather than merging into
  // the captured render-time `prefs`. Two patches landing between
  // renders (e.g. dragging slider A then immediately slider B before
  // React commits the listener-driven setPrefs) would otherwise both
  // apply against the same stale baseline and the second clobber the
  // first. Reading from storage means each merge sees whatever the
  // previous patch persisted. (Copilot review on PR #240.)
  const update = useCallback(
    (patch: Partial<HotThresholds>) => {
      save({ ...getStoredHotThresholds(), ...patch });
    },
    [save],
  );

  const onReset = useCallback(() => {
    save({ ...DEFAULT_HOT_THRESHOLDS });
  }, [save]);

  const bothOff = !hasAnyEnabledBranch(prefs);

  return (
    <div id={panelId} className="hot-rule-card__body">
      <BranchControls
        legend="Top"
        enabled={prefs.topEnabled}
        onEnabledChange={(next) => update({ topEnabled: next })}
        numA={{
          label: 'Min score',
          value: prefs.topScoreMin,
          min: HOT_THRESHOLD_BOUNDS.topScoreMin.min,
          max: HOT_THRESHOLD_BOUNDS.topScoreMin.max,
          step: HOT_THRESHOLD_BOUNDS.topScoreMin.step,
          onChange: (next) => update({ topScoreMin: next }),
        }}
        numB={{
          label: 'Min comments',
          value: prefs.topDescendantsMin,
          min: HOT_THRESHOLD_BOUNDS.topDescendantsMin.min,
          max: HOT_THRESHOLD_BOUNDS.topDescendantsMin.max,
          step: HOT_THRESHOLD_BOUNDS.topDescendantsMin.step,
          onChange: (next) => update({ topDescendantsMin: next }),
        }}
      />
      <div className="hot-rule-card__or" aria-hidden="true">
        or
      </div>
      <BranchControls
        legend="New"
        enabled={prefs.newEnabled}
        onEnabledChange={(next) => update({ newEnabled: next })}
        numA={{
          label: 'Min points/h',
          value: prefs.newVelocityMin,
          min: HOT_THRESHOLD_BOUNDS.newVelocityMin.min,
          max: HOT_THRESHOLD_BOUNDS.newVelocityMin.max,
          step: HOT_THRESHOLD_BOUNDS.newVelocityMin.step,
          onChange: (next) => update({ newVelocityMin: next }),
        }}
        numB={{
          label: 'Min comments',
          value: prefs.newDescendantsMin,
          min: HOT_THRESHOLD_BOUNDS.newDescendantsMin.min,
          max: HOT_THRESHOLD_BOUNDS.newDescendantsMin.max,
          step: HOT_THRESHOLD_BOUNDS.newDescendantsMin.step,
          onChange: (next) => update({ newDescendantsMin: next }),
        }}
      />
      {bothOff ? (
        <p className="hot-rule-card__hint" role="note">
          Both rules are off — turn one on to see stories.
        </p>
      ) : null}
      <div className="hot-rule-card__actions">
        <button
          type="button"
          className="hot-rule-card__reset"
          onClick={onReset}
          data-testid="hot-rule-card-reset"
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
}

function HotCustomizeButton({
  expanded,
  panelId,
  onToggle,
}: {
  expanded: boolean;
  panelId: string;
  onToggle: () => void;
}) {
  const { prefs } = useHotThresholds();
  const bothOff = !hasAnyEnabledBranch(prefs);
  return (
    <TooltipButton
      type="button"
      tooltip="Customize Hot rule"
      aria-label="Customize Hot rule"
      aria-expanded={expanded}
      aria-controls={panelId}
      className="list-toolbar__button"
      data-pressed={expanded || undefined}
      onClick={onToggle}
      data-testid="hot-rule-card-toggle"
    >
      <TuneIcon />
      {bothOff ? (
        <span
          className="list-toolbar__warning-dot"
          aria-hidden="true"
          data-testid="hot-rule-card-warning-dot"
        />
      ) : null}
    </TooltipButton>
  );
}

export function ListToolbar({
  showHotCustomize = false,
  showHomePromo = false,
}: Props) {
  const { sweep, sweepCount, canUndo, undo } = useFeedBar();
  const [hotExpanded, setHotExpanded] = useState(false);
  const hotPanelId = useId();
  // sweepCount is > 0 iff there are fully-visible, unpinned rows to hide;
  // the number itself is never surfaced to users.
  const canSweep = !!sweep && sweepCount > 0;

  return (
    <section className="list-toolbar" aria-label="List actions">
      <div className="list-toolbar__row" role="toolbar">
        {showHotCustomize ? (
          <HotCustomizeButton
            expanded={hotExpanded}
            panelId={hotPanelId}
            onToggle={() => setHotExpanded((e) => !e)}
          />
        ) : null}
        {showHomePromo ? <HomePromoLink /> : null}
        <div className="list-toolbar__right">
          <TooltipButton
            type="button"
            className="list-toolbar__button"
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
            className="list-toolbar__button"
            data-testid="sweep-btn"
            onClick={canSweep ? sweep : undefined}
            disabled={!canSweep}
            tooltip={canSweep ? 'Hide unpinned' : 'Nothing to hide'}
            aria-label={canSweep ? 'Hide unpinned' : 'Nothing to hide'}
          >
            <SweepIcon />
          </TooltipButton>
        </div>
      </div>
      {showHotCustomize && hotExpanded ? (
        <HotPanel panelId={hotPanelId} />
      ) : null}
    </section>
  );
}
