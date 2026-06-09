import { useCallback, useEffect, useState } from 'react';
import {
  CHROME_CHANGE_EVENT,
  type Chrome,
  applyChrome,
  getStoredChrome,
  setStoredChrome,
} from '../lib/chrome';

export function useChrome() {
  const [chrome, setChromeState] = useState<Chrome>(() => getStoredChrome());

  useEffect(() => {
    const sync = () => {
      const next = getStoredChrome();
      setChromeState(next);
      // Cross-tab `storage` events must also repaint the `data-chrome`
      // attribute — only the tab that called setStoredChrome applied
      // it. (Idempotent for the same-tab CHROME_CHANGE_EVENT case.)
      applyChrome(next);
    };
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
