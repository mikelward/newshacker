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

  it('defaults to "default" when storage is empty', () => {
    expect(getStoredChrome()).toBe('default');
  });

  it('reads a stored chrome', () => {
    window.localStorage.setItem(CHROME_STORAGE_KEY, 'mono-a');
    expect(getStoredChrome()).toBe('mono-a');
  });

  it('ignores garbage values in storage', () => {
    window.localStorage.setItem(CHROME_STORAGE_KEY, 'phosphor');
    expect(getStoredChrome()).toBe('default');
  });

  it('setStoredChrome persists non-default variants and sets the attribute', () => {
    setStoredChrome('mono-a');
    expect(window.localStorage.getItem(CHROME_STORAGE_KEY)).toBe('mono-a');
    expect(document.documentElement.getAttribute('data-chrome')).toBe('mono-a');

    setStoredChrome('mono-b');
    expect(window.localStorage.getItem(CHROME_STORAGE_KEY)).toBe('mono-b');
    expect(document.documentElement.getAttribute('data-chrome')).toBe('mono-b');
  });

  it('setStoredChrome("default") clears the attribute and the key', () => {
    setStoredChrome('mono-a');
    setStoredChrome('default');
    expect(window.localStorage.getItem(CHROME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute('data-chrome')).toBe(false);
  });

  it('setStoredChrome fires a change event', () => {
    const handler = vi.fn();
    window.addEventListener(CHROME_CHANGE_EVENT, handler);
    setStoredChrome('mono-a');
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(CHROME_CHANGE_EVENT, handler);
  });

  it('applyChrome toggles the attribute without touching storage', () => {
    applyChrome('mono-b');
    expect(document.documentElement.getAttribute('data-chrome')).toBe('mono-b');
    expect(window.localStorage.getItem(CHROME_STORAGE_KEY)).toBeNull();
    applyChrome('default');
    expect(document.documentElement.hasAttribute('data-chrome')).toBe(false);
  });
});
