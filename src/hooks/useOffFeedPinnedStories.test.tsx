import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useOffFeedPinnedStories } from './useOffFeedPinnedStories';
import { addPinnedId } from '../lib/pinnedStories';
import { installHNFetchMock, makeStory } from '../test/mockFetch';

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

describe('useOffFeedPinnedStories', () => {
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
    const { result } = renderHook(
      () => useOffFeedPinnedStories([1, 2, 3]),
      { wrapper: Wrapper },
    );
    expect(result.current.stories).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it('returns empty when every pinned id is already in the feed', async () => {
    addPinnedId(1);
    addPinnedId(2);
    installHNFetchMock({ items: {} });
    const { Wrapper } = wrap();
    const { result } = renderHook(
      () => useOffFeedPinnedStories([1, 2, 3]),
      { wrapper: Wrapper },
    );
    expect(result.current.stories).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it('fetches and returns pinned items missing from the feed', async () => {
    // Pin two items; only one is in the feed id list.
    addPinnedId(10);
    addPinnedId(20);
    installHNFetchMock({
      items: {
        20: makeStory(20, { title: 'Off-feed pin' }),
      },
    });
    const { Wrapper } = wrap();
    const { result } = renderHook(
      () => useOffFeedPinnedStories([10, 30, 40]),
      { wrapper: Wrapper },
    );
    await waitFor(() => {
      expect(result.current.stories).toHaveLength(1);
    });
    expect(result.current.stories[0].id).toBe(20);
    expect(result.current.stories[0].title).toBe('Off-feed pin');
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
    const { result } = renderHook(
      () => useOffFeedPinnedStories([]),
      { wrapper: Wrapper },
    );
    await waitFor(() => {
      expect(result.current.stories).toHaveLength(1);
    });
    expect(result.current.stories[0].id).toBe(300);
  });

  it('orders off-feed pins newest-pinned first', async () => {
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
    const { result } = renderHook(
      () => useOffFeedPinnedStories([]),
      { wrapper: Wrapper },
    );
    await waitFor(() => {
      expect(result.current.stories).toHaveLength(3);
    });
    expect(result.current.stories.map((s) => s.id)).toEqual([2, 3, 1]);
  });

  it('returns empty while feedIds are still loading', () => {
    addPinnedId(5);
    installHNFetchMock({ items: { 5: makeStory(5) } });
    const { Wrapper } = wrap();
    const { result } = renderHook(
      () => useOffFeedPinnedStories(undefined),
      { wrapper: Wrapper },
    );
    expect(result.current.stories).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });
});
