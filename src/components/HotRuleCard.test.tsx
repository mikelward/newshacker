import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotRuleCard } from './HotRuleCard';
import {
  DEFAULT_HOT_THRESHOLDS,
  HOT_THRESHOLDS_STORAGE_KEY,
  getStoredHotThresholds,
  setStoredHotThresholds,
} from '../lib/hotThresholds';

describe('<HotRuleCard>', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('renders the collapsed toolbar with just the customize button', () => {
    render(<HotRuleCard />);
    // Customize button is present and labeled (icon-only, so the
    // accessible name comes from `aria-label`).
    const button = screen.getByRole('button', {
      name: 'Customize Hot rule',
    });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    // Body controls and warning dot aren't present until expanded /
    // both-off conditions are met.
    expect(screen.queryByLabelText('Min score')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('hot-rule-card-warning-dot'),
    ).not.toBeInTheDocument();
  });

  it('clicking the customize button reveals the panel and a Reset button', async () => {
    const user = userEvent.setup();
    render(<HotRuleCard />);
    await user.click(screen.getByTestId('hot-rule-card-toggle'));
    expect(screen.getByTestId('hot-rule-card-toggle')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByLabelText(/Min score/)).toBeInTheDocument();
    // "Min comments" appears once in the Top branch and once in the New branch.
    expect(screen.getAllByLabelText(/Min comments/)).toHaveLength(2);
    expect(screen.getByLabelText(/Min points\/h/)).toBeInTheDocument();
    expect(screen.getByTestId('hot-rule-card-reset')).toBeInTheDocument();
  });

  it('toggling Top off persists the change to localStorage', async () => {
    const user = userEvent.setup();
    render(<HotRuleCard />);
    await user.click(screen.getByTestId('hot-rule-card-toggle'));
    // Each branch fieldset has a "Top"/"New" checkbox; click the Top one.
    await user.click(screen.getByLabelText('Top'));
    expect(getStoredHotThresholds().topEnabled).toBe(false);
  });

  it('shows the warning dot on the customize button when both branches are off', async () => {
    const user = userEvent.setup();
    setStoredHotThresholds(
      {
        ...DEFAULT_HOT_THRESHOLDS,
        topEnabled: false,
        newEnabled: false,
      },
      1,
    );
    render(<HotRuleCard />);
    // Visual cue on the collapsed button — the user shouldn't have to
    // open the panel to learn that the rule is off.
    expect(
      screen.getByTestId('hot-rule-card-warning-dot'),
    ).toBeInTheDocument();
    // The in-panel hint still renders inside the body when expanded.
    await user.click(screen.getByTestId('hot-rule-card-toggle'));
    expect(
      screen.getByText(/turn one on to see stories/),
    ).toBeInTheDocument();
  });

  it('Reset to defaults restores DEFAULT_HOT_THRESHOLDS', async () => {
    const user = userEvent.setup();
    setStoredHotThresholds(
      {
        ...DEFAULT_HOT_THRESHOLDS,
        topEnabled: false,
        newVelocityMin: 99,
      },
      1,
    );
    render(<HotRuleCard />);
    await user.click(screen.getByTestId('hot-rule-card-toggle'));
    await user.click(screen.getByTestId('hot-rule-card-reset'));
    const out = getStoredHotThresholds();
    expect(out.topEnabled).toBe(DEFAULT_HOT_THRESHOLDS.topEnabled);
    expect(out.newVelocityMin).toBe(DEFAULT_HOT_THRESHOLDS.newVelocityMin);
  });

  it('disabling a branch dims its rows but keeps the slider readable', async () => {
    const user = userEvent.setup();
    render(<HotRuleCard />);
    await user.click(screen.getByTestId('hot-rule-card-toggle'));
    const minScoreSlider = screen.getByLabelText(/Min score/) as HTMLInputElement;
    expect(minScoreSlider.disabled).toBe(false);
    await user.click(screen.getByLabelText('Top'));
    expect(minScoreSlider.disabled).toBe(true);
  });

  it('persists pre-existing prefs (storage key remains stable)', () => {
    setStoredHotThresholds(
      { ...DEFAULT_HOT_THRESHOLDS, topScoreMin: 150 },
      1,
    );
    expect(window.localStorage.getItem(HOT_THRESHOLDS_STORAGE_KEY)).toContain(
      '"topScoreMin":150',
    );
  });

  it('back-to-back slider changes both stick (no stale-prefs clobber)', async () => {
    // Regression for the race Copilot flagged on PR #240: when two
    // patches fire between renders, the second must not merge against
    // the captured render-time `prefs` and clobber the first. We
    // simulate the race with two synchronous `fireEvent.change` calls
    // — between them React hasn't committed a re-render, so without
    // the fix the second `update()` would read stale `prefs` and drop
    // the first patch.
    const user = userEvent.setup();
    render(<HotRuleCard />);
    await user.click(screen.getByTestId('hot-rule-card-toggle'));

    const minScore = screen.getByLabelText(/Min score/) as HTMLInputElement;
    const minVelocity = screen.getByLabelText(
      /Min points\/h/,
    ) as HTMLInputElement;

    fireEvent.change(minScore, { target: { value: '150' } });
    fireEvent.change(minVelocity, { target: { value: '25' } });

    const stored = getStoredHotThresholds();
    expect(stored.topScoreMin).toBe(150);
    expect(stored.newVelocityMin).toBe(25);
  });
});
