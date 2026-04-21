import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetHnFavoritesSyncForTests,
  enqueueHnFavoriteAction,
  getHnFavoritesSyncDebug,
  mergeHnFavorites,
  startHnFavoritesSync,
  stopHnFavoritesSync,
} from './hnFavoritesSync';
import {
  getAllFavoriteEntries,
  replaceFavoriteEntries,
} from './favorites';
import { listQueue, MAX_ATTEMPTS } from './hnFavoriteQueue';

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  _resetHnFavoritesSyncForTests();
});

describe('mergeHnFavorites', () => {
  it('adds HN-only IDs with at: 0', () => {
    expect(mergeHnFavorites([], [10, 20])).toEqual([
      { id: 10, at: 0 },
      { id: 20, at: 0 },
    ]);
  });

  it('keeps existing live local entries unchanged', () => {
    const local = [{ id: 10, at: 1000 }];
    expect(mergeHnFavorites(local, [10])).toEqual([{ id: 10, at: 1000 }]);
  });

  it('preserves local tombstones (does not resurrect)', () => {
    const local = [{ id: 10, at: 5000, deleted: true as const }];
    expect(mergeHnFavorites(local, [10])).toEqual([
      { id: 10, at: 5000, deleted: true },
    ]);
  });

  it('keeps local-only entries even when HN has never heard of them', () => {
    const local = [{ id: 99, at: 1000 }];
    expect(mergeHnFavorites(local, [10, 20])).toEqual([
      { id: 10, at: 0 },
      { id: 20, at: 0 },
      { id: 99, at: 1000 },
    ]);
  });

  it('handles overlap + adds in a single pass', () => {
    const local: Parameters<typeof mergeHnFavorites>[0] = [
      { id: 1, at: 500 },
      { id: 2, at: 0, deleted: true },
    ];
    expect(mergeHnFavorites(local, [1, 2, 3])).toEqual([
      { id: 1, at: 500 },
      { id: 2, at: 0, deleted: true },
      { id: 3, at: 0 },
    ]);
  });
});

describe('startHnFavoritesSync bootstrap pull', () => {
  it('fetches /api/hn-favorites-list and merges IDs into local store', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ids: [10, 20], truncated: false }));

    await startHnFavoritesSync('alice', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith('/api/hn-favorites-list', {
      method: 'GET',
    });
    const stored = getAllFavoriteEntries();
    expect(stored).toEqual([
      { id: 10, at: 0 },
      { id: 20, at: 0 },
    ]);
    const debug = getHnFavoritesSyncDebug();
    expect(debug.running).toBe(true);
    expect(debug.bootstrapped).toBe(true);
    expect(debug.lastBootstrap?.ok).toBe(true);
    expect(debug.lastBootstrap?.idsAdded).toBe(2);
  });

  it('preserves local tombstones when HN still has the ID', async () => {
    replaceFavoriteEntries([{ id: 42, at: 5000, deleted: true }]);

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ids: [42] }));

    await startHnFavoritesSync('alice', { fetchImpl });

    expect(getAllFavoriteEntries()).toEqual([
      { id: 42, at: 5000, deleted: true },
    ]);
  });

  it('does not rewrite storage when nothing would change', async () => {
    replaceFavoriteEntries([{ id: 1, at: 100 }]);
    const spy = vi.spyOn(Storage.prototype, 'setItem');
    // clear calls from the replaceFavoriteEntries above
    spy.mockClear();

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ids: [1] }));

    await startHnFavoritesSync('alice', { fetchImpl });

    // Merge is a no-op, so replaceFavoriteEntries should not run.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('is fail-open on 401', async () => {
    replaceFavoriteEntries([{ id: 1, at: 100 }]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 401 }));

    await startHnFavoritesSync('alice', { fetchImpl });

    expect(getAllFavoriteEntries()).toEqual([{ id: 1, at: 100 }]);
    const debug = getHnFavoritesSyncDebug();
    expect(debug.lastBootstrap?.ok).toBe(false);
    expect(debug.lastBootstrap?.status).toBe(401);
    expect(debug.bootstrapped).toBe(false);
  });

  it('is fail-open on network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));

    await startHnFavoritesSync('alice', { fetchImpl });

    const debug = getHnFavoritesSyncDebug();
    expect(debug.lastBootstrap?.ok).toBe(false);
    expect(debug.lastBootstrap?.error).toBe('offline');
  });

  it('skips the bootstrap when the same username is already running', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ids: [1] }));

    await startHnFavoritesSync('alice', { fetchImpl });
    await startHnFavoritesSync('alice', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('re-bootstraps when the username changes', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ids: [1] }))
      .mockResolvedValueOnce(jsonResponse({ ids: [2] }));

    await startHnFavoritesSync('alice', { fetchImpl });
    await startHnFavoritesSync('bob', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(getAllFavoriteEntries()).toEqual([
      { id: 1, at: 0 },
      { id: 2, at: 0 },
    ]);
  });

  it('stopHnFavoritesSync clears the running runtime', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ids: [] }));

    await startHnFavoritesSync('alice', { fetchImpl });
    expect(getHnFavoritesSyncDebug().running).toBe(true);

    stopHnFavoritesSync();
    expect(getHnFavoritesSyncDebug().running).toBe(false);
    // lastBootstrap survives stop so the debug panel can still show it.
    expect(getHnFavoritesSyncDebug().lastBootstrap).not.toBeNull();
  });
});

// Build a mock fetch that answers /api/hn-favorites-list with an
// empty list (so bootstrap is a no-op) and routes /api/hn-favorite
// to a per-test handler.
function workerFetchStub(
  onFavorite: (body: { id: number; action: string }) => Response,
): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    if (url === '/api/hn-favorites-list') {
      return jsonResponse({ ids: [] });
    }
    if (url === '/api/hn-favorite') {
      const body = JSON.parse(((init as RequestInit).body as string) ?? '{}');
      return onFavorite(body);
    }
    throw new Error(`unexpected url: ${url}`);
  }) as typeof fetch;
}

describe('worker — drains the queue via /api/hn-favorite', () => {
  it('204 success drops the entry', async () => {
    const onFavorite = vi
      .fn()
      .mockReturnValue(new Response(null, { status: 204 }));
    const fetchImpl = workerFetchStub(onFavorite);

    await startHnFavoritesSync('alice', { fetchImpl });
    enqueueHnFavoriteAction('alice', 'favorite', 42);
    await flushMicrotasks();

    expect(onFavorite).toHaveBeenCalledWith({ id: 42, action: 'favorite' });
    expect(listQueue('alice')).toEqual([]);
    expect(getHnFavoritesSyncDebug().lastWorkerAttempt?.ok).toBe(true);
  });

  it('5xx failure keeps the entry with markFailure', async () => {
    const onFavorite = vi
      .fn()
      .mockReturnValue(new Response('err', { status: 502 }));
    const fetchImpl = workerFetchStub(onFavorite);

    await startHnFavoritesSync('alice', { fetchImpl });
    enqueueHnFavoriteAction('alice', 'favorite', 42);
    await flushMicrotasks();

    const queue = listQueue('alice');
    expect(queue).toHaveLength(1);
    expect(queue[0].attempts).toBe(1);
    expect(queue[0].nextAttemptAt).toBeGreaterThan(Date.now());
    expect(getHnFavoritesSyncDebug().lastWorkerAttempt?.ok).toBe(false);
    expect(getHnFavoritesSyncDebug().lastWorkerAttempt?.status).toBe(502);
  });

  it('401 stops the worker (session died upstream)', async () => {
    const onFavorite = vi
      .fn()
      .mockReturnValue(new Response('nope', { status: 401 }));
    const fetchImpl = workerFetchStub(onFavorite);

    await startHnFavoritesSync('alice', { fetchImpl });
    enqueueHnFavoriteAction('alice', 'favorite', 1);
    enqueueHnFavoriteAction('alice', 'favorite', 2);
    await flushMicrotasks();

    // Only the first entry is tried — the 401 stalls the worker.
    expect(onFavorite).toHaveBeenCalledTimes(1);
    expect(getHnFavoritesSyncDebug().stalledOnAuth).toBe(true);
    // Both entries are still queued (entry 1 has markFailure on auth,
    // entry 2 never got picked up).
    expect(listQueue('alice').length).toBeGreaterThan(0);
  });

  it('400 drops the entry (permanent)', async () => {
    const onFavorite = vi
      .fn()
      .mockReturnValue(new Response('bad', { status: 400 }));
    const fetchImpl = workerFetchStub(onFavorite);

    await startHnFavoritesSync('alice', { fetchImpl });
    enqueueHnFavoriteAction('alice', 'favorite', 42);
    await flushMicrotasks();

    expect(listQueue('alice')).toEqual([]);
  });

  it('network error leaves the entry for retry', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/hn-favorites-list')
        return jsonResponse({ ids: [] });
      throw new Error('offline');
    }) as typeof fetch;

    await startHnFavoritesSync('alice', { fetchImpl });
    enqueueHnFavoriteAction('alice', 'favorite', 42);
    await flushMicrotasks();

    const queue = listQueue('alice');
    expect(queue).toHaveLength(1);
    expect(queue[0].lastError).toBe('offline');
  });

  it('drains multiple queued entries serially', async () => {
    const seen: number[] = [];
    const onFavorite = vi.fn((body: { id: number }) => {
      seen.push(body.id);
      return new Response(null, { status: 204 });
    });
    const fetchImpl = workerFetchStub(onFavorite);

    await startHnFavoritesSync('alice', { fetchImpl });
    enqueueHnFavoriteAction('alice', 'favorite', 1);
    enqueueHnFavoriteAction('alice', 'favorite', 2);
    enqueueHnFavoriteAction('alice', 'favorite', 3);
    await flushMicrotasks();

    expect(seen).toEqual([1, 2, 3]);
    expect(listQueue('alice')).toEqual([]);
  });

  it('enqueue for a different user does not wake this worker', async () => {
    const onFavorite = vi.fn();
    const fetchImpl = workerFetchStub(onFavorite);

    await startHnFavoritesSync('alice', { fetchImpl });
    enqueueHnFavoriteAction('bob', 'favorite', 42);
    await flushMicrotasks();

    expect(onFavorite).not.toHaveBeenCalled();
    expect(listQueue('bob')).toHaveLength(1);
  });

  it('drops an entry that has exhausted MAX_ATTEMPTS', async () => {
    // Seed the queue at attempts = MAX_ATTEMPTS - 1 so the first
    // failure in-test hits the drop branch.
    const key = 'newshacker:hnFavoriteQueue:alice';
    window.localStorage.setItem(
      key,
      JSON.stringify([
        {
          id: 42,
          action: 'favorite',
          at: 0,
          attempts: MAX_ATTEMPTS - 1,
          nextAttemptAt: 0,
        },
      ]),
    );
    const fetchImpl = workerFetchStub(() => new Response('', { status: 502 }));

    await startHnFavoritesSync('alice', { fetchImpl });
    await flushMicrotasks();

    expect(listQueue('alice')).toEqual([]);
  });
});
