import { useCallback, useEffect, useRef } from 'react';

interface Options {
  enabled?: boolean;
  onScrolledPast: (id: number) => void;
  topOffset?: number;
}

interface RowHandle {
  observe: (id: number, el: HTMLElement | null) => void;
}

export function useAutoDismissOnScroll({
  enabled = true,
  onScrolledPast,
  topOffset = 0,
}: Options): RowHandle {
  const callbackRef = useRef(onScrolledPast);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const elToId = useRef(new Map<Element, number>());
  const seen = useRef(new Set<number>());

  useEffect(() => {
    callbackRef.current = onScrolledPast;
  }, [onScrolledPast]);

  useEffect(() => {
    if (!enabled) return;
    if (typeof IntersectionObserver === 'undefined') return;

    const elMap = elToId.current;
    const seenSet = seen.current;
    const threshold = Math.max(0, topOffset);

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = elMap.get(entry.target);
          if (id === undefined) continue;

          if (entry.isIntersecting) {
            seenSet.add(id);
            continue;
          }
          if (!seenSet.has(id)) continue;

          const rect = entry.boundingClientRect;
          if (rect.bottom <= threshold) {
            seenSet.delete(id);
            callbackRef.current(id);
          }
        }
      },
      topOffset > 0
        ? { rootMargin: `-${Math.ceil(topOffset)}px 0px 0px 0px` }
        : undefined,
    );

    observerRef.current = observer;
    for (const el of elMap.keys()) {
      observer.observe(el);
    }

    return () => {
      observer.disconnect();
      observerRef.current = null;
      elMap.clear();
      seenSet.clear();
    };
  }, [enabled, topOffset]);

  const observe = useCallback(
    (id: number, el: HTMLElement | null) => {
      if (!enabled) return;
      const elMap = elToId.current;
      const observer = observerRef.current;

      for (const [existingEl, existingId] of elMap) {
        if (existingId === id && existingEl !== el) {
          observer?.unobserve(existingEl);
          elMap.delete(existingEl);
        }
      }

      if (el) {
        elMap.set(el, id);
        observer?.observe(el);
      }
    },
    [enabled],
  );

  return { observe };
}
