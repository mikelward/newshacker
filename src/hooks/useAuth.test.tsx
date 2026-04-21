import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LoginError, useAuth } from './useAuth';

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

function mockFetchSequence(responses: Array<Response | (() => Response | Promise<Response>)>) {
  const mock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('No more mocked fetch responses');
    return typeof next === 'function' ? await next() : next;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('useAuth', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts unauthenticated and resolves to null when /api/me returns 401', async () => {
    mockFetchSequence([jsonResponse({ error: 'Not authenticated' }, 401)]);
    const client = newClient();
    const { result } = renderHook(() => useAuth(), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('resolves to the user when /api/me returns a username', async () => {
    mockFetchSequence([jsonResponse({ username: 'alice' })]);
    const client = newClient();
    const { result } = renderHook(() => useAuth(), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.user).toEqual({ username: 'alice' });
    expect(result.current.isAuthenticated).toBe(true);
  });

  it('login() posts credentials and updates the cached user on success', async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse({ error: 'Not authenticated' }, 401), // initial /api/me
      jsonResponse({ username: 'alice' }, 200), // /api/login
    ]);
    const client = newClient();
    const { result } = renderHook(() => useAuth(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.login('alice', 'pw');
    });

    await waitFor(() => {
      expect(result.current.user).toEqual({ username: 'alice' });
    });
    expect(result.current.isAuthenticated).toBe(true);

    const loginCall = fetchMock.mock.calls[1];
    expect(loginCall[0]).toBe('/api/login');
    const init = loginCall[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ username: 'alice', password: 'pw' });
  });

  it('login() throws LoginError on 401', async () => {
    mockFetchSequence([
      jsonResponse({ error: 'Not authenticated' }, 401), // initial /api/me
      jsonResponse({ error: 'Bad login' }, 401), // /api/login
    ]);
    const client = newClient();
    const { result } = renderHook(() => useAuth(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.login('alice', 'wrong');
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeInstanceOf(LoginError);
    expect((caught as LoginError).status).toBe(401);
    expect(result.current.user).toBeNull();
  });

  it('logout() calls /api/logout and clears the cached user', async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse({ username: 'alice' }, 200), // initial /api/me — logged in
      jsonResponse({ ok: true }, 200), // /api/logout
    ]);
    const client = newClient();
    const { result } = renderHook(() => useAuth(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    await act(async () => {
      await result.current.logout();
    });

    await waitFor(() => expect(result.current.user).toBeNull());
    expect(result.current.isAuthenticated).toBe(false);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/logout');
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('POST');
  });

  it('logout() still clears local state when the request fails', async () => {
    mockFetchSequence([
      jsonResponse({ username: 'alice' }, 200),
      () => {
        throw new Error('offline');
      },
    ]);
    const client = newClient();
    const { result } = renderHook(() => useAuth(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    await act(async () => {
      await result.current.logout();
    });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(false));
  });
});
