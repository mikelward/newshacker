import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import type { Persister } from '@tanstack/react-query-persist-client';

// Structural match for @tanstack/query-persist-client-core's
// `AsyncStorage<string>` — that type isn't re-exported by the
// async-storage-persister package, and importing the core package
// directly would depend on npm hoisting a transitive dependency.
interface PersistAsyncStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
}

// The React Query persister blob lives in IndexedDB, not localStorage.
// localStorage's ~5 MB origin quota was the binding constraint on how
// much pinned content could survive offline (see the retention notes in
// useSummary.ts), and its synchronous writes serialize the whole cache
// on the main thread on every throttled snapshot. IndexedDB's quota is
// browser-managed and orders of magnitude larger, and the writes are
// async. The key inside the store keeps the old localStorage name so
// the persisted shape is identical either side of the migration.
export const PERSIST_KEY = 'newshacker:rq-cache';
const DB_NAME = 'newshacker';
const STORE_NAME = 'rq-persist';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<string | null> {
  const store = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME);
  return requestToPromise(store.get(key)).then((value) =>
    typeof value === 'string' ? value : null,
  );
}

function idbSet(db: IDBDatabase, key: string, value: string): Promise<void> {
  const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
  return requestToPromise(store.put(value, key)).then(() => undefined);
}

function idbRemove(db: IDBDatabase, key: string): Promise<void> {
  const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
  return requestToPromise(store.delete(key)).then(() => undefined);
}

// One-shot move of the pre-IndexedDB persister blob out of localStorage.
// IDB wins when both exist: once this build has booted, IDB is where new
// snapshots land, so a lingering localStorage blob (a service-worker-
// cached old bundle running in another tab still writes there) is the
// stale copy. The localStorage key is removed either way — that ~5 MB
// budget is the reason for the move. Fail-open: an old client that
// boots later just starts with an empty persisted cache and refetches,
// which is safe for what is only ever a cache (the pin/favorite lists
// themselves live under their own localStorage keys, untouched here).
async function migrateFromLocalStorage(db: IDBDatabase): Promise<void> {
  let legacy: string | null;
  try {
    legacy = window.localStorage.getItem(PERSIST_KEY);
  } catch {
    return; // privacy-mode localStorage access failure — nothing to move
  }
  if (legacy === null) return;
  try {
    const existing = await idbGet(db, PERSIST_KEY);
    if (existing === null) {
      await idbSet(db, PERSIST_KEY, legacy);
    }
  } catch {
    // Couldn't read/write IDB — leave the localStorage blob in place so
    // nothing is lost; the next boot retries the migration.
    return;
  }
  try {
    window.localStorage.removeItem(PERSIST_KEY);
  } catch {
    // non-fatal: the copy in IDB is already authoritative
  }
}

function ensureDb(): Promise<IDBDatabase> {
  dbPromise ??= openDb().then(async (db) => {
    await migrateFromLocalStorage(db);
    return db;
  });
  return dbPromise;
}

// null ⇔ IndexedDB can't open in this session (storage-blocked webview,
// private-mode quirk, corrupt database). ensureDb caches the rejected
// promise, so once the open has failed every operation lands here —
// the session degrades to ONE backend, never a mix.
async function dbOrNull(): Promise<IDBDatabase | null> {
  try {
    return await ensureDb();
  } catch {
    return null;
  }
}

// The persisted cache is an optimization, never a correctness boundary,
// so nothing here may throw. Two degradation tiers:
//
//   1. IndexedDB won't OPEN (indexedDB exists but the environment
//      blocks it — where localStorage often still works): fall back to
//      localStorage under the same key, preserving the pre-IndexedDB
//      persistence instead of silently losing it. The failed open is
//      cached, so the whole session stays on localStorage — backends
//      never mix within a session.
//   2. IndexedDB opened but an individual transaction fails (storage
//      pressure mid-session): fail open (getItem → null, writes →
//      no-op) rather than writing that one snapshot to a different
//      backend, which would leave a newer localStorage blob for the
//      migration to discard on the next boot.
export const idbPersistStorage: PersistAsyncStorage = {
  getItem: async (key) => {
    const db = await dbOrNull();
    if (!db) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    }
    try {
      return await idbGet(db, key);
    } catch {
      return null;
    }
  },
  setItem: async (key, value) => {
    const db = await dbOrNull();
    if (!db) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // quota/privacy failure — fail-open
      }
      return;
    }
    try {
      await idbSet(db, key, value);
    } catch {
      // fail-open
    }
  },
  removeItem: async (key) => {
    const db = await dbOrNull();
    if (!db) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // fail-open
      }
      return;
    }
    try {
      await idbRemove(db, key);
    } catch {
      // fail-open
    }
  },
};

// throttleTime matches the previous sync persister: snapshots are
// coalesced to at most one per second so a burst of cache writes (a
// comment batch landing) serializes once.
export function createAppPersister(): Persister {
  if (typeof indexedDB === 'undefined') {
    // No IndexedDB at all (ancient engine, some webviews): keep the old
    // localStorage persister rather than losing persistence entirely.
    // Same key, same shape — a later boot with IDB available migrates.
    return createSyncStoragePersister({
      storage: typeof window !== 'undefined' ? window.localStorage : undefined,
      key: PERSIST_KEY,
      throttleTime: 1000,
    });
  }
  return createAsyncStoragePersister({
    storage: idbPersistStorage,
    key: PERSIST_KEY,
    throttleTime: 1000,
  });
}

export function _resetIdbPersisterForTests(): void {
  dbPromise = null;
}
