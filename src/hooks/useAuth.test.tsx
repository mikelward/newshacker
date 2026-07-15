import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dehydrate } from '@tanstack/react-query';
import {
  AuthUnavailableError,
  LoginError,
  ME_QUERY_KEY,
  shouldDehydrateAppQuery,
  useAuth,
  _fetchMeForTests,
} from './useAuth';

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function newClient() {
  return new QueryClient({
    defaultOptions: {
      // `retry`/`staleTime` are set per-query by useAuth; keep `retryDelay`
      // at 0 here so the hook's bounded background retries settle instantly
      // in tests instead of running the default exponential backoff.
      queries: { gcTime: 0, retryDelay: 0, networkMode: 'always' },
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

  // Regression: enabling background refetch (focus/reconnect) introduced a
  // race where a /api/me GET in flight when the user taps Log out could
  // resolve to `{ username }` *after* logout() cleared the cache and
  // resurrect the signed-in UI even though the cookie is gone. logout()
  // cancels the in-flight refetch, so its late result is dropped.
  it('logout is not resurrected by an in-flight /api/me refetch', async () => {
    let releaseMe!: () => void;
    const meGate = new Promise<void>((r) => {
      releaseMe = r;
    });
    let meCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/logout')) return jsonResponse({ ok: true });
      if (url.includes('/api/me')) {
        meCalls += 1;
        if (meCalls >= 2) await meGate; // the background refetch hangs
        return jsonResponse({ username: 'alice' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = newClient();
    const { result } = renderHook(() => useAuth(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    // Kick a background refetch that will still be in flight at logout time.
    act(() => {
      void client.invalidateQueries({ queryKey: ME_QUERY_KEY });
    });
    await waitFor(() => expect(meCalls).toBe(2));

    await act(async () => {
      await result.current.logout();
    });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(false));

    // The stale refetch resolves now — it must NOT put the user back.
    releaseMe();
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
  });

  // Regression: a service-worker update (or any transient network blip)
  // used to blank a signed-in user to anonymous, then get stuck there —
  // fetchMe swallowed the failure into `null`, and staleTime + no
  // refetch-on-focus meant it never re-checked. A failed background
  // refetch must now keep the last known-good user instead.
  it('keeps the last-good user when a background /api/me refetch fails', async () => {
    let mode: 'ok' | 'throw' = 'ok';
    const fetchMock = vi.fn(async () => {
      if (mode === 'throw') throw new TypeError('Failed to fetch');
      return jsonResponse({ username: 'alice' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = newClient();
    const { result } = renderHook(() => useAuth(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    mode = 'throw';
    await act(async () => {
      await client.invalidateQueries({ queryKey: ME_QUERY_KEY });
    });

    expect(result.current.user).toEqual({ username: 'alice' });
    expect(result.current.isAuthenticated).toBe(true);
  });

  // The flip side: a real 401 on a background refetch (session expired
  // while the tab was away) must be detected and flip the user to logged
  // out — "detect when logged out rather than doing nothing".
  it('flips to logged out when a background refetch returns 401', async () => {
    let mode: 'ok' | '401' = 'ok';
    const fetchMock = vi.fn(async () =>
      mode === 'ok'
        ? jsonResponse({ username: 'alice' })
        : jsonResponse({ error: 'Not authenticated' }, 401),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = newClient();
    const { result } = renderHook(() => useAuth(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    mode = '401';
    await act(async () => {
      await client.invalidateQueries({ queryKey: ME_QUERY_KEY });
    });

    await waitFor(() => expect(result.current.isAuthenticated).toBe(false));
    expect(result.current.user).toBeNull();
  });
});

describe('fetchMe', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns the user on a 200 with a username', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ username: 'alice' })));
    await expect(_fetchMeForTests()).resolves.toEqual({ username: 'alice' });
  });

  it('returns null on a 401 (definitively signed out)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'Not authenticated' }, 401)),
    );
    await expect(_fetchMeForTests()).resolves.toBeNull();
  });

  it('throws AuthUnavailableError when the request throws (offline)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(_fetchMeForTests()).rejects.toBeInstanceOf(AuthUnavailableError);
  });

  it('throws AuthUnavailableError on an ambiguous non-401 error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'boom' }, 503)),
    );
    await expect(_fetchMeForTests()).rejects.toMatchObject({
      name: 'AuthUnavailableError',
      status: 503,
    });
  });

  it('throws AuthUnavailableError on a 200 with no username', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})));
    await expect(_fetchMeForTests()).rejects.toBeInstanceOf(AuthUnavailableError);
  });
});

describe('shouldDehydrateAppQuery', () => {
  type FakeQuery = Parameters<typeof shouldDehydrateAppQuery>[0];
  const fake = (
    queryKey: readonly unknown[],
    status: 'success' | 'error' | 'pending',
    data: unknown,
  ): FakeQuery => ({ queryKey, state: { status, data } }) as unknown as FakeQuery;

  it('persists a data-bearing ["me"] query even in the error state', () => {
    // A signed-in user retained through a failed background /api/me refetch.
    expect(shouldDehydrateAppQuery(fake(ME_QUERY_KEY, 'error', { username: 'alice' }))).toBe(true);
  });

  it('does not force-persist a logged-out ["me"] error (data null)', () => {
    expect(shouldDehydrateAppQuery(fake(ME_QUERY_KEY, 'error', null))).toBe(false);
  });

  it('keeps default behavior: successful queries persist, other errors do not', () => {
    expect(shouldDehydrateAppQuery(fake(ME_QUERY_KEY, 'success', null))).toBe(true);
    expect(shouldDehydrateAppQuery(fake(['itemRoot', 1], 'success', { x: 1 }))).toBe(true);
    expect(shouldDehydrateAppQuery(fake(['itemRoot', 1], 'error', { x: 1 }))).toBe(false);
  });

  // End-to-end guard: a real errored-but-data-bearing ['me'] query must
  // land in the persisted snapshot (not just satisfy the predicate), so a
  // reload during the failure window rehydrates the signed-in user.
  it('includes an errored ["me"] with retained data in the dehydrated snapshot', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, networkMode: 'always' } },
    });
    client.setQueryData(ME_QUERY_KEY, { username: 'alice' });
    await client
      .fetchQuery({
        queryKey: ME_QUERY_KEY,
        queryFn: () => {
          throw new AuthUnavailableError('offline');
        },
      })
      .catch(() => {});

    const state = client.getQueryState(ME_QUERY_KEY);
    expect(state?.status).toBe('error');
    expect(state?.data).toEqual({ username: 'alice' });

    const snapshot = dehydrate(client, {
      shouldDehydrateQuery: shouldDehydrateAppQuery,
    });
    const me = snapshot.queries.find((q) => q.queryKey[0] === 'me');
    expect(me).toBeDefined();
    expect(me?.state.data).toEqual({ username: 'alice' });
  });
});
