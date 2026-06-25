import { useEffect, useState } from 'react';

// Intrusion (px) of the pinned bottom action bar up from the viewport foot,
// used only when the sticky-bottom-bar setting is on. Mirrors `useStickyInset`
// (top chrome) for the bottom edge: it's the bar's height while it's stuck at
// the foot, and 0 once it sits in normal flow below the fold (clamped). The
// Sweep IntersectionObserver shrinks its root's bottom edge by this so a row
// tucked behind the pinned bar isn't counted fully visible.
//
// Driven off the footer *element* (passed in, null when the bar is absent or the
// setting is off) rather than a DOM class query, so the measurement re-runs the
// moment the footer mounts — on a cold feed load the bar doesn't exist yet while
// the skeleton renders, and a one-shot query would leave the inset stuck at 0
// until the next scroll/resize, letting the first Sweep include a row behind the
// bar.
function measure(el: Element): number {
  if (typeof window === 'undefined') return 0;
  const rect = el.getBoundingClientRect();
  // When stuck, rect.top = innerHeight - height → intrusion = height. When the
  // bar is still below the fold its top is past the viewport bottom, yielding a
  // negative intrusion that clamps to 0. Floor (don't ceil) so a flush row a
  // sub-pixel behind the bar still counts as visible.
  return Math.max(0, Math.floor(window.innerHeight - rect.top));
}

export function useStickyFooterInset(el: HTMLElement | null): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (!el) return;
    const update = () =>
      setInset((prev) => {
        const next = measure(el);
        return prev === next ? prev : next;
      });
    update();
    window.addEventListener('resize', update);
    let rafId: number | null = null;
    const onScroll = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        update();
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(update);
      ro.observe(el);
    }
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', onScroll);
      if (rafId !== null) cancelAnimationFrame(rafId);
      ro?.disconnect();
    };
  }, [el]);

  // 0 whenever there's no element to measure (bar absent or setting off), so a
  // stale measurement can't linger after the element goes away.
  return el ? inset : 0;
}
