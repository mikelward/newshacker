import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  HOME_PINNED_REFRESH_STALE_MS,
  _resetHomePinnedRefreshForTests,
  refreshPinnedStoriesForHomeView,
} from './homePinnedRefresh';
import { addPinnedId } from './pinnedStories';
import {
  _resetNetworkStatusForTests,
  reportFetchFailure,
} from './networkStatus';
import { installHNFetchMock, makeStory } from '../test/mockFetch';

function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, networkMode: 'always' },
    },
  });
}

describe('refreshPinnedStoriesForHomeView', () => {
  beforeEach(() => {
    window.localStorage.clear();
    _resetHomePinnedRefreshForTests();
    _resetNetworkStatusForTests();
  });
  afterEach(() => {
    window.localStorage.clear();
    _resetHomePinnedRefreshForTests();
    _resetNetworkStatusForTests();
    vi.unstubAllGlobals();
  });

  it('refreshes stale pinned roots in one batch and warms a capped comment batch', async () => {
    addPinnedId(1, 1_000);
    addPinnedId(2, 2_000);
    addPinnedId(3, 3_000);
    const fetchMock = installHNFetchMock({
      items: {
        1: makeStory(1, { title: 'One', kids: [101] }),
        2: makeStory(2, { title: 'Two', kids: [201] }),
        3: makeStory(3, { title: 'Three', kids: [301] }),
        101: { id: 101, type: 'comment', text: 'c101', time: 1 },
        201: { id: 201, type: 'comment', text: 'c201', time: 1 },
        301: { id: 301, type: 'comment', text: 'c301', time: 1 },
      },
    });
    const client = newClient();

    refreshPinnedStoriesForHomeView(client, 10_000);

    await vi.waitFor(() => {
      expect(client.getQueryData(['itemRoot', 3])).toMatchObject({
        item: { title: 'Three' },
        kidIds: [301],
      });
      expect(client.getQueryData(['comment', 301])).toMatchObject({ id: 301 });
    });

    const itemBatchCalls = fetchMock.mock.calls
      .map((call) => (typeof call[0] === 'string' ? call[0] : call[0].toString()))
      .filter((url) => url.includes('/api/items'));
    expect(itemBatchCalls).toHaveLength(2);
    const rootUrl = new URL(itemBatchCalls[0], 'http://localhost');
    expect(rootUrl.searchParams.get('ids')).toBe('3,2,1');
    expect(rootUrl.searchParams.get('fields')).toBe('full');
  });

  it('skips fresh pinned roots and throttles failed attempts', async () => {
    const now = 50_000;
    addPinnedId(5, now);
    const client = newClient();
    client.setQueryData(
      ['itemRoot', 5],
      { item: makeStory(5, { title: 'Fresh' }), kidIds: [] },
      { updatedAt: now - 1_000 },
    );
    const fetchMock = vi.fn(async () => new Response('not expected'));
    vi.stubGlobal('fetch', fetchMock);

    refreshPinnedStoriesForHomeView(client, now);
    expect(fetchMock).not.toHaveBeenCalled();

    client.setQueryData(
      ['itemRoot', 5],
      { item: makeStory(5, { title: 'Stale' }), kidIds: [] },
      { updatedAt: now - HOME_PINNED_REFRESH_STALE_MS - 1 },
    );
    refreshPinnedStoriesForHomeView(client, now);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    refreshPinnedStoriesForHomeView(client, now + 1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not refresh while the network tracker is offline', () => {
    addPinnedId(7);
    const client = newClient();
    const fetchMock = vi.fn(async () => new Response('not expected'));
    vi.stubGlobal('fetch', fetchMock);

    reportFetchFailure(new TypeError('Failed to fetch'));
    refreshPinnedStoriesForHomeView(client, 10_000);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
