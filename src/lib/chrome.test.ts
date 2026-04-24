import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHROME_CHANGE_EVENT,
  CHROME_STORAGE_KEY,
  applyChrome,
  getStoredChrome,
  setStoredChrome,
} from './chrome';

describe('chrome lib', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-chrome');
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-chrome');
  });

  it('defaults to "mono" when storage is empty', () => {
    expect(getStoredChrome()).toBe('mono');
  });

  it('reads a stored chrome', () => {
    window.localStorage.setItem(CHROME_STORAGE_KEY, 'duo');
    expect(getStoredChrome()).toBe('duo');
  });

  it('ignores garbage values in storage', () => {
    window.localStorage.setItem(CHROME_STORAGE_KEY, 'mono-a');
    expect(getStoredChrome()).toBe('mono');
  });

  it('setStoredChrome persists non-mono variants and sets the attribute', () => {
    setStoredChrome('duo');
    expect(window.localStorage.getItem(CHROME_STORAGE_KEY)).toBe('duo');
    expect(document.documentElement.getAttribute('data-chrome')).toBe('duo');

    setStoredChrome('classic');
    expect(window.localStorage.getItem(CHROME_STORAGE_KEY)).toBe('classic');
    expect(document.documentElement.getAttribute('data-chrome')).toBe(
      'classic',
    );
  });

  it('setStoredChrome("mono") clears the attribute and the key', () => {
    setStoredChrome('duo');
    setStoredChrome('mono');
    expect(window.localStorage.getItem(CHROME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute('data-chrome')).toBe(false);
  });

  it('setStoredChrome fires a change event', () => {
    const handler = vi.fn();
    window.addEventListener(CHROME_CHANGE_EVENT, handler);
    setStoredChrome('duo');
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(CHROME_CHANGE_EVENT, handler);
  });

  it('applyChrome toggles the attribute without touching storage', () => {
    applyChrome('classic');
    expect(document.documentElement.getAttribute('data-chrome')).toBe(
      'classic',
    );
    expect(window.localStorage.getItem(CHROME_STORAGE_KEY)).toBeNull();
    applyChrome('mono');
    expect(document.documentElement.hasAttribute('data-chrome')).toBe(false);
  });
});
