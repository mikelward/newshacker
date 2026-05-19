import { useEffect, useState } from 'react';
import { measureStickyInset } from '../lib/stickyInset';

// Live `measureStickyInset()` value: the combined bottom of the
// sticky chrome at the top of the viewport (`.app-header` +
// `.list-toolbar`). Used by `StoryList` to set the sweep
// IntersectionObserver's `rootMargin` so rows behind the sticky
// strips are not counted as fully visible.
//
// Re-measures on four triggers:
// 1. mount (so the initial value reflects the real layout, not
//    the SSR-friendly 0 from the `useState` initializer);
// 2. `window` resize (viewport changes);
// 3. ResizeObserver entries on the sticky strips themselves —
//    opening the `/hot` customize panel grows `.list-toolbar` in
//    place without a window resize, and a stale inset would let
//    rows hidden behind the expanded panel slip into Sweep's
//    batch. Feature-detected so jsdom (no implementation)
//    gracefully falls back to the other listeners;
// 4. window scroll (rAF-coalesced) — the toolbar's
//    `getBoundingClientRect().bottom` shifts by 1-3px when it
//    transitions from normal flow (with the header's
//    `margin-bottom` plus the border-bottom in the way) to sticky
//    (`top: var(--app-header-height)`, possibly overlapping the
//    header's bottom border by 1px in mono/duo chromes). Without
//    this trigger the cached inset is stale by a few pixels right
//    through the sticky transition, and the IO's `intersectionRatio
//    >= 0.999` check on a ~80px row leaves no room for a 1-3px
//    error — the boundary row would be wrongly excluded from
//    Sweep. rAF coalescing keeps the work at most once per frame;
//    React skips the re-render (and the IO recreation in
//    `StoryList`) when the rounded value hasn't actually changed,
//    so the steady-state cost during a long scroll is one rect
//    read per frame, no IO churn.
//
// All four Codex P2 comments on PR #299 trace to the inset
// staying stale relative to what the user can actually see; this
// hook is the single source of truth that fixes them.
export function useStickyInset(): number {
  const [inset, setInset] = useState<number>(() => measureStickyInset());

  useEffect(() => {
    const update = () => setInset(measureStickyInset());
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
      for (const selector of ['.app-header', '.list-toolbar']) {
        const el = document.querySelector(selector);
        if (el) ro.observe(el);
      }
    }
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', onScroll);
      if (rafId !== null) cancelAnimationFrame(rafId);
      ro?.disconnect();
    };
  }, []);

  return inset;
}
