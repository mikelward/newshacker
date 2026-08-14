import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePinnedFeedStories } from './usePinnedFeedStories';
import { addPinnedId } from '../lib/pinnedStories';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import type { HNItem } from '../lib/hn';

// Holds every /api/items request open until the test releases it, so the
// "what's on screen while the batch is in flight" assertions can't race a
// fetch that already settled.
function gateItemsFetch(hnMock: ReturnType<typeof installHNFetchMock>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/items')) await gate;
      return hnMock(input);
    }),
  );
  return { release: () => act(() => (release(), gate)) };
}

// gcTime defaults to 0, which is fine for assertions made synchronously
// after render. A test that awaits anything must pass a non-zero one, or
// the seeded `itemRoot` entries — which have no observer — are collected
// before the assertion runs and the test passes vacuously.
function wrap(gcTime = 0) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime, staleTime: 0, networkMode: 'offlineFirst' },
    },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, Wrapper };
}

describe('usePinnedFeedStories', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('returns empty when nothing is pinned', async () => {
    installHNFetchMock({ items: {} });
    const { Wrapper } = wrap();
    const feed: HNItem[] = [makeStory(1), makeStory(2), makeStory(3)];
    const { result } = renderHook(() => usePinnedFeedStories(feed), {
      wrapper: Wrapper,
    });
    expect(result.current.stories).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it('returns pins already present in the loaded feed without refetching', () => {
    addPinnedId(1);
    addPinnedId(2);
    installHNFetchMock({ items: {} });
    const { Wrapper } = wrap();
    const feed: HNItem[] = [
      makeStory(1, { title: 'One' }),
      makeStory(2, { title: 'Two' }),
      makeStory(3, { title: 'Three' }),
    ];
    const { result } = renderHook(() => usePinnedFeedStories(feed), {
      wrapper: Wrapper,
    });
    // No network round-trip needed: both pins are in the loaded window.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.stories.map((s) => s.id).sort()).toEqual([1, 2]);
  });

  it('fetches pins that are not in the loaded feed window', async () => {
    // Pin two items; only one is in the loaded feed window.
    addPinnedId(10);
    addPinnedId(20);
    installHNFetchMock({
      items: {
        20: makeStory(20, { title: 'Off-window pin' }),
      },
    });
    const { Wrapper } = wrap();
    const feed: HNItem[] = [makeStory(10, { title: 'In window' })];
    const { result } = renderHook(() => usePinnedFeedStories(feed), {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      expect(result.current.stories).toHaveLength(2);
    });
    const titles = result.current.stories.map((s) => s.title).sort();
    expect(titles).toEqual(['In window', 'Off-window pin']);
  });

  it('filters out deleted and dead pinned items', async () => {
    addPinnedId(100);
    addPinnedId(200);
    addPinnedId(300);
    installHNFetchMock({
      items: {
        100: makeStory(100, { deleted: true }),
        200: makeStory(200, { dead: true }),
        300: makeStory(300, { title: 'Alive' }),
      },
    });
    const { Wrapper } = wrap();
    const { result } = renderHook(() => usePinnedFeedStories([]), {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      expect(result.current.stories).toHaveLength(1);
    });
    expect(result.current.stories[0].id).toBe(300);
  });

  it('orders pins oldest-pinned first', async () => {
    addPinnedId(1, 1_000);
    addPinnedId(2, 3_000);
    addPinnedId(3, 2_000);
    installHNFetchMock({
      items: {
        1: makeStory(1),
        2: makeStory(2),
        3: makeStory(3),
      },
    });
    const { Wrapper } = wrap();
    const { result } = renderHook(() => usePinnedFeedStories([]), {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      expect(result.current.stories).toHaveLength(3);
    });
    expect(result.current.stories.map((s) => s.id)).toEqual([1, 3, 2]);
  });

  it('paints an off-window pin from the itemRoot cache without waiting for the batch', async () => {
    addPinnedId(20);
    const hnMock = installHNFetchMock({
      items: { 20: makeStory(20, { title: 'Fresh copy' }) },
    });
    const { release } = gateItemsFetch(hnMock);
    const { client, Wrapper } = wrap();
    // What the pin-time warm (or the pinned offline sync) left on disk.
    client.setQueryData(['itemRoot', 20], {
      item: makeStory(20, { title: 'Cached copy' }),
      kidIds: [],
    });

    const { result } = renderHook(() => usePinnedFeedStories([]), {
      wrapper: Wrapper,
    });

    // Row is on screen with the refresh still in flight.
    expect(result.current.stories.map((s) => s.title)).toEqual(['Cached copy']);
    expect(result.current.isLoading).toBe(false);

    await release();
    await waitFor(() => {
      expect(result.current.stories.map((s) => s.title)).toEqual(['Fresh copy']);
    });
  });

  it('keeps already-downloaded pins on screen when a new pin arrives', async () => {
    // The cross-device case: pin something in the companion app, open
    // newshacker, and the arriving id changes the batch's query key. Every
    // *other* pinned row must keep rendering from cache instead of falling
    // back to skeletons for a round trip.
    addPinnedId(10, 1_000);
    addPinnedId(20, 2_000);
    const hnMock = installHNFetchMock({
      items: {
        10: makeStory(10, { title: 'One' }),
        20: makeStory(20, { title: 'Two' }),
        30: makeStory(30, { title: 'Pinned elsewhere' }),
      },
    });
    const { client, Wrapper } = wrap();
    const { result } = renderHook(() => usePinnedFeedStories([]), {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      expect(result.current.stories).toHaveLength(2);
    });
    // The pinned offline sync warms the root of everything it fetches.
    for (const id of [10, 20]) {
      client.setQueryData(['itemRoot', id], {
        item: makeStory(id),
        kidIds: [],
      });
    }

    const { release } = gateItemsFetch(hnMock);
    act(() => {
      addPinnedId(30, 3_000);
    });

    expect(result.current.stories.map((s) => s.id)).toEqual([10, 20]);
    expect(result.current.isLoading).toBe(false);

    await release();
    await waitFor(() => {
      expect(result.current.stories.map((s) => s.id)).toEqual([10, 20, 30]);
    });
  });

  it('picks up a pinned root that lands after render', async () => {
    addPinnedId(40);
    const hnMock = installHNFetchMock({ items: { 40: makeStory(40) } });
    gateItemsFetch(hnMock);
    const { client, Wrapper } = wrap();
    const { result } = renderHook(() => usePinnedFeedStories([]), {
      wrapper: Wrapper,
    });
    expect(result.current.stories).toEqual([]);

    // e.g. the pinned offline sync's own /api/items batch resolving first.
    act(() => {
      client.setQueryData(['itemRoot', 40], {
        item: makeStory(40, { title: 'Warmed by the sync' }),
        kidIds: [],
      });
    });

    await waitFor(() => {
      expect(result.current.stories.map((s) => s.title)).toEqual([
        'Warmed by the sync',
      ]);
    });
  });

  it('sees a root that lands between render and the cache subscription', async () => {
    // Subscribing happens in an effect, after the render that read the
    // cache. A root landing in that gap fires no event the subscriber
    // can see, so without a re-read on subscribe the row stays blank
    // until the batch settles — which here never happens.
    addPinnedId(60);
    const hnMock = installHNFetchMock({ items: { 60: makeStory(60) } });
    gateItemsFetch(hnMock);
    const { client, Wrapper } = wrap();
    let written = false;

    const { result } = renderHook(
      () => {
        const state = usePinnedFeedStories([]);
        // Deliberately during render, after the hook has read the
        // cache: that is exactly the window being tested.
        if (!written) {
          written = true;
          client.setQueryData(['itemRoot', 60], {
            item: makeStory(60, { title: 'Landed in the gap' }),
            kidIds: [],
          });
        }
        return state;
      },
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(result.current.stories.map((s) => s.title)).toEqual([
        'Landed in the gap',
      ]);
    });
  });

  it('drops a cached row when a fresher source says the story is dead', async () => {
    // The cache fallback must not outlive a definitive newer answer: a
    // story killed upstream since it was warmed has to leave the block,
    // which is what happened before the cache was read at all.
    addPinnedId(70, 1_000);
    addPinnedId(71, 2_000);
    installHNFetchMock({
      items: { 70: makeStory(70, { dead: true }) },
    });
    const { client, Wrapper } = wrap(60_000);
    for (const id of [70, 71]) {
      client.setQueryData(['itemRoot', id], {
        item: makeStory(id, { title: `Warm ${id}` }),
        kidIds: [],
      });
    }

    // 71 is in the loaded feed window and has been deleted there; 70 is
    // off-window and comes back dead from the batch. Both leave.
    const feed = [makeStory(71, { deleted: true })];
    const { result } = renderHook(() => usePinnedFeedStories(feed), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.stories).toEqual([]);
    });
  });

  it('returns empty when disabled (e.g. the /tuning Preview)', () => {
    addPinnedId(5);
    installHNFetchMock({ items: { 5: makeStory(5) } });
    const { Wrapper } = wrap();
    const { result } = renderHook(() => usePinnedFeedStories([], false), {
      wrapper: Wrapper,
    });
    expect(result.current.stories).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });
});
