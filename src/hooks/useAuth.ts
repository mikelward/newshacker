import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { trackedFetch } from '../lib/networkStatus';

export interface AuthUser {
  username: string;
}

export const ME_QUERY_KEY = ['me'] as const;

export class LoginError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'LoginError';
    this.status = status;
  }
}

async function fetchMe(signal?: AbortSignal): Promise<AuthUser | null> {
  let res: Response;
  try {
    res = await trackedFetch('/api/me', { signal });
  } catch {
    // Offline / transient network failure. Treat as "unknown" by
    // returning null — we don't want to wipe a persisted logged-in state
    // just because the user briefly lost signal.
    return null;
  }
  if (res.status === 401) return null;
  if (!res.ok) return null;
  return (await res.json()) as AuthUser;
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
    // A 30-day session cookie means this doesn't really change within
    // a browsing session. Re-check at most once per hour.
    staleTime: 60 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const login = useCallback(
    async (username: string, password: string): Promise<AuthUser> => {
      const user = await postLogin(username, password);
      client.setQueryData(ME_QUERY_KEY, user);
      return user;
    },
    [client],
  );

  const logout = useCallback(async (): Promise<void> => {
    await postLogout();
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
