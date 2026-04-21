import { beforeEach, describe, expect, it } from 'vitest';
import {
  handleSyncRequest,
  mergeEntries,
  type SyncEntry,
  type SyncState,
  type SyncStore,
  _internals,
} from './sync';

const COOKIE = 'hn_session=alice%26hash';
const UNAUTH_COOKIE = 'hn_session=a'; // too short → rejected
const OTHER_USER_COOKIE = 'hn_session=bob%26hash';

function request(
  method: 'GET' | 'POST' | 'PUT',
  body?: unknown,
  cookie: string | null = COOKIE,
): Request {
  const headers = new Headers();
  if (cookie !== null) headers.set('cookie', cookie);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request('https://newshacker.app/api/sync', {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function emptyState(): SyncState {
  return { pinned: [], favorite: [], hidden: [] };
}

function createTestStore(): SyncStore & {
  map: Map<string, SyncState>;
  failGet: boolean;
  failSet: boolean;
} {
  const map = new Map<string, SyncState>();
  const state = { failGet: false, failSet: false };
  return {
    map,
    get failGet() {
      return state.failGet;
    },
    set failGet(v) {
      state.failGet = v;
    },
    get failSet() {
      return state.failSet;
    },
    set failSet(v) {
      state.failSet = v;
    },
    async get(username) {
      if (state.failGet) throw new Error('boom');
      return map.get(username) ?? emptyState();
    },
    async set(username, s) {
      if (state.failSet) throw new Error('boom');
      map.set(username, s);
    },
  };
}

describe('mergeEntries', () => {
  it('merges disjoint id sets', () => {
    const merged = mergeEntries(
      [{ id: 1, at: 100 }],
      [{ id: 2, at: 200 }],
    );
    expect(merged).toEqual([
      { id: 1, at: 100 },
      { id: 2, at: 200 },
    ]);
  });

  it('newer at wins per id', () => {
    const merged = mergeEntries(
      [{ id: 1, at: 100 }],
      [{ id: 1, at: 200 }],
    );
    expect(merged).toEqual([{ id: 1, at: 200 }]);
  });

  it('older at loses per id', () => {
    const merged = mergeEntries(
      [{ id: 1, at: 500 }],
      [{ id: 1, at: 100 }],
    );
    expect(merged).toEqual([{ id: 1, at: 500 }]);
  });

  it('ties keep the incumbent (idempotent repeat push)', () => {
    const current: SyncEntry[] = [{ id: 1, at: 100 }];
    const incoming: SyncEntry[] = [{ id: 1, at: 100 }];
    const merged = mergeEntries(current, incoming);
    expect(merged).toEqual([{ id: 1, at: 100 }]);
  });

  it('tombstone with newer at masks older additive', () => {
    const merged = mergeEntries(
      [{ id: 1, at: 100 }],
      [{ id: 1, at: 200, deleted: true }],
    );
    expect(merged).toEqual([{ id: 1, at: 200, deleted: true }]);
  });

  it('additive with newer at resurrects an older tombstone', () => {
    const merged = mergeEntries(
      [{ id: 1, at: 100, deleted: true }],
      [{ id: 1, at: 200 }],
    );
    expect(merged).toEqual([{ id: 1, at: 200 }]);
  });
});

describe('handleSyncRequest auth', () => {
  it('returns 401 without a cookie', async () => {
    const store = createTestStore();
    const res = await handleSyncRequest(request('GET', undefined, null), {
      store,
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 with a malformed session cookie', async () => {
    const store = createTestStore();
    const res = await handleSyncRequest(
      request('GET', undefined, UNAUTH_COOKIE),
      { store },
    );
    expect(res.status).toBe(401);
  });

  it('returns 405 for unsupported methods', async () => {
    const store = createTestStore();
    const res = await handleSyncRequest(request('PUT'), { store });
    expect(res.status).toBe(405);
  });

  it('returns 503 when the store is not configured', async () => {
    const res = await handleSyncRequest(request('GET'), { store: null });
    expect(res.status).toBe(503);
  });
});

describe('handleSyncRequest GET', () => {
  let store: ReturnType<typeof createTestStore>;
  beforeEach(() => {
    store = createTestStore();
  });

  it('returns empty lists for a new user', async () => {
    const res = await handleSyncRequest(request('GET'), { store });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pinned: [],
      favorite: [],
      hidden: [],
    });
  });

  it('returns the user’s stored state', async () => {
    store.map.set('alice', {
      pinned: [{ id: 1, at: 100 }],
      favorite: [{ id: 2, at: 200 }],
      hidden: [{ id: 3, at: 300 }],
    });
    const res = await handleSyncRequest(request('GET'), { store });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pinned: [{ id: 1, at: 100 }],
      favorite: [{ id: 2, at: 200 }],
      hidden: [{ id: 3, at: 300 }],
    });
  });

  it('isolates users', async () => {
    store.map.set('bob', {
      pinned: [{ id: 99, at: 9999 }],
      favorite: [],
      hidden: [],
    });
    const res = await handleSyncRequest(request('GET'), { store });
    const body = (await res.json()) as SyncState;
    expect(body.pinned).toEqual([]);

    const resBob = await handleSyncRequest(
      request('GET', undefined, OTHER_USER_COOKIE),
      { store },
    );
    const bobBody = (await resBob.json()) as SyncState;
    expect(bobBody.pinned).toEqual([{ id: 99, at: 9999 }]);
  });

  it('fails open with empty state when the store throws', async () => {
    store.failGet = true;
    const res = await handleSyncRequest(request('GET'), { store });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pinned: [],
      favorite: [],
      hidden: [],
    });
  });
});

describe('handleSyncRequest POST', () => {
  let store: ReturnType<typeof createTestStore>;
  beforeEach(() => {
    store = createTestStore();
  });

  it('round-trips a delta', async () => {
    const res = await handleSyncRequest(
      request('POST', {
        pinned: [{ id: 10, at: 1000 }],
        favorite: [{ id: 20, at: 2000 }],
        hidden: [{ id: 30, at: 3000 }],
      }),
      { store },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncState;
    expect(body).toEqual({
      pinned: [{ id: 10, at: 1000 }],
      favorite: [{ id: 20, at: 2000 }],
      hidden: [{ id: 30, at: 3000 }],
    });
    expect(store.map.get('alice')).toEqual(body);

    const getRes = await handleSyncRequest(request('GET'), { store });
    expect(await getRes.json()).toEqual(body);
  });

  it('merges a later delta on top of earlier state', async () => {
    store.map.set('alice', {
      pinned: [
        { id: 1, at: 100 },
        { id: 2, at: 200 },
      ],
      favorite: [],
      hidden: [],
    });
    const res = await handleSyncRequest(
      request('POST', {
        pinned: [{ id: 2, at: 250 }, { id: 3, at: 300 }],
      }),
      { store },
    );
    const body = (await res.json()) as SyncState;
    expect(body.pinned).toEqual([
      { id: 1, at: 100 },
      { id: 2, at: 250 },
      { id: 3, at: 300 },
    ]);
  });

  it('honours per-id last-write-wins across pushes', async () => {
    store.map.set('alice', {
      pinned: [{ id: 1, at: 500 }],
      favorite: [],
      hidden: [],
    });
    const res = await handleSyncRequest(
      request('POST', { pinned: [{ id: 1, at: 100 }] }),
      { store },
    );
    const body = (await res.json()) as SyncState;
    expect(body.pinned).toEqual([{ id: 1, at: 500 }]);
  });

  it('tombstones mask older additive entries', async () => {
    store.map.set('alice', {
      pinned: [{ id: 1, at: 100 }],
      favorite: [],
      hidden: [],
    });
    const res = await handleSyncRequest(
      request('POST', {
        pinned: [{ id: 1, at: 200, deleted: true }],
      }),
      { store },
    );
    const body = (await res.json()) as SyncState;
    expect(body.pinned).toEqual([{ id: 1, at: 200, deleted: true }]);
  });

  it('rejects entries with bogus shape while keeping valid ones', async () => {
    const res = await handleSyncRequest(
      request('POST', {
        pinned: [
          { id: 1, at: 100 },
          { id: -1, at: 100 }, // bad id
          { id: 2, at: 'soon' }, // bad at
          { id: 3, at: 300, deleted: 'yes' }, // bad deleted
          'garbage',
          { id: 4, at: 400 },
        ],
      }),
      { store },
    );
    const body = (await res.json()) as SyncState;
    expect(body.pinned).toEqual([
      { id: 1, at: 100 },
      { id: 4, at: 400 },
    ]);
  });

  it('returns 400 on non-JSON body', async () => {
    const req = new Request('https://newshacker.app/api/sync', {
      method: 'POST',
      headers: { cookie: COOKIE, 'content-type': 'application/json' },
      body: 'not json',
    });
    const res = await handleSyncRequest(req, { store });
    expect(res.status).toBe(400);
  });

  it('returns 400 when body is not an object', async () => {
    const res = await handleSyncRequest(request('POST', [1, 2, 3]), {
      store,
    });
    expect(res.status).toBe(400);
  });

  it('returns 413 when content-length exceeds the limit', async () => {
    const headers = new Headers({
      cookie: COOKIE,
      'content-type': 'application/json',
      'content-length': String(_internals.MAX_BODY_BYTES + 1),
    });
    const res = await handleSyncRequest(
      new Request('https://newshacker.app/api/sync', {
        method: 'POST',
        headers,
        body: JSON.stringify({ pinned: [] }),
      }),
      { store },
    );
    expect(res.status).toBe(413);
  });

  it('caps oversized lists to the most recent entries', async () => {
    const bigList: SyncEntry[] = [];
    for (let i = 1; i <= _internals.MAX_ENTRIES_PER_LIST + 5; i++) {
      bigList.push({ id: i, at: i });
    }
    const res = await handleSyncRequest(
      request('POST', { pinned: bigList }),
      { store },
    );
    const body = (await res.json()) as SyncState;
    expect(body.pinned).toHaveLength(_internals.MAX_ENTRIES_PER_LIST);
    // Most-recent-at kept: the 5 smallest `at` were dropped.
    expect(body.pinned[0].id).toBe(6);
  });

  it('returns 503 if the store fails on GET during POST', async () => {
    store.failGet = true;
    const res = await handleSyncRequest(
      request('POST', { pinned: [{ id: 1, at: 100 }] }),
      { store },
    );
    expect(res.status).toBe(503);
  });

  it('returns 503 if the store fails on SET', async () => {
    store.failSet = true;
    const res = await handleSyncRequest(
      request('POST', { pinned: [{ id: 1, at: 100 }] }),
      { store },
    );
    expect(res.status).toBe(503);
  });

  it('accepts an empty body (no-op push)', async () => {
    store.map.set('alice', {
      pinned: [{ id: 1, at: 100 }],
      favorite: [],
      hidden: [],
    });
    const res = await handleSyncRequest(request('POST', {}), { store });
    const body = (await res.json()) as SyncState;
    expect(body.pinned).toEqual([{ id: 1, at: 100 }]);
  });
});
