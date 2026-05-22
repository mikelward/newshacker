import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePinnedFeedStories } from './usePinnedFeedStories';
import { addPinnedId } from '../lib/pinnedStories';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import type { HNItem } from '../lib/hn';

function wrap() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, networkMode: 'offlineFirst' },
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

  it('orders pins newest-pinned first', async () => {
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
    expect(result.current.stories.map((s) => s.id)).toEqual([2, 3, 1]);
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
