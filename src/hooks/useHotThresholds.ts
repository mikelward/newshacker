import { useCallback, useEffect, useState } from 'react';
import {
  HOT_THRESHOLDS_CHANGE_EVENT,
  HOT_THRESHOLDS_STORAGE_KEY,
  type HotThresholds,
  getStoredHotThresholds,
  setStoredHotThresholds,
} from '../lib/hotThresholds';

export function useHotThresholds() {
  const [prefs, setPrefs] = useState<HotThresholds>(() =>
    getStoredHotThresholds(),
  );

  useEffect(() => {
    const syncFromCustom = () => setPrefs(getStoredHotThresholds());
    // The browser fires `storage` for every key change in other tabs
    // (pinned/hidden/avatar/...), so filter on `event.key` to skip
    // unrelated writes. `event.key === null` is the "clear all"
    // signal — fall through to a re-read so a sign-out elsewhere
    // resets us. (Copilot review on PR #240.)
    const syncFromStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== HOT_THRESHOLDS_STORAGE_KEY) {
        return;
      }
      setPrefs(getStoredHotThresholds());
    };
    window.addEventListener(HOT_THRESHOLDS_CHANGE_EVENT, syncFromCustom);
    window.addEventListener('storage', syncFromStorage);
    return () => {
      window.removeEventListener(HOT_THRESHOLDS_CHANGE_EVENT, syncFromCustom);
      window.removeEventListener('storage', syncFromStorage);
    };
  }, []);

  const save = useCallback((next: HotThresholds) => {
    setStoredHotThresholds(next);
  }, []);

  return { prefs, save };
}
