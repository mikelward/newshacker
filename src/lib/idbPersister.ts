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

// Writes settle on the TRANSACTION, not the request: a put/delete
// request's `onsuccess` fires before the transaction commits, and the
// transaction can still abort afterward (quota, disk pressure). The
// migration deletes the localStorage blob only after idbSet resolves —
// resolving on request success could discard the legacy copy while the
// IDB copy never actually landed, losing both.
function idbWriteTx(
  db: IDBDatabase,
  run: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () =>
      reject(tx.error ?? new Error('IndexedDB transaction error'));
    run(tx.objectStore(STORE_NAME));
  });
}

function idbSet(db: IDBDatabase, key: string, value: string): Promise<void> {
  return idbWriteTx(db, (store) => {
    store.put(value, key);
  });
}

function idbRemove(db: IDBDatabase, key: string): Promise<void> {
  return idbWriteTx(db, (store) => {
    store.delete(key);
  });
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
        const value = window.localStorage.getItem(key);
        noteBlobRead(key, value);
        return value;
      } catch {
        return null;
      }
    }
    try {
      const value = await idbGet(db, key);
      noteBlobRead(key, value);
      return value;
    } catch {
      return null;
    }
  },
  setItem: async (key, value) => {
    const db = await dbOrNull();
    if (!db) {
      try {
        window.localStorage.setItem(key, value);
        // Counted only after the write lands — a quota or privacy-mode
        // failure below fails open, and counting it would make /debug
        // report snapshots on exactly the devices that persist nothing.
        noteBlobWrite(key, value);
      } catch {
        // quota/privacy failure — fail-open
      }
      return;
    }
    try {
      await idbSet(db, key, value);
      noteBlobWrite(key, value); // after the transaction commits, as above
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

// Boot/runtime cost telemetry for the persisted cache, surfaced on
// /debug. The persisted blob is a single JSON string holding the whole
// dehydrated query cache: restore must read + parse all of it before any
// query is allowed to paint or fetch (PersistQueryClientProvider holds
// `isRestoring` until then), and every throttled snapshot re-serializes
// all of it. Both costs scale with accumulated cache size, so "how big
// is the blob and how long did restore take on THIS device" is the
// question this answers — the sandbox can't see a long-lived reader's
// IndexedDB. Sizes and durations only; never cache contents (the blob
// holds query data, `['me']` included — AGENTS.md § Privacy).
export interface PersistCacheStats {
  // Duration of the restoreClient call: blob read + JSON.parse. (React
  // Query's hydrate pass into the cache happens after this, so the full
  // boot cost is a bit higher than reported.)
  restoreMs: number | null;
  // Size of the blob restore found, in UTF-16 code units (~bytes for
  // the ASCII-heavy JSON involved). null = no persisted blob existed.
  restoredChars: number | null;
  // Size of the most recent snapshot written this session.
  lastPersistChars: number | null;
  // Snapshot writes this session (throttled to 1/sec upstream, so this
  // also approximates seconds spent re-serializing the cache).
  persistCount: number;
}

const cacheStats: PersistCacheStats = {
  restoreMs: null,
  restoredChars: null,
  lastPersistChars: null,
  persistCount: 0,
};

export function getPersistCacheStats(): PersistCacheStats {
  return { ...cacheStats };
}

function noteBlobRead(key: string, value: string | null): void {
  if (key !== PERSIST_KEY || value === null) return;
  cacheStats.restoredChars = value.length;
}

function noteBlobWrite(key: string, value: string): void {
  if (key !== PERSIST_KEY) return;
  cacheStats.lastPersistChars = value.length;
  cacheStats.persistCount++;
}

// A restore that *threw* — a half-written or corrupt blob, a payload
// this build can't parse. Distinct from every failure above, which fail
// open to "no persisted cache" and are indistinguishable from a device
// that simply has none. React Query discards the blob and re-downloads
// either way, so the two look identical from the outside — except that
// one of them is a bug. It has to be captured here: React Query only
// `console.error`s the cause in dev builds, and
// `PersistQueryClientProvider`'s `onError` callback takes no arguments,
// so in a production boot this is the last point the error exists.
export interface PersistRestoreFailure {
  at: number;
  // The error's constructor NAME, never its message. V8 quotes a slice
  // of the offending input in `JSON.parse` messages, and the blob is
  // query data — the signed-in `['me']` record included (AGENTS.md
  // § Privacy). The name is what answers the actual question:
  // 'SyntaxError' means the payload is corrupt, a storage error means
  // the device is.
  error: string;
}

let lastRestoreFailure: PersistRestoreFailure | null = null;

// Recorded once per boot, first cause wins. The persister wrapper below
// calls it with the error; `main.tsx`'s `onError` calls it with nothing,
// which covers a throw from `hydrate` — past the wrapper, and the one
// path that would otherwise leave the gate released with no trace.
export function notePersistRestoreFailure(e?: unknown): void {
  if (lastRestoreFailure) return;
  const name = e instanceof Error ? e.name : undefined;
  lastRestoreFailure = { at: Date.now(), error: name || 'unknown' };
}

export function getPersistRestoreFailure(): PersistRestoreFailure | null {
  return lastRestoreFailure;
}

// Record a restore failure and re-throw it: React Query's own handler is
// what discards the bad blob and fires `onError`, which is what releases
// the pinned-offline-sync restore gate.
function reportingRestore(persister: Persister): Persister {
  return {
    ...persister,
    restoreClient: async () => {
      const started = performance.now();
      try {
        const restored = await persister.restoreClient();
        cacheStats.restoreMs = Math.round(performance.now() - started);
        return restored;
      } catch (e) {
        notePersistRestoreFailure(e);
        throw e;
      }
    },
  };
}

// throttleTime matches the previous sync persister: snapshots are
// coalesced to at most one per second so a burst of cache writes (a
// comment batch landing) serializes once.
export function createAppPersister(): Persister {
  if (typeof indexedDB === 'undefined') {
    // No IndexedDB at all (ancient engine, some webviews): keep the old
    // localStorage persister rather than losing persistence entirely.
    // Same key, same shape — a later boot with IDB available migrates.
    // localStorage is wrapped with the same read/write accounting as
    // idbPersistStorage — this branch is a real environment, and without
    // it /debug would report "no persisted cache" there while a blob
    // restores and snapshots land. Write counted only on success, as in
    // idbPersistStorage.setItem.
    const storage =
      typeof window !== 'undefined' ? window.localStorage : undefined;
    return reportingRestore(
      createSyncStoragePersister({
        storage: storage && {
          getItem: (key: string) => {
            const value = storage.getItem(key);
            noteBlobRead(key, value);
            return value;
          },
          setItem: (key: string, value: string) => {
            storage.setItem(key, value);
            noteBlobWrite(key, value);
          },
          removeItem: (key: string) => storage.removeItem(key),
        },
        key: PERSIST_KEY,
        throttleTime: 1000,
      }),
    );
  }
  return reportingRestore(
    createAsyncStoragePersister({
      storage: idbPersistStorage,
      key: PERSIST_KEY,
      throttleTime: 1000,
    }),
  );
}

export function _resetIdbPersisterForTests(): void {
  dbPromise = null;
  lastRestoreFailure = null;
  cacheStats.restoreMs = null;
  cacheStats.restoredChars = null;
  cacheStats.lastPersistChars = null;
  cacheStats.persistCount = 0;
}
