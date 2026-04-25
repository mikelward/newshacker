import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOME_FEED_CHANGE_EVENT,
  HOME_FEED_STORAGE_KEY,
  getStoredHomeFeed,
  setStoredHomeFeed,
} from './homeFeed';

describe('homeFeed lib', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('defaults to "top" when storage is empty', () => {
    expect(getStoredHomeFeed()).toBe('top');
  });

  it('reads a stored value', () => {
    window.localStorage.setItem(HOME_FEED_STORAGE_KEY, 'hot');
    expect(getStoredHomeFeed()).toBe('hot');
  });

  it('ignores garbage values in storage', () => {
    window.localStorage.setItem(HOME_FEED_STORAGE_KEY, 'best');
    expect(getStoredHomeFeed()).toBe('top');
  });

  it('setStoredHomeFeed persists non-default values', () => {
    setStoredHomeFeed('hot');
    expect(window.localStorage.getItem(HOME_FEED_STORAGE_KEY)).toBe('hot');
  });

  it('setStoredHomeFeed("top") clears the storage key', () => {
    setStoredHomeFeed('hot');
    setStoredHomeFeed('top');
    expect(window.localStorage.getItem(HOME_FEED_STORAGE_KEY)).toBeNull();
  });

  it('setStoredHomeFeed fires a change event', () => {
    const handler = vi.fn();
    window.addEventListener(HOME_FEED_CHANGE_EVENT, handler);
    setStoredHomeFeed('hot');
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(HOME_FEED_CHANGE_EVENT, handler);
  });
});
