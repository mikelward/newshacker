import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useHnFavoritesSync } from './useHnFavoritesSync';
import {
  _resetHnFavoritesSyncForTests,
  getHnFavoritesSyncDebug,
} from '../lib/hnFavoritesSync';

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function newClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, networkMode: 'always' },
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('useHnFavoritesSync', () => {
  beforeEach(() => {
    _resetHnFavoritesSyncForTests();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });
  afterEach(() => {
    _resetHnFavoritesSyncForTests();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('runs the bootstrap pull once the user is authenticated', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/me') return jsonResponse({ username: 'alice' });
      if (url === '/api/hn-favorites-list') return jsonResponse({ ids: [42] });
      throw new Error(`Unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useHnFavoritesSync(), { wrapper: wrapper(newClient()) });

    await waitFor(() => {
      expect(getHnFavoritesSyncDebug().bootstrapped).toBe(true);
    });
    expect(getHnFavoritesSyncDebug().username).toBe('alice');
  });

  it('does nothing while the user is not authenticated', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/me')
        return jsonResponse({ error: 'Not authenticated' }, 401);
      throw new Error(`Unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useHnFavoritesSync(), { wrapper: wrapper(newClient()) });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(getHnFavoritesSyncDebug().running).toBe(false);
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/hn-favorites-list',
      expect.anything(),
    );
  });

  it('stops the sync on unmount', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/me') return jsonResponse({ username: 'alice' });
      if (url === '/api/hn-favorites-list') return jsonResponse({ ids: [] });
      throw new Error(`Unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() => useHnFavoritesSync(), {
      wrapper: wrapper(newClient()),
    });
    await waitFor(() => {
      expect(getHnFavoritesSyncDebug().running).toBe(true);
    });
    unmount();
    expect(getHnFavoritesSyncDebug().running).toBe(false);
  });
});
