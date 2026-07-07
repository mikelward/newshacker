import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetActiveFeedForTests,
  getActiveFeed,
  setActiveFeed,
  subscribeActiveFeed,
} from './activeFeed';

describe('activeFeed store', () => {
  afterEach(() => {
    _resetActiveFeedForTests();
  });

  it('starts empty and records the last-set feed', () => {
    expect(getActiveFeed()).toBeNull();
    setActiveFeed('top');
    expect(getActiveFeed()).toBe('top');
    setActiveFeed('hot');
    expect(getActiveFeed()).toBe('hot');
  });

  it('notifies subscribers only when the feed actually changes', () => {
    const listener = vi.fn();
    const unsub = subscribeActiveFeed(listener);
    setActiveFeed('new');
    expect(listener).toHaveBeenCalledTimes(1);
    // Setting the same feed again is a no-op — no re-notify.
    setActiveFeed('new');
    expect(listener).toHaveBeenCalledTimes(1);
    setActiveFeed('best');
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
    setActiveFeed('ask');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
