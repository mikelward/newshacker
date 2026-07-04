// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import {
  handleConnectTokenRequest,
  redact,
  sha256Hex,
  _internals,
  type TokenRecord,
  type TokenStore,
} from './connect-token';

const COOKIE = 'hn_session=alice%26hash';
const UNAUTH_COOKIE = 'hn_session=a'; // too short → rejected

function request(
  method: 'GET' | 'POST' | 'DELETE' | 'PUT',
  body?: unknown,
  cookie: string | null = COOKIE,
): Request {
  const headers = new Headers();
  if (cookie !== null) headers.set('cookie', cookie);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request('https://newshacker.app/api/connect-token', {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function createTestStore(): TokenStore & {
  byHash: Map<string, string>;
  byUser: Map<string, TokenRecord[]>;
} {
  const byHash = new Map<string, string>();
  const byUser = new Map<string, TokenRecord[]>();
  return {
    byHash,
    byUser,
    async usernameForHash(hash) {
      return byHash.get(hash) ?? null;
    },
    async listForUser(username) {
      // Return a copy so the handler can't mutate the backing array.
      return [...(byUser.get(username) ?? [])];
    },
    async add(username, rec) {
      const list = byUser.get(username) ?? [];
      list.push(rec);
      byUser.set(username, list);
      byHash.set(rec.hash, username);
    },
    async remove(username, id) {
      const list = byUser.get(username) ?? [];
      const idx = list.findIndex((r) => r.id === id);
      if (idx === -1) return null;
      const [removed] = list.splice(idx, 1);
      byUser.set(username, list);
      byHash.delete(removed.hash);
      return removed;
    },
  };
}

const now = () => 1_700_000_000_000;

describe('handleConnectTokenRequest — POST (mint)', () => {
  let store: ReturnType<typeof createTestStore>;
  beforeEach(() => {
    store = createTestStore();
  });

  it('mints a token, returns it once, stores only its hash', async () => {
    const res = await handleConnectTokenRequest(request('POST'), { store, now });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    const token = body.token as string;
    expect(token.startsWith(_internals.TOKEN_PREFIX)).toBe(true);
    expect(body.last4).toBe(token.slice(-4));
    expect(body.label).toBe('Companion app');
    expect(body.createdAt).toBe(now());
    expect(typeof body.id).toBe('string');
    // The raw token's hash — not the token — is what's stored, and it resolves
    // back to the owner (the exact lookup /api/sync's bearer branch does).
    const hash = await sha256Hex(token);
    expect(await store.usernameForHash(hash)).toBe('alice');
    expect(store.byUser.get('alice')).toHaveLength(1);
    // The stored record never round-trips the raw token.
    expect(JSON.stringify(store.byUser.get('alice'))).not.toContain(token);
  });

  it('normalizes a supplied label', async () => {
    const res = await handleConnectTokenRequest(
      request('POST', { label: '  My  Reader\napp  ' }),
      { store, now },
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.label).toBe('My Reader app');
  });

  it('mints distinct tokens on repeat calls', async () => {
    const a = (await (
      await handleConnectTokenRequest(request('POST'), { store, now })
    ).json()) as Record<string, unknown>;
    const b = (await (
      await handleConnectTokenRequest(request('POST'), { store, now })
    ).json()) as Record<string, unknown>;
    expect(a.token).not.toBe(b.token);
    expect(a.id).not.toBe(b.id);
    expect(store.byUser.get('alice')).toHaveLength(2);
  });

  it('rejects once the per-user cap is reached', async () => {
    for (let i = 0; i < _internals.MAX_TOKENS_PER_USER; i++) {
      await handleConnectTokenRequest(request('POST'), { store, now });
    }
    const res = await handleConnectTokenRequest(request('POST'), { store, now });
    expect(res.status).toBe(409);
  });

  it('401 when unauthenticated', async () => {
    const res = await handleConnectTokenRequest(
      request('POST', undefined, UNAUTH_COOKIE),
      { store, now },
    );
    expect(res.status).toBe(401);
  });

  it('503 when the store is not configured', async () => {
    const res = await handleConnectTokenRequest(request('POST'), {
      store: null,
      now,
    });
    expect(res.status).toBe(503);
  });
});

describe('handleConnectTokenRequest — GET (list)', () => {
  it('lists tokens redacted of the secret and its hash', async () => {
    const store = createTestStore();
    await handleConnectTokenRequest(request('POST', { label: 'Readmo' }), {
      store,
      now,
    });
    const res = await handleConnectTokenRequest(request('GET'), { store, now });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: Array<Record<string, unknown>> };
    expect(body.tokens).toHaveLength(1);
    const t = body.tokens[0];
    expect(t.label).toBe('Readmo');
    expect(t).not.toHaveProperty('hash');
    expect(t).not.toHaveProperty('token');
    expect(t.last4).toHaveLength(4);
  });

  it('returns an empty list for a user with no tokens', async () => {
    const store = createTestStore();
    const res = await handleConnectTokenRequest(request('GET'), { store, now });
    const body = (await res.json()) as { tokens: unknown[] };
    expect(body.tokens).toEqual([]);
  });
});

describe('handleConnectTokenRequest — DELETE (revoke)', () => {
  it('revokes a token by id and invalidates its hash lookup', async () => {
    const store = createTestStore();
    const minted = (await (
      await handleConnectTokenRequest(request('POST'), { store, now })
    ).json()) as Record<string, unknown>;
    const token = minted.token as string;
    const hash = await sha256Hex(token);
    expect(await store.usernameForHash(hash)).toBe('alice');

    const res = await handleConnectTokenRequest(
      request('DELETE', { id: minted.id }),
      { store, now },
    );
    expect(res.status).toBe(200);
    // The revoked token no longer authenticates anywhere.
    expect(await store.usernameForHash(hash)).toBeNull();
    expect(store.byUser.get('alice')).toHaveLength(0);
  });

  it('404 for an unknown id', async () => {
    const store = createTestStore();
    const res = await handleConnectTokenRequest(
      request('DELETE', { id: 'nope' }),
      { store, now },
    );
    expect(res.status).toBe(404);
  });

  it('400 when the id is missing', async () => {
    const store = createTestStore();
    const res = await handleConnectTokenRequest(request('DELETE', {}), {
      store,
      now,
    });
    expect(res.status).toBe(400);
  });

  it("cannot revoke another user's token", async () => {
    const store = createTestStore();
    // alice mints one.
    const minted = (await (
      await handleConnectTokenRequest(request('POST'), { store, now })
    ).json()) as Record<string, unknown>;
    // bob tries to revoke it by id.
    const res = await handleConnectTokenRequest(
      request('DELETE', { id: minted.id }, 'hn_session=bob%26hash'),
      { store, now },
    );
    expect(res.status).toBe(404);
    // alice's token is untouched.
    expect(store.byUser.get('alice')).toHaveLength(1);
  });
});

describe('handleConnectTokenRequest — misc', () => {
  it('405 for an unsupported method', async () => {
    const store = createTestStore();
    const res = await handleConnectTokenRequest(request('PUT'), { store, now });
    expect(res.status).toBe(405);
  });
});

describe('redact', () => {
  it('drops the hash and keeps display fields', () => {
    const rec: TokenRecord = {
      id: 'i',
      label: 'l',
      last4: '1234',
      createdAt: 1,
      hash: 'deadbeef',
    };
    expect(redact(rec)).toEqual({
      id: 'i',
      label: 'l',
      last4: '1234',
      createdAt: 1,
    });
  });
});
