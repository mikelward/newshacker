import { useCallback } from 'react';
import { type ReadLaterPref, readLaterStore } from '../lib/readLater';
import { usePersistentValue } from './usePersistentValue';

/** The per-device read-later service setting (which service, if any, shows a
 *  "Save to …" entry in the thread overflow menu). Defaults to 'none'. */
export function useReadLaterService() {
  const readLaterService = usePersistentValue(readLaterStore);
  const setReadLaterService = useCallback(
    (service: ReadLaterPref) => readLaterStore.set(service),
    [],
  );
  return { readLaterService, setReadLaterService };
}
