import { useLayoutEffect, useState, type RefObject } from 'react';

// Returns the live `clientWidth` of the referenced element and keeps it in
// sync via ResizeObserver. Used by summary skeletons to size themselves to
// the actual content width at mount, rather than hard-coding assumptions
// about viewport size.
export function useContentWidth<T extends HTMLElement>(
  ref: RefObject<T | null>,
): number {
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        setWidth(target.clientWidth);
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [ref]);

  return width;
}
