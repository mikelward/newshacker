import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FONT_SIZE_CHANGE_EVENT,
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

  it('defaults to "medium" when storage is empty', () => {
    expect(getStoredFontSize()).toBe('medium');
  });

  it('reads a stored font size', () => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, 'large');
    expect(getStoredFontSize()).toBe('large');
  });

  it('ignores garbage values in storage', () => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, 'huge');
    expect(getStoredFontSize()).toBe('medium');
  });

  it('setStoredFontSize persists non-medium sizes and sets the attribute', () => {
    setStoredFontSize('small');
    expect(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)).toBe('small');
    expect(document.documentElement.getAttribute('data-font-size')).toBe(
      'small',
    );

    setStoredFontSize('large');
    expect(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)).toBe('large');
    expect(document.documentElement.getAttribute('data-font-size')).toBe(
      'large',
    );
  });

  it('setStoredFontSize("medium") clears the attribute and the key', () => {
    setStoredFontSize('large');
    setStoredFontSize('medium');
    expect(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute('data-font-size')).toBe(false);
  });

  it('setStoredFontSize fires a change event', () => {
    const handler = vi.fn();
    window.addEventListener(FONT_SIZE_CHANGE_EVENT, handler);
    setStoredFontSize('large');
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(FONT_SIZE_CHANGE_EVENT, handler);
  });

  it('applyFontSize toggles the attribute without touching storage', () => {
    applyFontSize('small');
    expect(document.documentElement.getAttribute('data-font-size')).toBe(
      'small',
    );
    expect(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)).toBeNull();
    applyFontSize('medium');
    expect(document.documentElement.hasAttribute('data-font-size')).toBe(false);
  });
});
