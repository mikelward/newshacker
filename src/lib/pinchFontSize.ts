import { FONT_SIZES, type FontSize } from './fontSize';

/** How far the fingers must spread to move one step on the text-size ladder.
 *
 * Deliberately unrelated to the ladder's own range: 14px→24px is only 1.71× of
 * actual type, which as a *gesture* range would put the whole ladder inside a
 * twitch. At 1.12× per step the nine steps span ~2.5× of finger travel, so a
 * small pinch moves exactly one size and running the ladder end to end takes a
 * deliberate two-handed spread. */
export const ZOOM_PER_STEP = 1.12;

/** Extra travel past the halfway point before the step flips, so fingers
 * hovering on a boundary don't chatter the size back and forth. Applied
 * symmetrically, so it costs 0.1 of a step in each direction and never
 * accumulates — `steps` is always re-derived from the raw zoom, never
 * incremented. */
const HYSTERESIS_STEPS = 0.1;

/** Distance between the first two touches of a touch list, in CSS px. */
export function touchDistance(touches: {
  length: number;
  item?: unknown;
  [index: number]: { clientX: number; clientY: number } | undefined;
}): number {
  const a = touches[0];
  const b = touches[1];
  if (!a || !b) return 0;
  return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
}

/**
 * How many ladder steps a pinch of `zoom` (current spread ÷ spread at gesture
 * start) is asking for, given the step it is currently showing.
 *
 * Derived from the raw ratio every frame rather than accumulated, which is what
 * keeps an *overshoot* honest: a pinch that runs past the top of the ladder
 * still reports +7, so pinching back in returns the size the fingers are
 * actually asking for instead of starting its descent from the clamped end.
 * (`fontSizeAfterSteps` does the clamping, at the point of use.)
 */
export function zoomSteps(zoom: number, showing: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return showing;
  const raw = Math.log(zoom) / Math.log(ZOOM_PER_STEP);
  if (Math.abs(raw - showing) <= 0.5 + HYSTERESIS_STEPS) return showing;
  return Math.round(raw);
}

/** The size `steps` along the ladder from `base`, clamped at both ends. */
export function fontSizeAfterSteps(base: FontSize, steps: number): FontSize {
  const from = FONT_SIZES.indexOf(base);
  // A stored value outside the ladder can't happen (`getStoredFontSize`
  // validates), but clamp from 0 rather than -1 if it ever does.
  const start = from < 0 ? FONT_SIZES.indexOf('16') : from;
  const next = Math.min(
    FONT_SIZES.length - 1,
    Math.max(0, start + Math.round(steps)),
  );
  return FONT_SIZES[next];
}
