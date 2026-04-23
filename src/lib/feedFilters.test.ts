import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FEED_FILTERS_CHANGE_EVENT,
  clearFeedFilters,
  getFeedFilters,
  setFeedFilters,
} from './feedFilters';

describe('feedFilters storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('defaults to both filters off when nothing is stored', () => {
    expect(getFeedFilters()).toEqual({ unreadOnly: false, hotOnly: false });
  });

  it('round-trips both flags via setFeedFilters/getFeedFilters', () => {
    setFeedFilters({ unreadOnly: true, hotOnly: true });
    expect(getFeedFilters()).toEqual({ unreadOnly: true, hotOnly: true });

    setFeedFilters((prev) => ({ ...prev, unreadOnly: false }));
    expect(getFeedFilters()).toEqual({ unreadOnly: false, hotOnly: true });
  });

  it('dispatches FEED_FILTERS_CHANGE_EVENT on a real change, and not on a no-op write', () => {
    const listener = vi.fn();
    window.addEventListener(FEED_FILTERS_CHANGE_EVENT, listener);

    setFeedFilters({ unreadOnly: true, hotOnly: false });
    expect(listener).toHaveBeenCalledTimes(1);

    setFeedFilters((prev) => prev);
    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener(FEED_FILTERS_CHANGE_EVENT, listener);
  });

  it('clearFeedFilters resets both flags', () => {
    setFeedFilters({ unreadOnly: true, hotOnly: true });
    clearFeedFilters();
    expect(getFeedFilters()).toEqual({ unreadOnly: false, hotOnly: false });
  });

  it('falls back to defaults on malformed storage', () => {
    window.localStorage.setItem('newshacker:feedFilters', 'not-json{');
    expect(getFeedFilters()).toEqual({ unreadOnly: false, hotOnly: false });
  });

  it('coerces unknown fields to false rather than throwing', () => {
    window.localStorage.setItem(
      'newshacker:feedFilters',
      JSON.stringify({ unreadOnly: 'yes', hotOnly: 1 }),
    );
    expect(getFeedFilters()).toEqual({ unreadOnly: false, hotOnly: false });
  });
});
