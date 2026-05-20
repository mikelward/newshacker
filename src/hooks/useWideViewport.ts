import { useEffect, useState } from 'react';

// True when the viewport is at least 960px wide — the same breakpoint
// that widens `.app-main` in global.css. Used to decide layout (not
// just sizing) on roomy screens: e.g. the thread action bar surfaces
// Favorite/Share as inline icon buttons instead of tucking them in the
// overflow menu. Deliberately width-only (no `hover`/`pointer` gate) so
// the expanded bar shows on touch tablets in landscape too. SSR-safe
// (returns false when `window` is undefined).
const QUERY = '(min-width: 960px)';

export function useWideViewport(): boolean {
  const [value, setValue] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(QUERY).matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(QUERY);
    const update = () => setValue(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);
  return value;
}
