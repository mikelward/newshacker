// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { FONT_SIZES } from './fontSize';
import {
  ZOOM_PER_STEP,
  fontSizeAfterSteps,
  touchDistance,
  zoomSteps,
} from './pinchFontSize';

const touches = (...points: Array<[number, number]>) =>
  Object.assign(
    points.map(([clientX, clientY]) => ({ clientX, clientY })),
    { length: points.length },
  );

describe('touchDistance', () => {
  it('measures the gap between the first two touches', () => {
    expect(touchDistance(touches([0, 0], [3, 4]))).toBe(5);
  });

  it('ignores a third touch', () => {
    expect(touchDistance(touches([0, 0], [3, 4], [100, 100]))).toBe(5);
  });

  it('is 0 when there are not two touches', () => {
    expect(touchDistance(touches([0, 0]))).toBe(0);
    expect(touchDistance(touches())).toBe(0);
  });
});

describe('zoomSteps', () => {
  it('stays put while the fingers have not moved', () => {
    expect(zoomSteps(1, 0)).toBe(0);
  });

  it('moves one step per ZOOM_PER_STEP of spread, in both directions', () => {
    expect(zoomSteps(ZOOM_PER_STEP, 0)).toBe(1);
    expect(zoomSteps(ZOOM_PER_STEP ** 3, 0)).toBe(3);
    expect(zoomSteps(1 / ZOOM_PER_STEP, 0)).toBe(-1);
    expect(zoomSteps(1 / ZOOM_PER_STEP ** 2, 0)).toBe(-2);
  });

  it('holds the current step through a boundary wobble', () => {
    // Halfway between step 0 and step 1, plus the hysteresis margin: whichever
    // step is showing keeps showing, so fingers resting on the boundary don't
    // flip the size back and forth.
    const boundary = ZOOM_PER_STEP ** 0.55;
    expect(zoomSteps(boundary, 0)).toBe(0);
    expect(zoomSteps(boundary, 1)).toBe(1);
  });

  it('flips once the wobble is decisively past the boundary', () => {
    expect(zoomSteps(ZOOM_PER_STEP ** 0.75, 0)).toBe(1);
  });

  it('keeps counting past the ends of the ladder', () => {
    // Unclamped on purpose: pinching back in has to return the size the fingers
    // are asking for, not start its descent from wherever the ladder stopped.
    expect(zoomSteps(ZOOM_PER_STEP ** 9, 0)).toBe(9);
  });

  it('holds the showing step for a nonsense ratio', () => {
    expect(zoomSteps(0, 2)).toBe(2);
    expect(zoomSteps(-1, 2)).toBe(2);
    expect(zoomSteps(Number.NaN, 2)).toBe(2);
    expect(zoomSteps(Number.POSITIVE_INFINITY, 2)).toBe(2);
  });
});

describe('fontSizeAfterSteps', () => {
  it('walks the ladder in both directions', () => {
    expect(fontSizeAfterSteps('16', 1)).toBe('17');
    expect(fontSizeAfterSteps('16', 2)).toBe('18');
    expect(fontSizeAfterSteps('16', -1)).toBe('15');
    expect(fontSizeAfterSteps('16', 0)).toBe('16');
  });

  it('clamps at both ends rather than running off', () => {
    expect(fontSizeAfterSteps('16', 99)).toBe(FONT_SIZES[FONT_SIZES.length - 1]);
    expect(fontSizeAfterSteps('16', -99)).toBe(FONT_SIZES[0]);
  });

  it('reaches every rung from the bottom', () => {
    expect(
      FONT_SIZES.map((_, i) => fontSizeAfterSteps(FONT_SIZES[0], i)),
    ).toEqual([...FONT_SIZES]);
  });
});
