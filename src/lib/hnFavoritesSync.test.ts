import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetHnFavoritesSyncForTests,
  getHnFavoritesSyncDebug,
  mergeHnFavorites,
  startHnFavoritesSync,
  stopHnFavoritesSync,
} from './hnFavoritesSync';
import {
  getAllFavoriteEntries,
  replaceFavoriteEntries,
} from './favorites';

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
