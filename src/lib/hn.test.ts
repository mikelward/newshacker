import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getItem, getStoryIds, getUser } from './hn';
import {
  _resetNetworkStatusForTests,
  getConnectivityStatus,
} from './networkStatus';

// Which HN reads count as the connectivity tracker's core data plane. Feed id
// lists and items are the content without which the app is empty, so a 5xx
// there flips the app to 'down'; user profiles are deliberately not core — a
// failing profile read surfaces on the profile view without flipping the
// global pill or pausing the query layer.
describe('hn.ts core-read classification', () => {
  beforeEach(() => {
    _resetNetworkStatusForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('oops', { status: 500 })),
    );
  });
  afterEach(() => {
    _resetNetworkStatusForTests();
    vi.unstubAllGlobals();
  });

  it('a 5xx on the feed id list flips the app to down', async () => {
    await expect(getStoryIds('top')).rejects.toThrow('HN API 500');
    expect(getConnectivityStatus()).toBe('down');
  });

  it('a 5xx on an item read flips the app to down', async () => {
    await expect(getItem(1)).rejects.toThrow('HN API 500');
    expect(getConnectivityStatus()).toBe('down');
  });

  it('a 5xx on a user-profile read does NOT flip the app', async () => {
    await expect(getUser('alice')).rejects.toThrow('HN API 500');
    expect(getConnectivityStatus()).toBe('online');
  });
});
