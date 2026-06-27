import { useSyncExternalStore } from 'react';
import type { PersistentValue } from '../lib/persistentValue';

// Read a createPersistentValue store reactively: re-renders on the store's
// same-tab change event and on cross-tab `storage` writes, and is SSR-safe
// (getServerSnapshot returns the store's default). The value is a primitive
// (string enum), so the Object.is snapshot comparison is stable — no extra memo.
export function usePersistentValue<T>(store: PersistentValue<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
