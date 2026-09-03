import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FONT_SIZES,
  FONT_SIZE_CHANGE_EVENT,
  FONT_SIZE_LABELS,
  FONT_SIZE_STORAGE_KEY,
  applyFontSize,
  getStoredFontSize,
  setStoredFontSize,
} from './fontSize';

describe('fontSize lib', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-font-size');
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-font-size');
  });

  it('defaults to 16px when storage is empty', () => {
    expect(getStoredFontSize()).toBe('16');
  });

  it('reads a stored font size', () => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, '22');
    expect(getStoredFontSize()).toBe('22');
  });

  it('ignores garbage values in storage', () => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, 'huge');
    expect(getStoredFontSize()).toBe('16');
  });

  it('keeps the size someone chose under the three-name scale', () => {
    // Falling back to the default here would silently shrink the text of every
    // reader who had picked "Large", at the moment the ladder grew past it.
    for (const [name, px] of [
      ['small', '15'],
      ['medium', '16'],
      ['large', '17'],
    ] as const) {
      window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, name);
      expect(getStoredFontSize()).toBe(px);
    }
  });

  it('snaps an off-ladder px value to the nearest rung, ties rounding up', () => {
    // The ladder only ever grows upward, so a stored value between rungs is a
    // choice to keep rather than a corrupt one to discard. 21 is equidistant
    // from 20 and 22: someone above the default asked for bigger.
    for (const [stored, expected] of [
      ['13', '14'],
      ['21', '22'],
      ['23', '24'],
      ['40', '32'],
    ] as const) {
      window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, stored);
      expect(getStoredFontSize()).toBe(expected);
    }
  });

  it('labels every rung with its px value', () => {
    for (const size of FONT_SIZES) {
      expect(FONT_SIZE_LABELS[size]).toBe(`${size}px`);
    }
  });

  it('persists a non-default size and sets the attribute', () => {
    setStoredFontSize('15');
    expect(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)).toBe('15');
    expect(document.documentElement.getAttribute('data-font-size')).toBe('15');

    setStoredFontSize('32');
    expect(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)).toBe('32');
    expect(document.documentElement.getAttribute('data-font-size')).toBe('32');
  });

  it('setStoredFontSize("16") clears the attribute and the key', () => {
    setStoredFontSize('24');
    setStoredFontSize('16');
    expect(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute('data-font-size')).toBe(false);
  });

  it('setStoredFontSize fires a change event', () => {
    const handler = vi.fn();
    window.addEventListener(FONT_SIZE_CHANGE_EVENT, handler);
    setStoredFontSize('20');
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(FONT_SIZE_CHANGE_EVENT, handler);
  });

  it('applyFontSize toggles the attribute without touching storage', () => {
    applyFontSize('14');
    expect(document.documentElement.getAttribute('data-font-size')).toBe('14');
    expect(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)).toBeNull();
    applyFontSize('16');
    expect(document.documentElement.hasAttribute('data-font-size')).toBe(false);
  });
});
