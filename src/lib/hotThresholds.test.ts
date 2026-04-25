import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HOT_THRESHOLDS,
  HOT_THRESHOLDS_CHANGE_EVENT,
  HOT_THRESHOLDS_STORAGE_KEY,
  HOT_THRESHOLD_BOUNDS,
  clearStoredHotThresholds,
  evalHot,
  getStoredHotThresholds,
  hasAnyEnabledBranch,
  replaceHotThresholds,
  setStoredHotThresholds,
  type HotThresholds,
} from './hotThresholds';

describe('evalHot', () => {
  const now = new Date('2026-04-25T12:00:00Z');
  const nowS = Math.floor(now.getTime() / 1000);

  it('matches the production rule on default thresholds', () => {
    // Big-story branch: score 250, descendants 150, age 20h.
    expect(
      evalHot({ score: 250, descendants: 150, time: nowS - 20 * 3600 }, now),
    ).toBe(true);
    // Velocity branch: 50 points in 1h with 25 comments.
    expect(
      evalHot({ score: 50, descendants: 25, time: nowS - 3600 }, now),
    ).toBe(true);
    // Neither branch matches: low score, low velocity, low comments.
    expect(
      evalHot({ score: 50, descendants: 5, time: nowS - 10 * 3600 }, now),
    ).toBe(false);
  });

  it('uses >= (not >) so boundary values match', () => {
    // Exactly at the big-story boundary.
    expect(
      evalHot({ score: 200, descendants: 100, time: nowS - 20 * 3600 }, now),
    ).toBe(true);
    // Exactly at the velocity boundary: 30 points / 2h = 15 pts/h, 10 comments.
    expect(
      evalHot({ score: 30, descendants: 10, time: nowS - 2 * 3600 }, now),
    ).toBe(true);
  });

  it('topEnabled=false removes the score branch from the OR', () => {
    const t: HotThresholds = { ...DEFAULT_HOT_THRESHOLDS, topEnabled: false };
    // A pure big-story (score 500, low velocity) used to qualify.
    expect(
      evalHot({ score: 500, descendants: 300 }, now, t),
    ).toBe(false);
    // A fast riser with descendants gate met still qualifies via the
    // velocity branch.
    expect(
      evalHot({ score: 50, descendants: 25, time: nowS - 3600 }, now, t),
    ).toBe(true);
  });

  it('newEnabled=false removes the velocity branch from the OR', () => {
    const t: HotThresholds = { ...DEFAULT_HOT_THRESHOLDS, newEnabled: false };
    // Fast riser without big-story qualification: nothing matches.
    expect(
      evalHot({ score: 50, descendants: 25, time: nowS - 3600 }, now, t),
    ).toBe(false);
    // Big-story still matches.
    expect(
      evalHot({ score: 500, descendants: 300 }, now, t),
    ).toBe(true);
  });

  it('both branches off → never matches', () => {
    const t: HotThresholds = {
      ...DEFAULT_HOT_THRESHOLDS,
      topEnabled: false,
      newEnabled: false,
    };
    expect(
      evalHot({ score: 5000, descendants: 5000, time: nowS - 60 }, now, t),
    ).toBe(false);
  });

  it('a slider at 0 effectively removes that gate within the branch', () => {
    // topScoreMin=0, topDescendantsMin=100: any score qualifies, but
    // still need 100 comments.
    const t: HotThresholds = { ...DEFAULT_HOT_THRESHOLDS, topScoreMin: 0 };
    expect(evalHot({ score: 1, descendants: 150 }, now, t)).toBe(true);
    expect(evalHot({ score: 1, descendants: 99 }, now, t)).toBe(false);
  });

  it('both gates in an enabled branch at 0 → branch matches everything', () => {
    const t: HotThresholds = {
      ...DEFAULT_HOT_THRESHOLDS,
      topScoreMin: 0,
      topDescendantsMin: 0,
    };
    // Any story with no time fails the velocity branch (time-required)
    // but the wide-open top branch lights up regardless.
    expect(evalHot({ score: 0, descendants: 0 }, now, t)).toBe(true);
  });

  it('treats missing time as an automatic velocity-branch miss', () => {
    expect(
      evalHot({ score: 50, descendants: 25 }, now),
    ).toBe(false);
  });

  it('treats future time as an automatic velocity-branch miss', () => {
    expect(
      evalHot({ score: 100, descendants: 50, time: nowS + 60 }, now),
    ).toBe(false);
  });
});

describe('hasAnyEnabledBranch', () => {
  it('reports true when at least one branch is enabled', () => {
    expect(hasAnyEnabledBranch(DEFAULT_HOT_THRESHOLDS)).toBe(true);
    expect(
      hasAnyEnabledBranch({ ...DEFAULT_HOT_THRESHOLDS, topEnabled: false }),
    ).toBe(true);
    expect(
      hasAnyEnabledBranch({ ...DEFAULT_HOT_THRESHOLDS, newEnabled: false }),
    ).toBe(true);
  });

  it('reports false when both branches are off', () => {
    expect(
      hasAnyEnabledBranch({
        ...DEFAULT_HOT_THRESHOLDS,
        topEnabled: false,
        newEnabled: false,
      }),
    ).toBe(false);
  });
});

describe('storage round-trip', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns defaults on a pristine device', () => {
    expect(getStoredHotThresholds()).toEqual(DEFAULT_HOT_THRESHOLDS);
  });

  it('round-trips a saved record and stamps `at`', () => {
    const fixedNow = 1730000000000;
    const next: HotThresholds = {
      ...DEFAULT_HOT_THRESHOLDS,
      topEnabled: false,
      newVelocityMin: 25,
    };
    setStoredHotThresholds(next, fixedNow);
    const out = getStoredHotThresholds();
    expect(out.topEnabled).toBe(false);
    expect(out.newVelocityMin).toBe(25);
    expect(out.at).toBe(fixedNow);
  });

  it('clamps out-of-range values on read', () => {
    window.localStorage.setItem(
      HOT_THRESHOLDS_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_HOT_THRESHOLDS,
        topScoreMin: 99999,
        newVelocityMin: -10,
        at: 1,
      }),
    );
    const out = getStoredHotThresholds();
    expect(out.topScoreMin).toBe(HOT_THRESHOLD_BOUNDS.topScoreMin.max);
    expect(out.newVelocityMin).toBe(HOT_THRESHOLD_BOUNDS.newVelocityMin.min);
  });

  it('snaps off-grid values to the slider step on read', () => {
    // Regression: a hand-edited or older synced `topScoreMin = 201`
    // would otherwise survive sanitization and feed an `<input
    // type="range" step={10}>` an off-grid value, putting the
    // slider thumb in a position the control can't represent
    // (Copilot review on PR #240). Snap should be to the nearest
    // multiple of `step`.
    window.localStorage.setItem(
      HOT_THRESHOLDS_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_HOT_THRESHOLDS,
        topScoreMin: 201, // step 10  → 200
        topDescendantsMin: 102, // step 5 → 100
        newVelocityMin: 7, // step 1 (already on grid)
        newDescendantsMin: 9, // step 1 (already on grid)
        at: 1,
      }),
    );
    const out = getStoredHotThresholds();
    expect(out.topScoreMin).toBe(200);
    expect(out.topDescendantsMin).toBe(100);
    expect(out.newVelocityMin).toBe(7);
    expect(out.newDescendantsMin).toBe(9);
  });

  it('drops a malformed at, but keeps the rest', () => {
    window.localStorage.setItem(
      HOT_THRESHOLDS_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_HOT_THRESHOLDS, at: 'banana' }),
    );
    const out = getStoredHotThresholds();
    expect(out.at).toBeUndefined();
    expect(out.topEnabled).toBe(true);
  });

  it('falls back to defaults on garbage JSON', () => {
    window.localStorage.setItem(HOT_THRESHOLDS_STORAGE_KEY, 'not-json');
    expect(getStoredHotThresholds()).toEqual(DEFAULT_HOT_THRESHOLDS);
  });

  it('replaceHotThresholds preserves the incoming `at` (no fresh stamp)', () => {
    const next: HotThresholds = {
      ...DEFAULT_HOT_THRESHOLDS,
      topScoreMin: 150,
      at: 1730000000000,
    };
    replaceHotThresholds(next);
    const out = getStoredHotThresholds();
    expect(out.at).toBe(1730000000000);
    expect(out.topScoreMin).toBe(150);
  });

  it('clearStoredHotThresholds resets to defaults', () => {
    setStoredHotThresholds(
      { ...DEFAULT_HOT_THRESHOLDS, topEnabled: false },
      1,
    );
    clearStoredHotThresholds();
    expect(getStoredHotThresholds()).toEqual(DEFAULT_HOT_THRESHOLDS);
  });

  it('save fires a HOT_THRESHOLDS_CHANGE_EVENT', () => {
    const handler = vi.fn();
    window.addEventListener(HOT_THRESHOLDS_CHANGE_EVENT, handler);
    setStoredHotThresholds(DEFAULT_HOT_THRESHOLDS, 1);
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(HOT_THRESHOLDS_CHANGE_EVENT, handler);
  });
});
