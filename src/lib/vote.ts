// Client-side wrapper around POST /api/vote. Thin: the interesting
// logic is in the serverless handler (scrape + forward). This module
// only exists so the hook layer has a typed error surface to unwind
// an optimistic update against.

import { trackedFetch } from './networkStatus';

export type VoteHow = 'up' | 'un';

export class VoteError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'VoteError';
    this.status = status;
  }
}

export interface PostVoteDeps {
  fetchImpl?: typeof fetch;
}

export async function postVote(
  id: number,
  how: VoteHow,
  deps: PostVoteDeps = {},
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? trackedFetch;
  let res: Response;
  try {
    res = await fetchImpl('/api/vote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, how }),
    });
  } catch {
    throw new VoteError('Could not reach the server.', 0);
  }
  if (res.status === 204 || res.ok) return;
  let message = how === 'up' ? 'Could not upvote.' : 'Could not unvote.';
  try {
    const body = (await res.json()) as { error?: string };
    if (body && typeof body.error === 'string') message = body.error;
  } catch {
    // keep default
  }
  throw new VoteError(message, res.status);
}
