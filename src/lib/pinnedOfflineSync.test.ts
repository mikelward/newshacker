import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  PINNED_SYNC_STALE_MS,
  _resetPinnedOfflineSyncForTests,
  startPinnedOfflineSync,
  syncPinnedStoriesForOffline,
} from './pinnedOfflineSync';
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

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value,
  });
}

// Seed a story's root as freshly fetched, the state a pin that was
// downloaded on this device (or refreshed recently) is in.
function seedFreshRoot(
  client: QueryClient,
  id: number,
  overrides: Parameters<typeof makeStory>[1] = {},
  kidIds: number[] = [],
  updatedAt: number = Date.now(),
) {
  client.setQueryData(
    ['itemRoot', id],
    { item: makeStory(id, overrides), kidIds },
    { updatedAt },
  );
}

describe('syncPinnedStoriesForOffline', () => {
  beforeEach(() => {
    window.localStorage.clear();
    _resetPinnedOfflineSyncForTests();
    _resetNetworkStatusForTests();
    setNavigatorOnline(true);
  });
  afterEach(() => {
    window.localStorage.clear();
    _resetPinnedOfflineSyncForTests();
    _resetNetworkStatusForTests();
    setNavigatorOnline(true);
    vi.unstubAllGlobals();
  });

  it('refreshes stale pinned roots in one batch, warms a capped comment batch, and fills both summaries', async () => {
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
      summaries: {
        1: { summary: 'S1' },
        2: { summary: 'S2' },
        3: { summary: 'S3' },
      },
      commentsSummaries: {
        1: { insights: ['i1'] },
        2: { insights: ['i2'] },
        3: { insights: ['i3'] },
      },
    });
    const client = newClient();

    syncPinnedStoriesForOffline(client, 10_000);

    await vi.waitFor(() => {
      expect(client.getQueryData(['itemRoot', 3])).toMatchObject({
        item: { title: 'Three' },
        kidIds: [301],
      });
      expect(client.getQueryData(['comment', 301])).toMatchObject({ id: 301 });
      // The batch path also downloads any summary that has never been
      // cached, so a story pinned on another device is fully readable
      // offline here without ever being opened.
      expect(client.getQueryData(['summary', 3])).toMatchObject({
        summary: 'S3',
      });
      expect(client.getQueryData(['comments-summary', 3])).toMatchObject({
        insights: ['i3'],
      });
    });

    const itemBatchCalls = fetchMock.mock.calls
      .map((call) => (typeof call[0] === 'string' ? call[0] : call[0].toString()))
      .filter((url) => url.includes('/api/items'));
    expect(itemBatchCalls).toHaveLength(2);
    const rootUrl = new URL(itemBatchCalls[0], 'http://localhost');
    expect(rootUrl.searchParams.get('ids')).toBe('3,2,1');
    expect(rootUrl.searchParams.get('fields')).toBe('full');
  });

  it('downloads missing summaries for a fresh-rooted pin without refetching the root', async () => {
    // The cross-device case: cloud sync delivered the pin, an earlier
    // sync (or a feed batch) already cached the root, but the summaries
    // were only ever downloaded on the device that pinned.
    const now = 50_000;
    addPinnedId(9, now);
    const fetchMock = installHNFetchMock({
      summaries: { 9: { summary: 'S9' } },
      commentsSummaries: { 9: { insights: ['i9'] } },
    });
    const client = newClient();
    seedFreshRoot(client, 9, { kids: [901] }, [901], now - 1_000);
    // First-page comment already cached — this test isolates the
    // summaries-only top-up; the comment top-up has its own test below.
    client.setQueryData(['comment', 901], { id: 901, type: 'comment' });

    syncPinnedStoriesForOffline(client, now);

    await vi.waitFor(() => {
      expect(client.getQueryData(['summary', 9])).toMatchObject({
        summary: 'S9',
      });
      expect(client.getQueryData(['comments-summary', 9])).toMatchObject({
        insights: ['i9'],
      });
    });
    const urls = fetchMock.mock.calls.map((call) =>
      typeof call[0] === 'string' ? call[0] : call[0].toString(),
    );
    expect(urls.some((url) => url.includes('/api/items'))).toBe(false);
  });

  it('tops up missing first-page comments for a fresh-rooted pin without refetching the root', async () => {
    // Regression (Codex review on #373): a fresh root whose pin-time
    // comment batch silently failed kept the thread comment-less
    // offline until the root went stale — the fill path only looked at
    // summaries.
    const now = 60_000;
    addPinnedId(12, now);
    const fetchMock = installHNFetchMock({
      items: {
        1201: { id: 1201, type: 'comment', text: 'c1201', time: 1 },
        1202: { id: 1202, type: 'comment', text: 'c1202', time: 1 },
      },
    });
    const client = newClient();
    seedFreshRoot(client, 12, { kids: [1201, 1202] }, [1201, 1202], now - 1_000);
    client.setQueryData(['comment', 1201], { id: 1201, type: 'comment' });
    client.setQueryData(['summary', 12], { summary: 'cached' });
    client.setQueryData(['comments-summary', 12], { insights: ['cached'] });

    syncPinnedStoriesForOffline(client, now);

    await vi.waitFor(() => {
      expect(client.getQueryData(['comment', 1202])).toMatchObject({
        id: 1202,
      });
    });
    const itemUrls = fetchMock.mock.calls
      .map((call) => (typeof call[0] === 'string' ? call[0] : call[0].toString()))
      .filter((url) => url.includes('/api/items'));
    // Only the absent comment is fetched — not the whole first page and
    // not the (fresh) root.
    expect(itemUrls).toHaveLength(1);
    expect(new URL(itemUrls[0], 'http://localhost').searchParams.get('ids')).toBe(
      '1202',
    );
  });

  it('aggregates fill-path comment top-ups into one capped batch per sync run', async () => {
    // Regression (Codex review on #373): each fill story fired its own
    // comment batch, so a boot with many partially-cached pins could
    // burst up to 30 /api/items calls — the documented cost bound is
    // one capped comment batch per run.
    const now = 70_000;
    addPinnedId(13, now);
    addPinnedId(14, now + 1);
    const fetchMock = installHNFetchMock({
      items: {
        1301: { id: 1301, type: 'comment', text: 'c1301', time: 1 },
        1401: { id: 1401, type: 'comment', text: 'c1401', time: 1 },
      },
    });
    const client = newClient();
    for (const [storyId, kidId] of [
      [13, 1301],
      [14, 1401],
    ] as const) {
      seedFreshRoot(client, storyId, { kids: [kidId] }, [kidId], now - 1_000);
      client.setQueryData(['summary', storyId], { summary: 'cached' });
      client.setQueryData(['comments-summary', storyId], {
        insights: ['cached'],
      });
    }

    syncPinnedStoriesForOffline(client, now);

    await vi.waitFor(() => {
      expect(client.getQueryData(['comment', 1301])).toMatchObject({ id: 1301 });
      expect(client.getQueryData(['comment', 1401])).toMatchObject({ id: 1401 });
    });
    const itemUrls = fetchMock.mock.calls
      .map((call) => (typeof call[0] === 'string' ? call[0] : call[0].toString()))
      .filter((url) => url.includes('/api/items'));
    expect(itemUrls).toHaveLength(1);
    expect(new URL(itemUrls[0], 'http://localhost').searchParams.get('ids')).toBe(
      '1401,1301',
    );
  });

  it('clears the attempt throttle when a comment top-up dies on a network blip', async () => {
    // Regression (Codex review on #373): the comment top-up swallowed
    // fetch failures, so a transient drop left the story throttled for
    // 6 h with its first-page comments still missing — unlike the
    // summary top-up, which already cleared the mark on the same blip.
    const now = 120_000;
    addPinnedId(15, now);
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: 60_000,
          staleTime: 0,
          networkMode: 'always',
        },
      },
    });
    seedFreshRoot(client, 15, { kids: [1501] }, [1501], now - 1_000);
    client.setQueryData(['summary', 15], { summary: 'cached' });
    client.setQueryData(['comments-summary', 15], { insights: ['cached'] });
    const rejecting = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', rejecting);

    syncPinnedStoriesForOffline(client, now);
    await vi.waitFor(() => expect(rejecting).toHaveBeenCalled());

    _resetNetworkStatusForTests();
    installHNFetchMock({
      items: { 1501: { id: 1501, type: 'comment', text: 'c1501', time: 1 } },
    });
    // Drive re-sync from inside waitFor: the mark clears asynchronously
    // when the failed batch settles; each iteration models another real
    // trigger. Without clear-on-blip no trigger would refetch inside
    // the 6 h window and this times out.
    await vi.waitFor(() => {
      syncPinnedStoriesForOffline(client, now + 1_000);
      expect(client.getQueryData(['comment', 1501])).toMatchObject({
        id: 1501,
      });
    });
  });

  it('clears the attempt throttle when the root batch succeeds but its comment batch blips', async () => {
    // Regression (Codex review on #373): the root-refresh path's
    // trailing comment batch used the plain fetcher, so a blip there
    // left the story throttled 6 h with its promised first-page
    // comments missing — the fill path already recovered from the same
    // blip.
    const now = 130_000;
    addPinnedId(20, now);
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: 60_000,
          staleTime: 0,
          networkMode: 'always',
        },
      },
    });
    const rootBody = JSON.stringify([makeStory(20, { kids: [2001] })]);
    // Root batch (ids=20) succeeds; the follow-up comment batch
    // (ids=2001) dies on a statusless network error.
    const splitFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('ids=20&')) {
        return new Response(rootBody, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', splitFetch);
    client.setQueryData(['summary', 20], { summary: 'cached' });
    client.setQueryData(['comments-summary', 20], { insights: ['cached'] });

    syncPinnedStoriesForOffline(client, now);
    await vi.waitFor(() => {
      expect(client.getQueryData(['itemRoot', 20])).toMatchObject({
        kidIds: [2001],
      });
    });

    // Connection back; the blip must have cleared the mark so a trigger
    // inside the 6 h window tops up the missing comment via the fill
    // path (the root is now fresh — no root refetch).
    _resetNetworkStatusForTests();
    installHNFetchMock({
      items: { 2001: { id: 2001, type: 'comment', text: 'c2001', time: 1 } },
    });
    await vi.waitFor(() => {
      syncPinnedStoriesForOffline(client, now + 1_000);
      expect(client.getQueryData(['comment', 2001])).toMatchObject({
        id: 2001,
      });
    });
  });

  it('skips fully-cached pins and throttles failed attempts', async () => {
    const now = 50_000;
    addPinnedId(5, now);
    const client = newClient();
    seedFreshRoot(client, 5, {}, [], now - 1_000);
    client.setQueryData(['summary', 5], { summary: 'cached' });
    client.setQueryData(['comments-summary', 5], { insights: ['cached'] });
    const fetchMock = vi.fn(async () => new Response('not expected'));
    vi.stubGlobal('fetch', fetchMock);

    syncPinnedStoriesForOffline(client, now);
    expect(fetchMock).not.toHaveBeenCalled();

    client.setQueryData(
      ['itemRoot', 5],
      { item: makeStory(5, { title: 'Stale' }), kidIds: [] },
      { updatedAt: now - PINNED_SYNC_STALE_MS - 1 },
    );
    syncPinnedStoriesForOffline(client, now);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The bogus 200 body parses as a failure that carried a response —
    // not a network blip — so the attempt mark survives and the story
    // is not re-asked within the window.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    syncPinnedStoriesForOffline(client, now + 1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not sync while the network tracker is offline', () => {
    addPinnedId(7);
    const client = newClient();
    const fetchMock = vi.fn(async () => new Response('not expected'));
    vi.stubGlobal('fetch', fetchMock);

    reportFetchFailure(new TypeError('Failed to fetch'));
    syncPinnedStoriesForOffline(client, 10_000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears the attempt throttle when the batch dies on a network blip, so reconnect retries', async () => {
    const now = 80_000;
    addPinnedId(8, now);
    const client = newClient();
    const rejecting = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', rejecting);

    syncPinnedStoriesForOffline(client, now);
    await vi.waitFor(() => expect(rejecting).toHaveBeenCalledTimes(1));

    // The thrown fetch flipped the tracker offline; reset it to model the
    // connection coming back, then re-sync well inside the 6 h window.
    _resetNetworkStatusForTests();
    const fetchMock = installHNFetchMock({
      items: { 8: makeStory(8, { title: 'Eight' }) },
      summaries: { 8: { summary: 'S8' } },
      commentsSummaries: { 8: { insights: ['i8'] } },
    });
    // The throttle mark is cleared asynchronously (when the batch's
    // rejection propagates), so drive the sync from inside waitFor —
    // each iteration models another real trigger (reconnect, focus,
    // change event). Without the clear-on-blip behavior, no number of
    // triggers would refetch inside the 6 h window and this times out.
    await vi.waitFor(() => {
      syncPinnedStoriesForOffline(client, now + 1_000);
      expect(client.getQueryData(['itemRoot', 8])).toMatchObject({
        item: { title: 'Eight' },
      });
    });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('clears the attempt throttle when a summaries-only prefetch dies on a network blip', async () => {
    // Regression (Codex review on #373): a fresh-rooted pin whose
    // summary download failed on a transient drop stayed throttled for
    // 6 h — only root-batch failures cleared the mark.
    const now = 100_000;
    addPinnedId(10, now);
    // Non-zero gcTime: the seeded root must survive the async gaps in
    // this test (gcTime 0 would GC it between syncs and reroute the
    // retry down the root-batch path instead of the summaries-only path
    // under test).
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: 60_000,
          staleTime: 0,
          networkMode: 'always',
        },
      },
    });
    seedFreshRoot(client, 10, { kids: [1001] }, [1001], now - 1_000);
    const rejecting = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', rejecting);

    syncPinnedStoriesForOffline(client, now);
    await vi.waitFor(() => expect(rejecting).toHaveBeenCalled());

    // Connection comes back; drive re-sync from inside waitFor since the
    // mark is cleared asynchronously when the failed prefetch settles.
    _resetNetworkStatusForTests();
    installHNFetchMock({
      summaries: { 10: { summary: 'S10' } },
      commentsSummaries: { 10: { insights: ['i10'] } },
    });
    await vi.waitFor(() => {
      syncPinnedStoriesForOffline(client, now + 1_000);
      expect(client.getQueryData(['summary', 10])).toMatchObject({
        summary: 'S10',
      });
      expect(client.getQueryData(['comments-summary', 10])).toMatchObject({
        insights: ['i10'],
      });
    });
  });

  it('keeps the throttle when a summary fetch failed with an HTTP status', async () => {
    const now = 110_000;
    addPinnedId(11, now);
    const client = newClient();
    seedFreshRoot(client, 11, { kids: [1101] }, [1101], now - 1_000);
    const fetchMock = installHNFetchMock({
      summaries: { 11: { error: 'boom', status: 500 } },
      commentsSummaries: { 11: { error: 'boom', status: 500 } },
    });

    syncPinnedStoriesForOffline(client, now);
    const summaryCalls = () =>
      fetchMock.mock.calls.filter((call) => {
        const url = typeof call[0] === 'string' ? call[0] : call[0].toString();
        return url.includes('/api/summary') || url.includes('/api/comments-summary');
      }).length;
    await vi.waitFor(() => expect(summaryCalls()).toBe(2));

    // Let the failed prefetches fully settle, then re-trigger: the 5xx
    // kept the 6 h mark, so nothing is re-asked.
    await new Promise((resolve) => setTimeout(resolve, 0));
    syncPinnedStoriesForOffline(client, now + 1_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(summaryCalls()).toBe(2);
  });

  it('skips a pin whose root fetch is already in flight (local pin path)', () => {
    const now = 90_000;
    addPinnedId(6, now);
    const client = newClient();
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    // Model prefetchPinnedStory's in-flight root fetch with a queryFn
    // that never resolves: the query sits at fetchStatus 'fetching'.
    void client.prefetchQuery({
      queryKey: ['itemRoot', 6],
      queryFn: () => new Promise(() => {}),
    });

    syncPinnedStoriesForOffline(client, now);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('startPinnedOfflineSync', () => {
  beforeEach(() => {
    window.localStorage.clear();
    _resetPinnedOfflineSyncForTests();
    _resetNetworkStatusForTests();
    setNavigatorOnline(true);
  });
  afterEach(() => {
    window.localStorage.clear();
    _resetPinnedOfflineSyncForTests();
    _resetNetworkStatusForTests();
    setNavigatorOnline(true);
    vi.unstubAllGlobals();
  });

  it('downloads a pin the moment the pinned set changes (cloud sync arrival)', async () => {
    installHNFetchMock({
      items: { 21: makeStory(21, { title: 'TwentyOne' }) },
      summaries: { 21: { summary: 'S21' } },
      commentsSummaries: { 21: { insights: ['i21'] } },
    });
    const client = newClient();
    const stop = startPinnedOfflineSync(client);
    try {
      // addPinnedId dispatches PINNED_STORIES_CHANGE_EVENT — the same
      // event cloud sync's replacePinnedEntries fires after a pull.
      addPinnedId(21);
      await vi.waitFor(() => {
        expect(client.getQueryData(['itemRoot', 21])).toMatchObject({
          item: { title: 'TwentyOne' },
        });
        expect(client.getQueryData(['summary', 21])).toMatchObject({
          summary: 'S21',
        });
      });
    } finally {
      stop();
    }
  });

  it('waits out an offline pin and downloads it when connectivity returns', async () => {
    const fetchMock = installHNFetchMock({
      items: { 22: makeStory(22, { title: 'TwentyTwo' }) },
      summaries: { 22: { summary: 'S22' } },
      commentsSummaries: { 22: { insights: ['i22'] } },
    });
    const client = newClient();
    const stop = startPinnedOfflineSync(client);
    try {
      setNavigatorOnline(false);
      window.dispatchEvent(new Event('offline'));
      addPinnedId(22);
      expect(fetchMock).not.toHaveBeenCalled();

      setNavigatorOnline(true);
      window.dispatchEvent(new Event('online'));
      await vi.waitFor(() => {
        expect(client.getQueryData(['itemRoot', 22])).toMatchObject({
          item: { title: 'TwentyTwo' },
        });
      });
    } finally {
      stop();
    }
  });

  it('does not double-fetch a local pin whose pin-time warm starts in the same tick', async () => {
    // Regression (Codex review on #373): pin handlers call pin(id) —
    // which dispatches the change event synchronously — and only then
    // prefetchPinnedStory. Running the sync inside the dispatch fired a
    // second root warm before the pin-time fetch existed for the
    // fetchStatus guard to see. The listener defers one macrotask, by
    // which point the pin-time root fetch is in flight and the guard
    // skips the story.
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const client = newClient();
    const stop = startPinnedOfflineSync(client);
    try {
      // The local pin flow, in one tick: pin, then the pin-time warm.
      addPinnedId(24);
      void client.prefetchQuery({
        queryKey: ['itemRoot', 24],
        queryFn: () => new Promise(() => {}),
      });
      // Let the deferred sync fire.
      await new Promise((resolve) => setTimeout(resolve, 10));
      // The sync saw the in-flight pin-time fetch and started nothing
      // of its own (the never-resolving queryFn above isn't fetch-based,
      // so any fetch call here would be the sync's duplicate warm).
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('syncs on window focus regardless of the current page', async () => {
    // Regression (Codex review on #373): only the home feed had a focus
    // listener, so a tab parked on a thread or /pinned page past the
    // staleness window never refreshed pinned content on refocus.
    installHNFetchMock({
      items: { 25: makeStory(25, { title: 'TwentyFive' }) },
      summaries: { 25: { summary: 'S25' } },
      commentsSummaries: { 25: { insights: ['i25'] } },
    });
    const client = newClient();
    const stop = startPinnedOfflineSync(client);
    try {
      // Seed the pin without dispatching the change event (the store is
      // written directly), so focus is the only trigger under test.
      window.localStorage.setItem(
        'newshacker:pinnedStoryIds',
        JSON.stringify([{ id: 25, at: 1_000 }]),
      );
      window.dispatchEvent(new Event('focus'));
      await vi.waitFor(() => {
        expect(client.getQueryData(['itemRoot', 25])).toMatchObject({
          item: { title: 'TwentyFive' },
        });
      });
    } finally {
      stop();
    }
  });

  it('downloads a pin arriving via a cross-tab storage event', async () => {
    // Regression (Codex review on #373): a pin made in another open tab
    // reaches this tab as a `storage` event, not the custom change
    // event — without a storage listener the pin sat undownloaded here
    // until focus or reconnect, which can come after connectivity is
    // gone (e.g. when queryCacheSync couldn't deliver the other tab's
    // warmed data).
    const fetchMock = installHNFetchMock({
      items: { 26: makeStory(26, { title: 'TwentySix' }) },
      summaries: { 26: { summary: 'S26' } },
      commentsSummaries: { 26: { insights: ['i26'] } },
    });
    const client = newClient();
    const stop = startPinnedOfflineSync(client);
    try {
      // Model the other tab's write: localStorage set directly (no
      // custom event in this tab), then the browser-delivered storage
      // event.
      window.localStorage.setItem(
        'newshacker:pinnedStoryIds',
        JSON.stringify([{ id: 26, at: 1_000 }]),
      );
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'newshacker:pinnedStoryIds' }),
      );
      await vi.waitFor(() => {
        expect(client.getQueryData(['itemRoot', 26])).toMatchObject({
          item: { title: 'TwentySix' },
        });
      });

      // Unrelated cross-tab writes don't run the sync: no new fetches
      // after everything above settled.
      const callsBefore = fetchMock.mock.calls.length;
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'newshacker:openedStoryIds' }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fetchMock.mock.calls.length).toBe(callsBefore);
    } finally {
      stop();
    }
  });

  it('stops listening after the returned unsubscribe runs', async () => {
    const fetchMock = installHNFetchMock({});
    const client = newClient();
    const stop = startPinnedOfflineSync(client);
    stop();
    addPinnedId(23);
    // Give any (buggy) async work a chance to fire before asserting.
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
