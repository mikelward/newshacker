import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFavorites } from './useFavorites';
import { addFavoriteId } from '../lib/favorites';
import { listQueue } from '../lib/hnFavoriteQueue';
import { _resetHnFavoritesSyncForTests } from '../lib/hnFavoritesSync';

function newClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, networkMode: 'always' },
    },
  });
}

function stubAuthFetch(username: string | null): void {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/me') {
      if (username) {
        return new Response(JSON.stringify({ username }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'nope' }), { status: 401 });
    }
    // Quietly drop any other endpoints — useFavorites itself doesn't
    // make HTTP calls; only the sync worker might, and it isn't
    // running in this test.
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useFavorites', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    _resetHnFavoritesSyncForTests();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    _resetHnFavoritesSyncForTests();
  });

  it('reads existing ids from storage on mount', () => {
    addFavoriteId(42);
    stubAuthFetch(null);
    const { result } = renderHook(() => useFavorites(), {
      wrapper: wrapperFor(newClient()),
    });
    expect(result.current.isFavorite(42)).toBe(true);
    expect(result.current.isFavorite(1)).toBe(false);
  });

  it('favorite() updates state and persists (logged out)', () => {
    stubAuthFetch(null);
    const { result } = renderHook(() => useFavorites(), {
      wrapper: wrapperFor(newClient()),
    });
    act(() => {
      result.current.favorite(7);
    });
    expect(result.current.favoriteIds.has(7)).toBe(true);
    // Logged-out user: no queued HN action.
    expect(listQueue('anyone')).toEqual([]);
  });

  it('unfavorite() removes the id (logged out)', () => {
    addFavoriteId(3);
    stubAuthFetch(null);
    const { result } = renderHook(() => useFavorites(), {
      wrapper: wrapperFor(newClient()),
    });
    act(() => {
      result.current.unfavorite(3);
    });
    expect(result.current.isFavorite(3)).toBe(false);
  });

  it('toggleFavorite() adds when absent and removes when present', () => {
    stubAuthFetch(null);
    const { result } = renderHook(() => useFavorites(), {
      wrapper: wrapperFor(newClient()),
    });
    act(() => {
      result.current.toggleFavorite(11);
    });
    expect(result.current.isFavorite(11)).toBe(true);
    act(() => {
      result.current.toggleFavorite(11);
    });
    expect(result.current.isFavorite(11)).toBe(false);
  });

  it('keeps multiple hook instances in sync via events', () => {
    stubAuthFetch(null);
    const client = newClient();
    const a = renderHook(() => useFavorites(), {
      wrapper: wrapperFor(client),
    });
    const b = renderHook(() => useFavorites(), {
      wrapper: wrapperFor(client),
    });
    act(() => {
      a.result.current.favorite(9);
    });
    expect(b.result.current.isFavorite(9)).toBe(true);
  });

  it('cleans up event listeners on unmount', () => {
    stubAuthFetch(null);
    const client = newClient();
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <Consumer />
      </QueryClientProvider>,
    );
    expect(() => unmount()).not.toThrow();
  });

  describe('HN enqueue when logged in', () => {
    // Poll until useAuth resolves /api/me and the callback closures
    // in the returned hook close over the username. We detect that
    // transition by waiting for a no-op test enqueue to land in the
    // correct per-user queue key.
    async function waitUntilLoggedIn(
      result: { current: ReturnType<typeof useFavorites> },
    ): Promise<void> {
      const probeId = 9_999_999;
      await waitFor(() => {
        act(() => {
          result.current.favorite(probeId);
        });
        expect(listQueue('alice').some((e) => e.id === probeId)).toBe(true);
      });
      // Unwind the probe so the real assertion starts from an empty queue.
      act(() => {
        result.current.unfavorite(probeId);
      });
      expect(listQueue('alice').some((e) => e.id === probeId)).toBe(false);
    }

    it('favorite() enqueues a favorite action under the signed-in user', async () => {
      stubAuthFetch('alice');
      const { result } = renderHook(() => useFavorites(), {
        wrapper: wrapperFor(newClient()),
      });
      await waitUntilLoggedIn(result);
      act(() => {
        result.current.favorite(42);
      });
      expect(listQueue('alice').map((e) => e.id)).toEqual([42]);
      expect(listQueue('alice')[0].action).toBe('favorite');
    });

    it('unfavorite() enqueues an unfavorite action', async () => {
      addFavoriteId(77);
      stubAuthFetch('alice');
      const { result } = renderHook(() => useFavorites(), {
        wrapper: wrapperFor(newClient()),
      });
      await waitUntilLoggedIn(result);
      act(() => {
        result.current.unfavorite(77);
      });
      expect(listQueue('alice').map((e) => e.id)).toEqual([77]);
      expect(listQueue('alice')[0].action).toBe('unfavorite');
    });

    it('toggleFavorite() enqueues the right action in each direction', async () => {
      stubAuthFetch('alice');
      const { result } = renderHook(() => useFavorites(), {
        wrapper: wrapperFor(newClient()),
      });
      await waitUntilLoggedIn(result);

      act(() => {
        result.current.toggleFavorite(5);
      });
      expect(listQueue('alice')).toHaveLength(1);
      expect(listQueue('alice')[0].action).toBe('favorite');

      // Toggle again — coalescing in the queue cancels the pair.
      act(() => {
        result.current.toggleFavorite(5);
      });
      expect(listQueue('alice')).toEqual([]);
    });
  });
});

function Consumer() {
  useFavorites();
  return null;
}
