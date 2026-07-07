import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FeedKeepWarm } from './FeedKeepWarm';
import { useFeedItems } from '../hooks/useStoryList';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { _resetActiveFeedForTests, setActiveFeed } from '../lib/activeFeed';

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 60_000,
        staleTime: 0,
        networkMode: 'offlineFirst',
      },
    },
  });
}

function countFeedFetches(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input).includes('topstories'),
  ).length;
}

describe('<FeedKeepWarm>', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    _resetActiveFeedForTests();
  });

  it('observes nothing until a feed has been viewed', async () => {
    const fetchMock = installHNFetchMock({ feeds: { topstories: [1] } });
    render(
      <QueryClientProvider client={makeClient()}>
        <FeedKeepWarm />
      </QueryClientProvider>,
    );
    // No active feed yet → renders null and never subscribes to a feed query.
    await waitFor(() => expect(countFeedFetches(fetchMock)).toBe(0));
  });

  it('observes the active feed so its queries have a warm subscriber', async () => {
    setActiveFeed('top');
    const fetchMock = installHNFetchMock({
      feeds: { topstories: [1] },
      items: { 1: makeStory(1) },
    });
    render(
      <QueryClientProvider client={makeClient()}>
        <FeedKeepWarm />
      </QueryClientProvider>,
    );
    // The keep-warm observer drives the id-list fetch for the active feed.
    await waitFor(() => expect(countFeedFetches(fetchMock)).toBeGreaterThan(0));
  });

  it('keeps an in-flight refetch alive when the feed route unmounts', async () => {
    // The crux of the fix: React Query aborts a query's fetch when its last
    // observer unmounts. `<FeedKeepWarm>` is a second, persistent observer, so
    // a refresh kicked as the reader opens a story survives the feed route
    // unmounting on navigation and lands while they're in the thread.
    setActiveFeed('top');
    let topCall = 0;
    let releaseSecond: ((ids: number[]) => void) | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('topstories')) {
        topCall += 1;
        if (topCall === 1) {
          return new Response(JSON.stringify([1]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        // The refetch (2nd id-list call) is gated so we can unmount the route
        // while it's in flight, then release it.
        return await new Promise<Response>((resolve) => {
          releaseSecond = (ids: number[]) =>
            resolve(
              new Response(JSON.stringify(ids), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            );
        });
      }
      // /api/items batch (+ raw item fallback) for whatever ids are requested.
      const parsed = new URL(url, 'http://localhost');
      const idsRaw = parsed.searchParams.get('ids') ?? '';
      const ids = idsRaw
        ? idsRaw.split(',').filter(Boolean).map(Number)
        : (url.match(/item\/(\d+)/)?.[1] !== undefined
            ? [Number(url.match(/item\/(\d+)/)![1])]
            : []);
      return new Response(JSON.stringify(ids.map((id) => makeStory(id))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();

    // The "route" observer, rendered alongside the persistent keep-warm one.
    function Route() {
      useFeedItems('top');
      return <div>route</div>;
    }
    function Harness({ showRoute }: { showRoute: boolean }) {
      return (
        <>
          <FeedKeepWarm />
          {showRoute ? <Route /> : null}
        </>
      );
    }

    const { rerender } = render(
      <QueryClientProvider client={client}>
        <Harness showRoute />
      </QueryClientProvider>,
    );

    // Initial id-list fetch (deduped across both observers) settles to [1].
    await waitFor(() => expect(topCall).toBeGreaterThanOrEqual(1));
    await waitFor(() =>
      expect(client.getQueryData(['storyIds', 'top'])).toEqual([1]),
    );

    // Kick a refetch (this is the 2nd, gated id-list call)…
    void client.refetchQueries({ queryKey: ['storyIds', 'top'] });
    await waitFor(() => expect(releaseSecond).not.toBeNull());

    // …then unmount the route observer while it's still in flight. FeedKeepWarm
    // stays mounted, so the fetch must NOT be aborted.
    rerender(
      <QueryClientProvider client={client}>
        <Harness showRoute={false} />
      </QueryClientProvider>,
    );

    act(() => releaseSecond!([2]));

    // The refetch completed and updated the cache — proof it survived the
    // route unmount because the keep-warm observer held the query.
    await waitFor(() =>
      expect(client.getQueryData(['storyIds', 'top'])).toEqual([2]),
    );
  });
});
