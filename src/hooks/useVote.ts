import { useCallback, useEffect, useState } from 'react';
import {
  addVotedId,
  getVotedIds,
  removeVotedId,
  VOTES_CHANGE_EVENT,
} from '../lib/votes';
import { postVote, VoteError, type VoteHow } from '../lib/vote';
import { useToast } from './useToast';
import { useAuth } from './useAuth';

export interface UseVoteResult {
  // Items the logged-in user has voted on (as far as this device
  // knows). Empty when logged out.
  votedIds: Set<number>;
  isVoted: (id: number) => boolean;
  // Fire-and-forget optimistic vote toggle. No-op when logged out.
  toggleVote: (id: number) => void;
}

// Optimistic voting for story rows. Flips the local voted state
// immediately, POSTs /api/vote in the background, and rolls back +
// toasts on failure. Explicitly NOT a retry queue — per SPEC Non-Goals
// "Background sync of offline votes" is out of scope, so a transient
// failure surfaces as a toast and the user can retry manually.
export function useVote(): UseVoteResult {
  const { user } = useAuth();
  const username = user?.username ?? '';
  const { showToast } = useToast();

  const [votedIds, setVotedIds] = useState<Set<number>>(() =>
    username ? getVotedIds(username) : new Set(),
  );

  useEffect(() => {
    if (!username) {
      setVotedIds(new Set());
      return;
    }
    setVotedIds(getVotedIds(username));
    const sync = () => setVotedIds(getVotedIds(username));
    window.addEventListener(VOTES_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(VOTES_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [username]);

  const toggleVote = useCallback(
    (id: number) => {
      if (!username) return;
      const currentlyVoted = getVotedIds(username).has(id);
      const how: VoteHow = currentlyVoted ? 'un' : 'up';

      // Optimistic write: flip local state immediately.
      if (currentlyVoted) removeVotedId(username, id);
      else addVotedId(username, id);

      void postVote(id, how).catch((err: unknown) => {
        // Roll back.
        if (currentlyVoted) addVotedId(username, id);
        else removeVotedId(username, id);

        const fallback =
          how === 'up' ? 'Could not upvote.' : 'Could not unvote.';
        const message =
          err instanceof VoteError && err.message ? err.message : fallback;
        showToast({ message });
      });
    },
    [username, showToast],
  );

  const isVoted = useCallback((id: number) => votedIds.has(id), [votedIds]);

  return { votedIds, isVoted, toggleVote };
}
