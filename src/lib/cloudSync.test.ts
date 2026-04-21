import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCloudSyncDebug,
  mergeEntries,
  pullNow,
  pushNow,
  startCloudSync,
  stopCloudSync,
  subscribeCloudSyncDebug,
  _flushCloudSyncForTests,
  _getCloudSyncRuntimeForTests,
  _resetCloudSyncDebugForTests,
  type SyncState,
} from './cloudSync';
import {
  addPinnedId,
  getAllPinnedEntries,
  getPinnedIds,
  removePinnedId,
} from './pinnedStories';
import { addFavoriteId, getAllFavoriteEntries } from './favorites';
import {
  addDismissedId,
  getAllDismissedEntries,
} from './dismissedStories';

const NOW = Date.now();
const T = {
  T0: NOW - 5000,
  T1: NOW - 4000,
  T2: NOW - 3000,
  T3: NOW - 2000,
  T4: NOW - 1000,
  T5: NOW,
};

function emptyState(): SyncState {
  return { pinned: [], favorite: [], ignored: [] };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function queuedFetch(
  queue: Array<{
    matcher?: (input: RequestInfo | URL, init?: RequestInit) => boolean;
    response: Response | ((init: RequestInit | undefined) => Response);
  }>,
): FetchMock {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected fetch: ${String(input)}`);
    if (next.matcher && !next.matcher(input, init)) {
      throw new Error(
        `Fetch matcher failed for ${String(input)} ${init?.method ?? 'GET'}`,
      );
    }
    return typeof next.response === 'function'
      ? next.response(init)
      : next.response;
  }) as FetchMock;
  return fetchMock;
}

// With debounceMs=0 and real timers, a setTimeout(0) + a few microtasks
// are enough to drain any push/pull chain. Call twice on round-trips
// that trigger a follow-up push inside runPush's finally block.
async function drain(): Promise<void> {
  await _flushCloudSyncForTests();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await _flushCloudSyncForTests();
}

describe('mergeEntries (client)', () => {
  it('keeps newer `at` per id', () => {
    const merged = mergeEntries(
      [{ id: 1, at: 100 }],
      [{ id: 1, at: 200 }],
    );
    expect(merged).toEqual([{ id: 1, at: 200 }]);
  });

  it('tombstone with newer at beats older additive', () => {
    const merged = mergeEntries(
      [{ id: 1, at: 100 }],
      [{ id: 1, at: 200, deleted: true }],
    );
    expect(merged).toEqual([{ id: 1, at: 200, deleted: true }]);
  });

  it('sorts by id for deterministic writes', () => {
    const merged = mergeEntries(
      [{ id: 3, at: 300 }],
      [
        { id: 1, at: 100 },
        { id: 2, at: 200 },
      ],
    );
    expect(merged.map((e) => e.id)).toEqual([1, 2, 3]);
  });
});

describe('cloudSync lifecycle', () => {
  beforeEach(() => {
    window.localStorage.clear();
    stopCloudSync();
  });
  afterEach(() => {
    stopCloudSync();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('pulls server state on start and merges into local stores', async () => {
    // Local has a pin the server doesn't know about at a newer time.
    addPinnedId(1, T.T5);
    // Server has a different pin (id 2) and a stale tombstone for id 1.
    const server: SyncState = {
      pinned: [
        { id: 2, at: T.T3 },
        { id: 1, at: T.T1, deleted: true },
      ],
      favorite: [],
      ignored: [],
    };
    const fetchMock = queuedFetch([
      {
        matcher: (input, init) =>
          String(input) === '/api/sync' && (init?.method ?? 'GET') === 'GET',
        response: jsonResponse(server),
      },
      // Initial post-pull flush will include id=1 (local wins LWW) → POST.
      {
        response: (init) => {
          const body = JSON.parse(init?.body as string) as SyncState;
          return jsonResponse(body);
        },
      },
    ]);

    await startCloudSync('alice', { fetchImpl: fetchMock, debounceMs: 0 });
    await drain();

    expect(getPinnedIds()).toEqual(new Set([1, 2]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('local add triggers a debounced POST with the delta', async () => {
    const fetchMock = queuedFetch([
      { response: jsonResponse(emptyState()) }, // initial GET
      {
        matcher: (input, init) =>
          String(input) === '/api/sync' && init?.method === 'POST',
        response: (init) => {
          const body = JSON.parse(init?.body as string) as SyncState;
          return jsonResponse(body);
        },
      },
    ]);

    await startCloudSync('alice', { fetchImpl: fetchMock, debounceMs: 0 });
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(1); // GET only — no local deltas

    addPinnedId(42, T.T5);
    await drain();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const postInit = fetchMock.mock.calls[1][1] as RequestInit;
    const body = JSON.parse(postInit.body as string) as SyncState;
    expect(body.pinned).toEqual([{ id: 42, at: T.T5 }]);
    expect(body.favorite).toEqual([]);
    expect(body.ignored).toEqual([]);
  });

  it('coalesces rapid-fire changes into a single POST', async () => {
    const fetchMock = queuedFetch([
      { response: jsonResponse(emptyState()) },
      {
        response: (init) => {
          const body = JSON.parse(init?.body as string) as SyncState;
          return jsonResponse(body);
        },
      },
    ]);

    await startCloudSync('alice', { fetchImpl: fetchMock, debounceMs: 50 });
    await drain();

    addPinnedId(1, T.T3);
    addFavoriteId(2, T.T4);
    addDismissedId(3, T.T5);

    // Wait for the debounce to fire.
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    await drain();

    expect(fetchMock).toHaveBeenCalledTimes(2); // GET + one POST
    const body = JSON.parse(
      (fetchMock.mock.calls[1][1] as RequestInit).body as string,
    ) as SyncState;
    expect(body.pinned).toEqual([{ id: 1, at: T.T3 }]);
    expect(body.favorite).toEqual([{ id: 2, at: T.T4 }]);
    expect(body.ignored).toEqual([{ id: 3, at: T.T5 }]);
  });

  it('pushes tombstones for removes', async () => {
    addPinnedId(1, T.T1);
    const fetchMock = queuedFetch([
      { response: jsonResponse(emptyState()) }, // GET
      {
        response: (init) => {
          const body = JSON.parse(init?.body as string) as SyncState;
          return jsonResponse(body);
        },
      }, // POST #1: flush initial pin
      {
        response: (init) => {
          const body = JSON.parse(init?.body as string) as SyncState;
          return jsonResponse(body);
        },
      }, // POST #2: flush tombstone
    ]);

    await startCloudSync('alice', { fetchImpl: fetchMock, debounceMs: 0 });
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(2); // GET + initial flush POST

    removePinnedId(1, T.T5);
    await drain();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const body = JSON.parse(
      (fetchMock.mock.calls[2][1] as RequestInit).body as string,
    ) as SyncState;
    expect(body.pinned).toEqual([{ id: 1, at: T.T5, deleted: true }]);
  });

  it('does not re-push entries the server already has', async () => {
    const server: SyncState = {
      pinned: [{ id: 1, at: T.T3 }],
      favorite: [],
      ignored: [],
    };
    // Only a GET is queued. If an unexpected POST fires, the mock throws.
    const fetchMock = queuedFetch([{ response: jsonResponse(server) }]);

    await startCloudSync('alice', { fetchImpl: fetchMock, debounceMs: 0 });
    await drain();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getPinnedIds()).toEqual(new Set([1]));
  });

  it('survives a failed POST — next change retries', async () => {
    const fetchMock = queuedFetch([
      { response: jsonResponse(emptyState()) }, // GET
      { response: jsonResponse({ error: 'nope' }, 503) }, // failed POST
      {
        response: (init) => {
          const body = JSON.parse(init?.body as string) as SyncState;
          return jsonResponse(body);
        },
      }, // retry POST
    ]);

    await startCloudSync('alice', { fetchImpl: fetchMock, debounceMs: 0 });
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(1); // GET only

    addPinnedId(1, T.T3);
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(2); // GET + failed POST

    // High-water mark must NOT have advanced — the second change must
    // re-include the pending delta so the previous unsuccessful push
    // isn't silently lost.
    addPinnedId(2, T.T4);
    await drain();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const body = JSON.parse(
      (fetchMock.mock.calls[2][1] as RequestInit).body as string,
    ) as SyncState;
    const ids = body.pinned.map((e) => e.id).sort();
    expect(ids).toEqual([1, 2]);
  });

  it('stop() unbinds event listeners', async () => {
    const fetchMock = queuedFetch([
      { response: jsonResponse(emptyState()) },
    ]);
    await startCloudSync('alice', { fetchImpl: fetchMock, debounceMs: 0 });
    await drain();

    stopCloudSync();
    addPinnedId(99, T.T5);
    await drain();

    expect(fetchMock).toHaveBeenCalledTimes(1); // no POST after stop
    expect(_getCloudSyncRuntimeForTests()).toBeNull();
  });

  it('does not mutate local state when the pull fails', async () => {
    addPinnedId(1, T.T3);
    const fetchMock = queuedFetch([
      { response: jsonResponse({ error: 'boom' }, 500) },
      // Initial flush POST after the failed pull.
      {
        response: (init) => {
          const body = JSON.parse(init?.body as string) as SyncState;
          return jsonResponse(body);
        },
      },
    ]);
    await startCloudSync('alice', { fetchImpl: fetchMock, debounceMs: 0 });
    await drain();

    expect(getPinnedIds()).toEqual(new Set([1]));
  });

  it('merges server tombstones into local on pull', async () => {
    addPinnedId(5, T.T1);
    const server: SyncState = {
      pinned: [{ id: 5, at: T.T4, deleted: true }],
      favorite: [],
      ignored: [],
    };
    const fetchMock = queuedFetch([{ response: jsonResponse(server) }]);
    await startCloudSync('alice', { fetchImpl: fetchMock, debounceMs: 0 });
    await drain();

    expect(getPinnedIds()).toEqual(new Set());
    expect(getAllPinnedEntries()).toEqual([
      { id: 5, at: T.T4, deleted: true },
    ]);
  });

  it('propagates all three lists through a round-trip', async () => {
    addPinnedId(1, T.T3);
    addFavoriteId(2, T.T4);
    addDismissedId(3, T.T5);
    const fetchMock = queuedFetch([
      { response: jsonResponse(emptyState()) },
      {
        response: (init) => {
          const body = JSON.parse(init?.body as string) as SyncState;
          return jsonResponse(body);
        },
      },
    ]);

    await startCloudSync('alice', { fetchImpl: fetchMock, debounceMs: 0 });
    await drain();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse(
      (fetchMock.mock.calls[1][1] as RequestInit).body as string,
    ) as SyncState;
    expect(body.pinned).toEqual([{ id: 1, at: T.T3 }]);
    expect(body.favorite).toEqual([{ id: 2, at: T.T4 }]);
    expect(body.ignored).toEqual([{ id: 3, at: T.T5 }]);

    // Local state still intact after the round-trip.
    expect(getAllPinnedEntries().map((e) => e.id)).toEqual([1]);
    expect(getAllFavoriteEntries().map((e) => e.id)).toEqual([2]);
    expect(getAllDismissedEntries().map((e) => e.id)).toEqual([3]);
  });
});

describe('cloudSync debug API', () => {
  beforeEach(() => {
    window.localStorage.clear();
    stopCloudSync();
    _resetCloudSyncDebugForTests();
  });
  afterEach(() => {
    stopCloudSync();
    _resetCloudSyncDebugForTests();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('reports not-running when sync is stopped', () => {
    const snap = getCloudSyncDebug();
    expect(snap.running).toBe(false);
    expect(snap.username).toBeNull();
    expect(snap.lastPull).toBeNull();
    expect(snap.lastPush).toBeNull();
  });

  it('records lastPull and lastPush with counts after a round-trip', async () => {
    addPinnedId(1, T.T4);
    const fetchMock = queuedFetch([
      {
        response: jsonResponse({
          pinned: [{ id: 99, at: T.T1 }],
          favorite: [],
          ignored: [],
        }),
      }, // GET
      {
        response: (init) => {
          const body = JSON.parse(init?.body as string) as SyncState;
          return jsonResponse(body);
        },
      }, // POST
    ]);

    await startCloudSync('alice', { fetchImpl: fetchMock, debounceMs: 0 });
    await drain();

    const snap = getCloudSyncDebug();
    expect(snap.running).toBe(true);
    expect(snap.username).toBe('alice');
    expect(snap.lastPull?.ok).toBe(true);
    expect(snap.lastPull?.counts).toEqual({
      pinned: 1,
      favorite: 0,
      ignored: 0,
    });
    expect(snap.lastPush?.ok).toBe(true);
    expect(snap.lastPush?.counts).toEqual({
      pinned: 1,
      favorite: 0,
      ignored: 0,
    });
    // High-water is advanced, so pending is empty.
    expect(snap.pendingCount).toEqual({
      pinned: 0,
      favorite: 0,
      ignored: 0,
    });
  });

  it('records lastPull.error when the server returns 500', async () => {
    const fetchMock = queuedFetch([
      { response: jsonResponse({ error: 'boom' }, 500) },
    ]);
    await startCloudSync('alice', { fetchImpl: fetchMock, debounceMs: 0 });
    await drain();
    const snap = getCloudSyncDebug();
    expect(snap.lastPull?.ok).toBe(false);
    expect(snap.lastPull?.status).toBe(500);
  });

  it('records lastPush.error when the POST fails', async () => {
    addPinnedId(1, T.T4);
    const fetchMock = queuedFetch([
      { response: jsonResponse({ pinned: [], favorite: [], ignored: [] }) },
      { response: jsonResponse({ error: 'nope' }, 503) },
    ]);
    await startCloudSync('alice', { fetchImpl: fetchMock, debounceMs: 0 });
    await drain();
    const snap = getCloudSyncDebug();
    expect(snap.lastPush?.ok).toBe(false);
    expect(snap.lastPush?.status).toBe(503);
    expect(snap.lastPush?.counts).toEqual({
      pinned: 1,
      favorite: 0,
      ignored: 0,
    });
    // Pending count reflects the still-unpushed entry.
    expect(snap.pendingCount.pinned).toBe(1);
  });

  it('subscribeCloudSyncDebug fires on pull/push transitions', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCloudSyncDebug(listener);
    try {
      const fetchMock = queuedFetch([
        { response: jsonResponse({ pinned: [], favorite: [], ignored: [] }) },
      ]);
      await startCloudSync('alice', { fetchImpl: fetchMock, debounceMs: 0 });
      await drain();
      expect(listener.mock.calls.length).toBeGreaterThan(0);
    } finally {
      unsubscribe();
    }
  });

  it('pullNow forces a GET without waiting for debounce', async () => {
    const fetchMock = queuedFetch([
      { response: jsonResponse({ pinned: [], favorite: [], ignored: [] }) }, // initial start pull
      {
        response: jsonResponse({
          pinned: [{ id: 42, at: T.T4 }],
          favorite: [],
          ignored: [],
        }),
      }, // manual pullNow
    ]);
    await startCloudSync('alice', { fetchImpl: fetchMock, debounceMs: 0 });
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await pullNow();
    await drain();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getPinnedIds()).toEqual(new Set([42]));
  });

  it('pullNow is a no-op when sync is stopped', async () => {
    await pullNow(); // should not throw
    const snap = getCloudSyncDebug();
    expect(snap.running).toBe(false);
  });

  it('pushNow flushes pending deltas immediately, bypassing debounce', async () => {
    const fetchMock = queuedFetch([
      { response: jsonResponse({ pinned: [], favorite: [], ignored: [] }) }, // initial GET
      {
        response: (init) => {
          const body = JSON.parse(init?.body as string) as SyncState;
          return jsonResponse(body);
        },
      },
    ]);
    await startCloudSync('alice', { fetchImpl: fetchMock, debounceMs: 10_000 });
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    addPinnedId(1, T.T5);
    // No drain yet — the 10s debounce hasn't fired.
    await pushNow();
    await drain();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse(
      (fetchMock.mock.calls[1][1] as RequestInit).body as string,
    ) as SyncState;
    expect(body.pinned).toEqual([{ id: 1, at: T.T5 }]);
  });
});

describe('visibility-change pull', () => {
  beforeEach(() => {
    window.localStorage.clear();
    stopCloudSync();
    _resetCloudSyncDebugForTests();
  });
  afterEach(() => {
    stopCloudSync();
    _resetCloudSyncDebugForTests();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  function setVisibility(state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => state,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  it('fires a pull when the tab becomes visible again', async () => {
    const fetchMock = queuedFetch([
      { response: jsonResponse({ pinned: [], favorite: [], ignored: [] }) }, // initial
      {
        response: jsonResponse({
          pinned: [{ id: 77, at: T.T4 }],
          favorite: [],
          ignored: [],
        }),
      }, // after visibility
    ]);
    await startCloudSync('alice', { fetchImpl: fetchMock, debounceMs: 0 });
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Tab goes hidden, then visible again — but the gate requires 30s
    // to have passed since the last pull. Force-rewind the gate.
    const runtime = _getCloudSyncRuntimeForTests();
    if (runtime) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (runtime as any).lastPullAttemptAt = 0;
    }
    setVisibility('hidden');
    setVisibility('visible');
    await drain();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getPinnedIds()).toEqual(new Set([77]));
  });

  it('does not fire a pull when transitioning to hidden', async () => {
    const fetchMock = queuedFetch([
      { response: jsonResponse({ pinned: [], favorite: [], ignored: [] }) },
    ]);
    await startCloudSync('alice', { fetchImpl: fetchMock, debounceMs: 0 });
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gate: two quick visibility→visible transitions only trigger one pull', async () => {
    const fetchMock = queuedFetch([
      { response: jsonResponse({ pinned: [], favorite: [], ignored: [] }) }, // initial
      { response: jsonResponse({ pinned: [], favorite: [], ignored: [] }) }, // first visibility pull
    ]);
    await startCloudSync('alice', { fetchImpl: fetchMock, debounceMs: 0 });
    await drain();

    const runtime = _getCloudSyncRuntimeForTests();
    if (runtime) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (runtime as any).lastPullAttemptAt = 0;
    }
    setVisibility('visible');
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Second transition within the gate window — should NOT pull.
    // (lastPullAttemptAt has been reset to now by the previous pull.)
    setVisibility('hidden');
    setVisibility('visible');
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
