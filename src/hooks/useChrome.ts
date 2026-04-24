import { useCallback, useEffect, useState } from 'react';
import {
  CHROME_CHANGE_EVENT,
  type Chrome,
  getStoredChrome,
  setStoredChrome,
} from '../lib/chrome';

export function useChrome() {
  const [chrome, setChromeState] = useState<Chrome>(() => getStoredChrome());

  useEffect(() => {
    const sync = () => setChromeState(getStoredChrome());
    window.addEventListener(CHROME_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CHROME_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const setChrome = useCallback((c: Chrome) => setStoredChrome(c), []);

  return { chrome, setChrome };
}
