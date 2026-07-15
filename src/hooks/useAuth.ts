import { useCallback, useMemo } from 'react';
import {
  defaultShouldDehydrateQuery,
  useQuery,
  useQueryClient,
  type Query,
} from '@tanstack/react-query';
import { trackedFetch } from '../lib/networkStatus';

export interface AuthUser {
  username: string;
}

export const ME_QUERY_KEY = ['me'] as const;

// Dehydration predicate for the app's PersistQueryClientProvider (wired in
// main.tsx). React Query only persists *successful* queries by default, but
// the `['me']` auth query deliberately enters an *error* state — while
// keeping the last known-good user in memory — when /api/me fails
// ambiguously (see fetchMe). Without overriding this, the next throttled
// snapshot would drop `['me']` from IndexedDB, so a reload inside the same
// offline/app-update window would boot back to anonymous even though the
// user is still signed in. Keep a data-bearing `['me']` query in the
// snapshot regardless of status; React Query restores it (status stays
// 'error', data preserved) and the refetch triggers re-confirm it. A
// logged-out `['me']` (data === null) still rides the default path.
export function shouldDehydrateAppQuery(query: Query): boolean {
  if (defaultShouldDehydrateQuery(query)) return true;
  return query.queryKey[0] === ME_QUERY_KEY[0] && query.state.data != null;
}

export class LoginError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'LoginError';
    this.status = status;
  }
}

// Raised when /api/me couldn't give us a trustworthy answer (offline,
// deploy-window 5xx, a service-worker error page). Distinct from a real
// 401, which is the origin's own proof that the caller is signed out.
export class AuthUnavailableError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AuthUnavailableError';
    this.status = status;
  }
}

async function fetchMe(signal?: AbortSignal): Promise<AuthUser | null> {
  let res: Response;
  try {
    res = await trackedFetch('/api/me', { signal });
  } catch (err) {
    // Offline / transient network failure. The request never reached our
    // origin, so this is NOT proof the user is logged out — throw so React
    // Query keeps the last known-good (persisted) auth state instead of
    // blanking a signed-in user to anonymous the moment one request fails
    // (e.g. mid service-worker update). The `refetch*` wiring in useAuth
    // re-checks in the background once connectivity is back.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new AuthUnavailableError(
      err instanceof Error ? err.message : 'Could not reach /api/me',
    );
  }
  // Only a 401 from our own origin is proof of "signed out" — the session
  // cookie is absent or invalid (see api/me.ts, which has no upstream
  // dependency and can't 5xx from one). Return null so the logged-out state
  // is recorded and not retried.
  if (res.status === 401) return null;
  // Any other non-OK status is ambiguous — a deploy-window 5xx, a proxy
  // 502/503, a stale SW error page. Throw to preserve the last-good state
  // rather than logging the user out on it.
  if (!res.ok) {
    throw new AuthUnavailableError(`/api/me returned ${res.status}`, res.status);
  }
  const body = (await res.json().catch(() => null)) as Partial<AuthUser> | null;
  if (!body || typeof body.username !== 'string') {
    throw new AuthUnavailableError('/api/me returned an unexpected body');
  }
  return { username: body.username };
}

async function postLogin(username: string, password: string): Promise<AuthUser> {
  const res = await trackedFetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.status === 401) {
    throw new LoginError('Incorrect username or password.', 401);
  }
  if (!res.ok) {
    let message = 'Login failed.';
    try {
      const body = (await res.json()) as { error?: string };
      if (body && typeof body.error === 'string') message = body.error;
    } catch {
      // keep default
    }
    throw new LoginError(message, res.status);
  }
  return (await res.json()) as AuthUser;
}

async function postLogout(): Promise<void> {
  try {
    await trackedFetch('/api/logout', { method: 'POST' });
  } catch {
    // Best-effort: if the call fails we still clear local state so the
    // user isn't stuck "logged in" on the client.
  }
}

export function useAuth() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: ({ signal }) => fetchMe(signal),
    // A 30-day session cookie means the answer rarely changes within a
    // browsing session, so serve it fresh for an hour. But DO re-check in
    // the background when the tab regains focus or the device reconnects:
    // that's how we notice a session that expired while the tab was away,
    // and how a logged-in state that a transient boot-time failure couldn't
    // confirm recovers on its own instead of sitting stuck as anonymous.
    // Both refetch triggers are stale-gated by staleTime, so they fire at
    // most once an hour — no per-focus request storm.
    staleTime: 60 * 60 * 1000,
    // No retry here: a failed /api/me leaves the query in an error state but
    // React Query keeps the last known-good (persisted) data, so a signed-in
    // user stays signed in through a transient failure (see fetchMe, which
    // throws rather than returning null on ambiguous failures). Recovery
    // comes from the refetch triggers above — in particular
    // refetchOnReconnect, which fires when the connectivity tracker's
    // recovery probe restores onlineManager after the blip that caused the
    // failure — the same "lean on reconnect, not retry" shape the feed uses.
    retry: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  const login = useCallback(
    async (username: string, password: string): Promise<AuthUser> => {
      const user = await postLogin(username, password);
      // Cancel any in-flight /api/me refetch (a focus/reconnect background
      // refresh) before writing the authoritative result. Otherwise a
      // refetch that started while logged out could resolve to null *after*
      // this and clobber the just-signed-in user back to anonymous.
      await client.cancelQueries({ queryKey: ME_QUERY_KEY });
      client.setQueryData(ME_QUERY_KEY, user);
      return user;
    },
    [client],
  );

  const logout = useCallback(async (): Promise<void> => {
    await postLogout();
    // Same race, inverted: a background /api/me refetch in flight when the
    // user taps Log out could resolve to `{ username }` after we clear the
    // cache and resurrect the signed-in UI even though the cookie is gone.
    // Cancel it (aborts the fetch and drops its result) before writing null.
    await client.cancelQueries({ queryKey: ME_QUERY_KEY });
    client.setQueryData(ME_QUERY_KEY, null);
  }, [client]);

  return useMemo(
    () => ({
      user: query.data ?? null,
      isLoading: query.isLoading,
      isAuthenticated: !!query.data,
      login,
      logout,
    }),
    [query.data, query.isLoading, login, logout],
  );
}

export { fetchMe as _fetchMeForTests, postLogin as _postLoginForTests };
