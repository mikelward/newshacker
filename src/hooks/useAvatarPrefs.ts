import { useCallback, useEffect, useState } from 'react';
import {
  AVATAR_PREFS_CHANGE_EVENT,
  type AvatarPrefs,
  getStoredAvatarPrefs,
  setStoredAvatarPrefs,
} from '../lib/avatarPrefs';

export function useAvatarPrefs() {
  const [prefs, setPrefs] = useState<AvatarPrefs>(() => getStoredAvatarPrefs());

  useEffect(() => {
    const sync = () => setPrefs(getStoredAvatarPrefs());
    window.addEventListener(AVATAR_PREFS_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(AVATAR_PREFS_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const save = useCallback((next: AvatarPrefs) => {
    setStoredAvatarPrefs(next);
  }, []);

  return { prefs, save };
}
