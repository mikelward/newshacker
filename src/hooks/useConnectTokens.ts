import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createToken,
  listTokens,
  revokeToken,
  type CreatedToken,
} from '../lib/connectTokens';

export const CONNECT_TOKENS_QUERY_KEY = ['connect-tokens'] as const;

/**
 * App tokens for the signed-in user (see {@link ConnectedApps}). Pass the
 * signed-in `username` (or null when logged out): it gates the fetch AND scopes
 * the cache key, so switching accounts on a shared device can't show one user's
 * token list to the next within `staleTime` (the redacted-but-still-private
 * list, and revokes that would target the wrong account's ids). `create`/
 * `revoke` invalidate by the base key (prefix match), covering the active user.
 */
export function useConnectTokens(username: string | null) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: [...CONNECT_TOKENS_QUERY_KEY, username],
    queryFn: () => listTokens(),
    enabled: username != null,
    staleTime: 60 * 1000,
    retry: false,
  });

  const create = useCallback(
    async (label: string): Promise<CreatedToken> => {
      const created = await createToken(label);
      await client.invalidateQueries({ queryKey: CONNECT_TOKENS_QUERY_KEY });
      return created;
    },
    [client],
  );

  const revoke = useCallback(
    async (id: string): Promise<void> => {
      await revokeToken(id);
      await client.invalidateQueries({ queryKey: CONNECT_TOKENS_QUERY_KEY });
    },
    [client],
  );

  return useMemo(
    () => ({
      tokens: query.data ?? [],
      isLoading: query.isLoading,
      create,
      revoke,
    }),
    [query.data, query.isLoading, create, revoke],
  );
}
