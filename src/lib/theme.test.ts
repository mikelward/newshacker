import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_CHANGE_EVENT,
  THEME_STORAGE_KEY,
  applyTheme,
  getStoredTheme,
  resolveTheme,
  setStoredTheme,
} from './theme';

describe('theme lib', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('defaults to "system" when storage is empty', () => {
    expect(getStoredTheme()).toBe('system');
  });

  it('reads a stored theme', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(getStoredTheme()).toBe('dark');
  });

  it('ignores garbage values in storage', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    expect(getStoredTheme()).toBe('system');
  });

  it('setStoredTheme persists explicit themes and sets the attribute', () => {
    setStoredTheme('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    setStoredTheme('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('setStoredTheme("system") clears the attribute and the key', () => {
    setStoredTheme('dark');
    setStoredTheme('system');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('setStoredTheme fires a change event', () => {
    const handler = vi.fn();
    window.addEventListener(THEME_CHANGE_EVENT, handler);
    setStoredTheme('dark');
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(THEME_CHANGE_EVENT, handler);
  });

  it('applyTheme toggles the attribute without touching storage', () => {
    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    applyTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('resolveTheme returns explicit values as-is', () => {
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
  });

  it('resolveTheme follows matchMedia when set to system', () => {
    const spy = vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query === '(prefers-color-scheme: dark)',
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
          onchange: null,
        }) as unknown as MediaQueryList,
    );
    expect(resolveTheme('system')).toBe('dark');
    spy.mockRestore();
  });
});
