import { useCallback, useEffect, useState } from 'react';
import {
  FONT_SIZE_CHANGE_EVENT,
  type FontSize,
  applyFontSize,
  getStoredFontSize,
  setStoredFontSize,
} from '../lib/fontSize';

export function useFontSize() {
  const [fontSize, setFontSizeState] = useState<FontSize>(() =>
    getStoredFontSize(),
  );

  useEffect(() => {
    const sync = () => {
      const next = getStoredFontSize();
      setFontSizeState(next);
      // Cross-tab `storage` events must also repaint the `data-font-size`
      // attribute — only the tab that called setStoredFontSize applied
      // it. (Idempotent for the same-tab FONT_SIZE_CHANGE_EVENT case.)
      applyFontSize(next);
    };
    window.addEventListener(FONT_SIZE_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(FONT_SIZE_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const setFontSize = useCallback((f: FontSize) => setStoredFontSize(f), []);

  return { fontSize, setFontSize };
}
