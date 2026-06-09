import { useCallback, useEffect, useState } from 'react';
import {
  THEME_CHANGE_EVENT,
  type Theme,
  applyTheme,
  applyThemeColorMeta,
  getStoredTheme,
  resolveTheme,
  setStoredTheme,
} from '../lib/theme';

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => getStoredTheme());
  const [resolved, setResolved] = useState<'light' | 'dark'>(() =>
    resolveTheme(getStoredTheme()),
  );

  useEffect(() => {
    const sync = () => {
      const next = getStoredTheme();
      setThemeState(next);
      setResolved(resolveTheme(next));
      // Repaint, not just re-render: the page is styled off the
      // `data-theme` attribute on <html>, which only the tab that
      // called setStoredTheme has applied. A cross-tab `storage`
      // event must apply it here too or this tab's picker flips
      // while the page colors stay stale. (Idempotent for the
      // same-tab THEME_CHANGE_EVENT case.)
      applyTheme(next);
    };
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  useEffect(() => {
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const next = resolveTheme('system');
      setResolved(next);
      // Keep the browser chrome tint in sync when the OS flips under a
      // `system` selection — `applyTheme` only runs on explicit user
      // changes, so without this the meta would lag the CSS by a
      // whole page reload.
      applyThemeColorMeta(next);
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => setStoredTheme(t), []);

  return { theme, resolved, setTheme };
}
