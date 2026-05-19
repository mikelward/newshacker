import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ListToolbar } from './ListToolbar';
import { FeedBarProvider } from './FeedBarContext';
import {
  DEFAULT_HOT_THRESHOLDS,
  HOT_THRESHOLDS_STORAGE_KEY,
  getStoredHotThresholds,
  setStoredHotThresholds,
} from '../lib/hotThresholds';
import {
  HOME_PROMO_DISMISSED_STORAGE_KEY,
  isHomePromoDismissed,
} from '../lib/homePromo';

function renderWithFeedBar(ui: ReactElement) {
  return render(
    <MemoryRouter>
      <FeedBarProvider>{ui}</FeedBarProvider>
    </MemoryRouter>,
  );
}

describe('<ListToolbar>', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('renders Undo and Sweep buttons by default, both disabled when nothing to act on', () => {
    renderWithFeedBar(<ListToolbar />);
    const undo = screen.getByTestId('undo-btn');
    const sweep = screen.getByTestId('sweep-btn');
    expect(undo).toBeInTheDocument();
    expect(sweep).toBeInTheDocument();
    expect(undo).toBeDisabled();
    expect(sweep).toBeDisabled();
    expect(undo).toHaveAccessibleName(/nothing to undo/i);
    expect(sweep).toHaveAccessibleName(/nothing to hide/i);
  });

  it('omits the Hot customize button unless showHotCustomize is set', () => {
    renderWithFeedBar(<ListToolbar />);
    expect(screen.queryByTestId('hot-rule-card-toggle')).toBeNull();
  });

  it('with showHotCustomize, renders the collapsed customize button', () => {
    renderWithFeedBar(<ListToolbar showHotCustomize />);
    const button = screen.getByRole('button', { name: 'Customize Hot rule' });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Min score')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('hot-rule-card-warning-dot'),
    ).not.toBeInTheDocument();
  });

  it('clicking the customize button reveals the panel and a Reset button', async () => {
    const user = userEvent.setup();
    renderWithFeedBar(<ListToolbar showHotCustomize />);
    await user.click(screen.getByTestId('hot-rule-card-toggle'));
    expect(screen.getByTestId('hot-rule-card-toggle')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByLabelText(/Min score/)).toBeInTheDocument();
    expect(screen.getAllByLabelText(/Min comments/)).toHaveLength(2);
    expect(screen.getByLabelText(/Min points\/h/)).toBeInTheDocument();
    expect(screen.getByTestId('hot-rule-card-reset')).toBeInTheDocument();
  });

  it('toggling Top off persists the change to localStorage', async () => {
    const user = userEvent.setup();
    renderWithFeedBar(<ListToolbar showHotCustomize />);
    await user.click(screen.getByTestId('hot-rule-card-toggle'));
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
    renderWithFeedBar(<ListToolbar showHotCustomize />);
    expect(
      screen.getByTestId('hot-rule-card-warning-dot'),
    ).toBeInTheDocument();
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
    renderWithFeedBar(<ListToolbar showHotCustomize />);
    await user.click(screen.getByTestId('hot-rule-card-toggle'));
    await user.click(screen.getByTestId('hot-rule-card-reset'));
    const out = getStoredHotThresholds();
    expect(out.topEnabled).toBe(DEFAULT_HOT_THRESHOLDS.topEnabled);
    expect(out.newVelocityMin).toBe(DEFAULT_HOT_THRESHOLDS.newVelocityMin);
  });

  it('disabling a branch dims its rows but keeps the slider readable', async () => {
    const user = userEvent.setup();
    renderWithFeedBar(<ListToolbar showHotCustomize />);
    await user.click(screen.getByTestId('hot-rule-card-toggle'));
    const minScoreSlider = screen.getByLabelText(
      /Min score/,
    ) as HTMLInputElement;
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

  describe('with showHomePromo', () => {
    afterEach(() => {
      window.localStorage.removeItem(HOME_PROMO_DISMISSED_STORAGE_KEY);
    });

    it('renders the "Try the Hot view" link and a dismiss button', () => {
      renderWithFeedBar(<ListToolbar showHomePromo />);
      const link = screen.getByTestId('home-promo-link');
      expect(link).toHaveAttribute('href', '/hot');
      expect(link).toHaveTextContent(/^Try the Hot view$/);
      expect(screen.getByTestId('home-promo-dismiss')).toBeInTheDocument();
    });

    it('clicking dismiss hides the link and persists the flag, leaving Undo and Sweep in place', async () => {
      const user = userEvent.setup();
      renderWithFeedBar(<ListToolbar showHomePromo />);
      await user.click(screen.getByTestId('home-promo-dismiss'));
      expect(screen.queryByTestId('home-promo-link')).not.toBeInTheDocument();
      expect(
        screen.queryByTestId('home-promo-dismiss'),
      ).not.toBeInTheDocument();
      expect(isHomePromoDismissed()).toBe(true);
      // The rest of the toolbar (Undo / Sweep) remains rendered.
      expect(screen.getByTestId('undo-btn')).toBeInTheDocument();
      expect(screen.getByTestId('sweep-btn')).toBeInTheDocument();
    });

    it('does not render the promo when previously dismissed', () => {
      window.localStorage.setItem(HOME_PROMO_DISMISSED_STORAGE_KEY, '1');
      renderWithFeedBar(<ListToolbar showHomePromo />);
      expect(screen.queryByTestId('home-promo-link')).not.toBeInTheDocument();
      expect(
        screen.queryByTestId('home-promo-dismiss'),
      ).not.toBeInTheDocument();
      // Toolbar's right-side actions still render.
      expect(screen.getByTestId('undo-btn')).toBeInTheDocument();
      expect(screen.getByTestId('sweep-btn')).toBeInTheDocument();
    });

    it('omits the promo link by default', () => {
      renderWithFeedBar(<ListToolbar />);
      expect(screen.queryByTestId('home-promo-link')).not.toBeInTheDocument();
    });
  });

  it('back-to-back slider changes both stick (no stale-prefs clobber)', async () => {
    // Regression for the race Copilot flagged on PR #240.
    const user = userEvent.setup();
    renderWithFeedBar(<ListToolbar showHotCustomize />);
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
