import { useEffect, useState } from 'react';

/**
 * True when the primary input device reports hover support — i.e.
 * `matchMedia('(hover: hover)')` matches. We use this to gate
 * pointer-device-only affordances: hover tooltips on icon buttons,
 * right-click menus, the anchored popover form of StoryRowMenu, and
 * hover-visible chevrons on collapsible comments. SSR-safe (returns
 * false when `window` is undefined).
 */
export function usePointerDevice(): boolean {
  const [value, setValue] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(hover: hover)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(hover: hover)');
    const update = () => setValue(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);
  return value;
}
