import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCloudSync } from './useCloudSync';
import {
  stopCloudSync,
  _getCloudSyncRuntimeForTests,
} from '../lib/cloudSync';

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

describe('useCloudSync', () => {
  beforeEach(() => {
    stopCloudSync();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });
  afterEach(() => {
    stopCloudSync();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('starts cloudSync after the user logs in', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/me') return jsonResponse({ username: 'alice' });
      if (url === '/api/sync')
        return jsonResponse({ pinned: [], favorite: [], ignored: [] });
      throw new Error(`Unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = newClient();
    renderHook(() => useCloudSync(), { wrapper: wrapper(client) });

    await waitFor(() => {
      expect(_getCloudSyncRuntimeForTests()?.username).toBe('alice');
    });
  });

  it('does nothing while the user is not authenticated', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/me')
        return jsonResponse({ error: 'Not authenticated' }, 401);
      throw new Error(`Unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = newClient();
    renderHook(() => useCloudSync(), { wrapper: wrapper(client) });

    // Let the /api/me query settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(_getCloudSyncRuntimeForTests()).toBeNull();
  });

  it('stops cloudSync on unmount', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/me') return jsonResponse({ username: 'alice' });
      if (url === '/api/sync')
        return jsonResponse({ pinned: [], favorite: [], ignored: [] });
      throw new Error(`Unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = newClient();
    const { unmount } = renderHook(() => useCloudSync(), {
      wrapper: wrapper(client),
    });

    await waitFor(() => {
      expect(_getCloudSyncRuntimeForTests()?.username).toBe('alice');
    });
    unmount();
    expect(_getCloudSyncRuntimeForTests()).toBeNull();
  });
});
