import { useCallback, useEffect, useState } from 'react';
import {
  addDownvotedId,
  addVotedId,
  getDownvotedIds,
  getVotedIds,
  removeDownvotedId,
  removeVotedId,
  VOTES_CHANGE_EVENT,
} from '../lib/votes';
import { postVote, VoteError, type VoteHow } from '../lib/vote';
import { useToast } from './useToast';
import { useAuth } from './useAuth';

export interface UseVoteResult {
  // Items the logged-in user has up- or down-voted (as far as this
  // device knows). Empty when logged out. Disjoint sets by
  // construction — voting one direction clears the other.
  votedIds: Set<number>;
  downvotedIds: Set<number>;
  isVoted: (id: number) => boolean;
  isDownvoted: (id: number) => boolean;
  // Fire-and-forget optimistic vote toggles. No-op when logged out.
  // toggleVote flips up ↔ none (or down → up if already downvoted);
  // toggleDownvote does the inverse. Switching directions is two
  // API hits because HN models it that way: clear the prior vote,
  // then cast the new one.
  toggleVote: (id: number) => void;
  toggleDownvote: (id: number) => void;
}

// Optimistic voting for stories and comments. Flips the local voted
// state immediately, POSTs /api/vote in the background, and rolls
// back + toasts on failure. Explicitly NOT a retry queue — per SPEC
// Non-Goals "Background sync of offline votes" is out of scope, so a
// transient failure surfaces as a toast and the user can retry
// manually.
export function useVote(): UseVoteResult {
  const { user } = useAuth();
  const username = user?.username ?? '';
  const { showToast } = useToast();

  const [votedIds, setVotedIds] = useState<Set<number>>(() =>
    username ? getVotedIds(username) : new Set(),
  );
  const [downvotedIds, setDownvotedIds] = useState<Set<number>>(() =>
    username ? getDownvotedIds(username) : new Set(),
  );

  useEffect(() => {
    if (!username) {
      setVotedIds(new Set());
      setDownvotedIds(new Set());
      return;
    }
    setVotedIds(getVotedIds(username));
    setDownvotedIds(getDownvotedIds(username));
    const sync = () => {
      setVotedIds(getVotedIds(username));
      setDownvotedIds(getDownvotedIds(username));
    };
    window.addEventListener(VOTES_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(VOTES_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [username]);

  // Simple flip+POST for the no-direction-switch cases: first-time
  // vote, or clear-existing. Rolls back locally and toasts on
  // failure.
  const flipAndPost = useCallback(
    (id: number, how: VoteHow, undo: () => void, fallback: string) => {
      void postVote(id, how).catch((err: unknown) => {
        undo();
        const message =
          err instanceof VoteError && err.message ? err.message : fallback;
        showToast({ message });
      });
    },
    [showToast],
  );

  // Direction-switch helper: viewer has a vote in the opposite
  // direction. HN requires an explicit `un` before the new vote can
  // be cast, so we chain un → new. Each leg is isolated so a partial
  // failure leaves local state matching the server rather than lying
  // about it, and the fallback toast describes the actual failing
  // leg rather than always naming the final-direction action — if
  // the `un` leg is what failed the user otherwise sees "Could not
  // downvote" when the real problem is the unvote step.
  //   1. `un` fails           → server still at `from`; restore the
  //                             `from`-direction local state. Toast
  //                             says "Could not unvote."
  //   2. `un` ok, new fails   → server now NEUTRAL; clear both local
  //                             sets (do NOT roll back to `from`).
  //                             Toast says "Could not up/downvote."
  //                             matching the final-leg action.
  //   3. both ok              → optimistic state is correct.
  const chainSwitch = useCallback(
    (id: number, from: 'up' | 'down', to: 'up' | 'down') => {
      void (async () => {
        try {
          await postVote(id, 'un');
        } catch (err: unknown) {
          if (from === 'up') {
            removeDownvotedId(username, id);
            addVotedId(username, id);
          } else {
            removeVotedId(username, id);
            addDownvotedId(username, id);
          }
          const message =
            err instanceof VoteError && err.message
              ? err.message
              : 'Could not unvote.';
          showToast({ message });
          return;
        }
        try {
          await postVote(id, to);
        } catch (err: unknown) {
          removeVotedId(username, id);
          removeDownvotedId(username, id);
          const fallback =
            to === 'up' ? 'Could not upvote.' : 'Could not downvote.';
          const message =
            err instanceof VoteError && err.message ? err.message : fallback;
          showToast({ message });
        }
      })();
    },
    [username, showToast],
  );

  const toggleVote = useCallback(
    (id: number) => {
      if (!username) return;
      const upvoted = getVotedIds(username).has(id);
      const downvoted = getDownvotedIds(username).has(id);

      if (upvoted) {
        removeVotedId(username, id);
        flipAndPost(
          id,
          'un',
          () => addVotedId(username, id),
          'Could not unvote.',
        );
        return;
      }
      if (downvoted) {
        // down → up: chained unvote then upvote.
        removeDownvotedId(username, id);
        addVotedId(username, id);
        chainSwitch(id, 'down', 'up');
        return;
      }
      addVotedId(username, id);
      flipAndPost(
        id,
        'up',
        () => removeVotedId(username, id),
        'Could not upvote.',
      );
    },
    [username, flipAndPost, chainSwitch],
  );

  const toggleDownvote = useCallback(
    (id: number) => {
      if (!username) return;
      const downvoted = getDownvotedIds(username).has(id);
      const upvoted = getVotedIds(username).has(id);

      if (downvoted) {
        // Un-downvote: HN uses how=un for either direction.
        removeDownvotedId(username, id);
        flipAndPost(
          id,
          'un',
          () => addDownvotedId(username, id),
          'Could not unvote.',
        );
        return;
      }
      if (upvoted) {
        // up → down: chained unvote then downvote.
        removeVotedId(username, id);
        addDownvotedId(username, id);
        chainSwitch(id, 'up', 'down');
        return;
      }
      addDownvotedId(username, id);
      flipAndPost(
        id,
        'down',
        () => removeDownvotedId(username, id),
        'Could not downvote.',
      );
    },
    [username, flipAndPost, chainSwitch],
  );

  const isVoted = useCallback((id: number) => votedIds.has(id), [votedIds]);
  const isDownvoted = useCallback(
    (id: number) => downvotedIds.has(id),
    [downvotedIds],
  );

  return {
    votedIds,
    downvotedIds,
    isVoted,
    isDownvoted,
    toggleVote,
    toggleDownvote,
  };
}
