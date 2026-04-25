import { useCallback, useId, useState } from 'react';
import { useHotThresholds } from '../hooks/useHotThresholds';
import {
  DEFAULT_HOT_THRESHOLDS,
  HOT_THRESHOLD_BOUNDS,
  getStoredHotThresholds,
  hasAnyEnabledBranch,
  type HotThresholds,
} from '../lib/hotThresholds';
import { TooltipButton } from './TooltipButton';
import './HotRuleCard.css';

// Hot toolbar — the row of controls pinned above `/hot`'s list view.
// Sits inside the same logical column as the story list (full width,
// 12px gutter matching `.story-row`'s padding) so the customize
// button aligns with every story row's content edge.
//
// Currently hosts a single icon button that opens the customize panel
// (rule branch toggles + four sliders + reset). Designed as a row so
// future list-view controls slot in without rebuilding the surface:
// rule-related controls stay left-aligned next to the customize
// button; right-aligned items (Sweep, Undo, per-source visibility
// toggles for /top, /new, pinned overlay, etc.) hug the right edge
// via `margin-left: auto`.
//
// TODO(naming): "Top" and "New" collide with HN's `/top` and `/new`
// feed names. Picked deliberately to defer the bikeshed; revisit
// once we have a clearer naming convention for "rule branches".
//
// Wishlist (deferred): a freeform expression editor (the one /tuning
// uses) would let power users write arbitrary rules. The two-toggle +
// four-slider shape covers ~all the tuning anyone needs without the
// `new Function()` round-trip an expression editor requires; revisit
// if there's actual demand.

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

// Material Symbols Outlined — Apache 2.0, Google. The "tune" glyph
// (sliders); reads as "adjust controls" and matches the panel's
// slider-driven shape.
function TuneIcon() {
  return (
    <svg
      className="hot-rule-card__icon"
      viewBox="0 -960 960 960"
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

export function HotRuleCard() {
  const { prefs, save } = useHotThresholds();
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();

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
    <section className="hot-toolbar" aria-label="Hot rule controls">
      <div className="hot-toolbar__row" role="toolbar">
        <TooltipButton
          type="button"
          tooltip="Customize Hot rule"
          aria-label="Customize Hot rule"
          aria-expanded={expanded}
          aria-controls={panelId}
          className="hot-toolbar__button"
          data-pressed={expanded || undefined}
          onClick={() => setExpanded((e) => !e)}
          data-testid="hot-rule-card-toggle"
        >
          <TuneIcon />
          {bothOff ? (
            <span
              className="hot-toolbar__warning-dot"
              aria-hidden="true"
              data-testid="hot-rule-card-warning-dot"
            />
          ) : null}
        </TooltipButton>
      </div>
      {expanded ? (
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
      ) : null}
    </section>
  );
}
