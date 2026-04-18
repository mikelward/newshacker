import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, PointerEvent } from 'react';

const SWIPE_RATIO = 0.35;
const SWIPE_MIN_PX = 80;
const ANGLE_RATIO = 1.2;
const START_THRESHOLD_PX = 8;
const EXIT_DURATION_MS = 200;

interface Options {
  onDismiss: () => void;
  enabled?: boolean;
}

interface PointerStart {
  x: number;
  y: number;
  width: number;
  pointerId: number;
  swiping: boolean;
}

export function useSwipeToDismiss({ onDismiss, enabled = true }: Options) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [isDismissing, setIsDismissing] = useState(false);

  const startRef = useRef<PointerStart | null>(null);
  const justSwipedRef = useRef(false);
  const timeoutRef = useRef<number | null>(null);
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current != null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      if (!enabled || isDismissing) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      justSwipedRef.current = false;
      const rect = e.currentTarget.getBoundingClientRect();
      startRef.current = {
        x: e.clientX,
        y: e.clientY,
        width: rect.width,
        pointerId: e.pointerId,
        swiping: false,
      };
    },
    [enabled, isDismissing],
  );

  const onPointerMove = useCallback((e: PointerEvent<HTMLElement>) => {
    const start = startRef.current;
    if (!start || start.pointerId !== e.pointerId) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!start.swiping) {
      if (Math.abs(dx) < START_THRESHOLD_PX) return;
      if (Math.abs(dx) < Math.abs(dy) * ANGLE_RATIO) {
        startRef.current = null;
        return;
      }
      start.swiping = true;
      setDragging(true);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // jsdom / unsupported: safe to ignore
      }
    }
    setOffset(dx);
  }, []);

  const onPointerUp = useCallback((e: PointerEvent<HTMLElement>) => {
    const start = startRef.current;
    if (!start || start.pointerId !== e.pointerId) return;
    const dx = e.clientX - start.x;
    const threshold = Math.max(SWIPE_MIN_PX, start.width * SWIPE_RATIO);
    const width = start.width;
    const wasSwiping = start.swiping;
    startRef.current = null;
    setDragging(false);

    if (wasSwiping && Math.abs(dx) >= threshold) {
      justSwipedRef.current = true;
      setIsDismissing(true);
      const dir = dx >= 0 ? 1 : -1;
      setOffset(dir * Math.max(width, 300));
      timeoutRef.current = window.setTimeout(() => {
        onDismissRef.current();
      }, EXIT_DURATION_MS);
    } else {
      setOffset(0);
      if (wasSwiping) justSwipedRef.current = true;
    }
  }, []);

  const onPointerCancel = useCallback((e: PointerEvent<HTMLElement>) => {
    const start = startRef.current;
    if (!start || start.pointerId !== e.pointerId) return;
    startRef.current = null;
    setDragging(false);
    setOffset(0);
  }, []);

  const onClickCapture = useCallback((e: MouseEvent) => {
    if (justSwipedRef.current) {
      e.preventDefault();
      e.stopPropagation();
      justSwipedRef.current = false;
    }
  }, []);

  const style: CSSProperties =
    offset === 0 && !isDismissing
      ? {}
      : {
          transform: `translate3d(${offset}px, 0, 0)`,
          opacity: isDismissing
            ? 0
            : Math.max(0.4, 1 - Math.abs(offset) / 500),
          transition: dragging
            ? 'none'
            : `transform ${EXIT_DURATION_MS}ms ease-out, opacity ${EXIT_DURATION_MS}ms ease-out`,
        };

  return {
    offset,
    dragging,
    isDismissing,
    style,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onClickCapture,
    },
  };
}
