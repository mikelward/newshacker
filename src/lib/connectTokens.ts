// Client for /api/connect-token — the app tokens a signed-in user mints so a
// trusted companion app (Readmo) can mirror their Done/Pinned/etc. to
// /api/sync server-to-server. The raw token is shown exactly once at creation;
// thereafter only its redacted metadata (id / label / last4 / createdAt) is
// listable. See SPEC § "Connecting a companion app".
//
// fetch is injectable so tests can drive the network without MSW, matching
// cloudSync.ts; production passes trackedFetch (same-origin, cookie auth).

import { trackedFetch } from './networkStatus';

const ENDPOINT = '/api/connect-token';

/** A stored token as the server lists it — never the secret itself. */
export interface RedactedToken {
  id: string;
  label: string;
  /** Last 4 chars of the raw token, to tell two tokens apart. */
  last4: string;
  createdAt: number;
}

/** The one-time creation result — carries the raw `token` in addition to the
 * redacted metadata. The caller must surface it immediately; it can't be
 * re-fetched. */
export interface CreatedToken extends RedactedToken {
  token: string;
}

export type FetchImpl = typeof fetch;

export class ConnectTokenError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ConnectTokenError';
    this.status = status;
  }
}

async function errorFrom(res: Response, fallback: string): Promise<never> {
  let message = fallback;
  try {
    const body = (await res.json()) as { error?: string };
    if (body && typeof body.error === 'string') message = body.error;
  } catch {
    // keep fallback
  }
  throw new ConnectTokenError(message, res.status);
}

export async function listTokens(
  fetchImpl: FetchImpl = trackedFetch,
): Promise<RedactedToken[]> {
  const res = await fetchImpl(ENDPOINT);
  if (!res.ok) return errorFrom(res, 'Could not load tokens.');
  const body = (await res.json()) as { tokens?: RedactedToken[] };
  return Array.isArray(body.tokens) ? body.tokens : [];
}

export async function createToken(
  label: string,
  fetchImpl: FetchImpl = trackedFetch,
): Promise<CreatedToken> {
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) return errorFrom(res, 'Could not create a token.');
  return (await res.json()) as CreatedToken;
}

export async function revokeToken(
  id: string,
  fetchImpl: FetchImpl = trackedFetch,
): Promise<void> {
  const res = await fetchImpl(ENDPOINT, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) await errorFrom(res, 'Could not revoke the token.');
}
