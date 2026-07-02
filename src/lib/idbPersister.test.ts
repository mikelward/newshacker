import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  PERSIST_KEY,
  _resetIdbPersisterForTests,
  createAppPersister,
  idbPersistStorage,
} from './idbPersister';

// Each test gets a brand-new in-memory IndexedDB so state can't leak
// between cases, plus a reset of the module's cached open-DB promise.
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  _resetIdbPersisterForTests();
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  _resetIdbPersisterForTests();
  window.localStorage.clear();
});

describe('idbPersistStorage', () => {
  it('round-trips a value and removes it', async () => {
    expect(await idbPersistStorage.getItem(PERSIST_KEY)).toBeNull();

    await idbPersistStorage.setItem(PERSIST_KEY, '{"cache":1}');
    expect(await idbPersistStorage.getItem(PERSIST_KEY)).toBe('{"cache":1}');

    await idbPersistStorage.removeItem(PERSIST_KEY);
    expect(await idbPersistStorage.getItem(PERSIST_KEY)).toBeNull();
  });

  it('migrates the old localStorage blob into IndexedDB and deletes the key', async () => {
    window.localStorage.setItem(PERSIST_KEY, '{"legacy":true}');

    expect(await idbPersistStorage.getItem(PERSIST_KEY)).toBe(
      '{"legacy":true}',
    );
    // The ~5 MB localStorage budget is freed — the blob moved, not copied.
    expect(window.localStorage.getItem(PERSIST_KEY)).toBeNull();
  });

  it('prefers an existing IndexedDB value over a lingering localStorage blob', async () => {
    // A service-worker-cached old bundle in another tab can still write
    // the localStorage blob after this build has migrated. IDB is where
    // new snapshots land, so the localStorage copy is the stale one.
    await idbPersistStorage.setItem(PERSIST_KEY, '{"current":true}');
    _resetIdbPersisterForTests(); // next access re-runs the migration
    window.localStorage.setItem(PERSIST_KEY, '{"stale":true}');

    expect(await idbPersistStorage.getItem(PERSIST_KEY)).toBe(
      '{"current":true}',
    );
    expect(window.localStorage.getItem(PERSIST_KEY)).toBeNull();
  });

  it('falls back to localStorage when IndexedDB cannot open', async () => {
    // Regression (Codex review on #373): indexedDB can exist but refuse
    // to open (storage-blocked webviews, private-mode quirks) while
    // localStorage still works — those sessions previously degraded to
    // NO persistence instead of the pre-IndexedDB localStorage backend.
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('storage pressure');
      },
    });
    _resetIdbPersisterForTests();

    await idbPersistStorage.setItem(PERSIST_KEY, '{"fallback":true}');
    expect(window.localStorage.getItem(PERSIST_KEY)).toBe('{"fallback":true}');
    expect(await idbPersistStorage.getItem(PERSIST_KEY)).toBe(
      '{"fallback":true}',
    );
    await idbPersistStorage.removeItem(PERSIST_KEY);
    expect(window.localStorage.getItem(PERSIST_KEY)).toBeNull();
  });

  it('serves the localStorage blob (and keeps it) when IndexedDB cannot open', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('storage pressure');
      },
    });
    _resetIdbPersisterForTests();
    window.localStorage.setItem(PERSIST_KEY, '{"legacy":true}');

    // Persistence continues from localStorage; nothing was lost and the
    // next boot (with working IDB) still migrates.
    expect(await idbPersistStorage.getItem(PERSIST_KEY)).toBe(
      '{"legacy":true}',
    );
    expect(window.localStorage.getItem(PERSIST_KEY)).toBe('{"legacy":true}');
  });

  it('fails open (without switching backends) when a transaction fails after a successful open', async () => {
    // Tier 2: IDB opened fine but storage pressure breaks a transaction
    // mid-session. Writing that snapshot to localStorage instead would
    // leave a newer blob for the next boot's migration to discard — so
    // this degrades to a cache-less op, not a backend switch.
    const brokenDb = {
      objectStoreNames: { contains: () => true },
      transaction: () => {
        throw new Error('tx fail');
      },
    };
    vi.stubGlobal('indexedDB', {
      open: () => {
        const request = {} as {
          onsuccess?: () => void;
          result: typeof brokenDb;
        };
        request.result = brokenDb;
        setTimeout(() => request.onsuccess?.(), 0);
        return request;
      },
    });
    _resetIdbPersisterForTests();
    window.localStorage.setItem(PERSIST_KEY, '{"stale":true}');

    await expect(
      idbPersistStorage.setItem(PERSIST_KEY, '{"new":true}'),
    ).resolves.toBeUndefined();
    expect(await idbPersistStorage.getItem(PERSIST_KEY)).toBeNull();
    // localStorage untouched by either op.
    expect(window.localStorage.getItem(PERSIST_KEY)).toBe('{"stale":true}');
  });
});

describe('createAppPersister', () => {
  it('persists and restores a client snapshot through IndexedDB', async () => {
    const persister = createAppPersister();
    const snapshot = {
      buster: 'test',
      timestamp: 123,
      clientState: { mutations: [], queries: [] },
    };

    await persister.persistClient(snapshot);
    // The async persister throttles writes (1 s, trailing edge) — wait
    // for the stored value to land rather than assuming timing.
    await vi.waitFor(async () => {
      expect(await persister.restoreClient()).toEqual(snapshot);
    });

    await persister.removeClient();
    await vi.waitFor(async () => {
      expect(await persister.restoreClient()).toBeUndefined();
    });
  });

  it('falls back to the localStorage persister when IndexedDB is absent', async () => {
    vi.stubGlobal('indexedDB', undefined);
    _resetIdbPersisterForTests();
    const persister = createAppPersister();
    const snapshot = {
      buster: 'test',
      timestamp: 456,
      clientState: { mutations: [], queries: [] },
    };

    persister.persistClient(snapshot);
    // The sync persister throttles writes to one per second (trailing
    // edge), so the blob lands ~1 s after persistClient — give the
    // waitFor deadline room beyond that.
    await vi.waitFor(
      () => {
        expect(window.localStorage.getItem(PERSIST_KEY)).toContain(
          '"timestamp":456',
        );
      },
      { timeout: 3000 },
    );
  });
});
