import { useEffect, useRef } from 'react';

interface Options {
  enabled: boolean;
  // May be async: the comment pager awaits a batch fetch before
  // revealing the next page, and the catch-up loop below waits on it so
  // it doesn't fire every page at once.
  onLoadMore: () => void | Promise<void>;
  rootMargin?: string;
}

export function useInfiniteScroll<T extends HTMLElement>({
  enabled,
  onLoadMore,
  rootMargin = '400px 0px',
}: Options) {
  const sentinelRef = useRef<T | null>(null);
  const onLoadMoreRef = useRef(onLoadMore);

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    if (!enabled) return;
    const node = sentinelRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') return;

    let disposed = false;
    let pumping = false;

    // Whether the reader has reached (or scrolled past) the sentinel —
    // its top edge is at or above the bottom of the viewport. Measured
    // live from layout rather than from the IntersectionObserver entry
    // on purpose: with the default 400px prefetch `rootMargin`,
    // `entry.rootBounds` sits ~400px above the real viewport, so an
    // entry-coordinate check would treat a sentinel parked anywhere in
    // that 400px band as "still below" and strand the reader there. A
    // zero-size rect means no layout (jsdom/SSR) — report "not reached"
    // so the catch-up loop never spins without real geometry.
    const reachedSentinel = (): boolean => {
      const n = sentinelRef.current;
      if (!n || typeof n.getBoundingClientRect !== 'function') return false;
      const rect = n.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      const viewportH =
        window.innerHeight || document.documentElement?.clientHeight || 0;
      return rect.top <= viewportH;
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        // Trigger on the normal "entered the prefetch margin below the
        // fold" intersection, and as a backstop when the sentinel is
        // already above the real viewport top (a fast scroll can fly it
        // past between observer samples). The catch-up loop in `pump`
        // does the real work of not stranding the reader.
        const aboveViewport =
          !!entry.boundingClientRect && entry.boundingClientRect.bottom <= 0;
        if (entry.isIntersecting || aboveViewport) void pump();
      },
      { rootMargin },
    );

    async function pump() {
      if (pumping || disposed) return;
      pumping = true;
      try {
        // The first pass is the normal one-page prefetch. Keep going
        // only while the reader has actually reached the sentinel — the
        // catch-up case, where a fast scroll on a slow link left several
        // pages between the last loaded comment and where the reader
        // parked. Re-measured after each page (and after a frame so the
        // freshly revealed comments are laid out), so the loop stops the
        // instant the sentinel drops back below the fold instead of
        // loading the whole thread at once.
        do {
          await onLoadMoreRef.current();
          await nextFrame();
        } while (!disposed && reachedSentinel());
      } finally {
        pumping = false;
      }
    }

    observer.observe(node);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [enabled, rootMargin]);

  return sentinelRef;
}

// Yield until after the next paint so React has committed (and the
// browser laid out) the page we just revealed before the catch-up loop
// re-measures the sentinel. Falls back to a resolved promise where
// requestAnimationFrame is unavailable (jsdom/SSR).
function nextFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve();
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}
