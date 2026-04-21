import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';

// Drag distance in CSS px at which a release will trigger the refresh.
// Matches Android's PTR feel — roughly a thumb's worth of pull.
const TRIGGER_PX = 64;
// Visual travel caps out here even if the user keeps pulling, so the
// indicator never drifts arbitrarily far down the screen.
const MAX_PULL_PX = 96;
// Rubber-band factor — 1px of finger motion paints roughly 0.5px of
// surface translation, which is what iOS/Android PTR implementations
// use to make the pull feel weighty past the trigger threshold.
const RESISTANCE = 0.5;
// How far the finger must travel (in raw px, pre-resistance) before we
// commit to "this is a pull" and start visibly translating. Below this
// we stay idle so a small unintentional tap-wiggle doesn't twitch the
// UI.
const START_THRESHOLD_PX = 8;
// Reject the gesture as soon as the pointer trends more horizontal
// than vertical — lets `useSwipeToDismiss` own horizontal row swipes.
const ANGLE_RATIO = 1.2;
// Keep the spinner visible for at least this long after a tap-fast
// refresh so the user actually perceives the refresh happening, even
// if the network answer lands in a few ms from cache.
const MIN_SPIN_MS = 400;

type Phase = 'idle' | 'pulling' | 'refreshing' | 'settling';

interface Options {
  onRefresh: () => void | Promise<unknown>;
  enabled?: boolean;
  // Reports whether the document is scrolled to the top at pointerdown.
  // Exposed for testability; defaults to reading `window.scrollY`.
  isAtTop?: () => boolean;
}

interface PointerStart {
  x: number;
  y: number;
  pointerId: number;
  armed: boolean;
}

export interface PullToRefreshState {
  phase: Phase;
  pull: number;
  progress: number;
  handlers: {
    onPointerDown: (e: PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: PointerEvent<HTMLElement>) => void;
  };
}

function defaultIsAtTop(): boolean {
  if (typeof window === 'undefined') return true;
  const el = document.scrollingElement || document.documentElement;
  return (el?.scrollTop ?? window.scrollY) <= 0;
}

export function usePullToRefresh({
  onRefresh,
  enabled = true,
  isAtTop = defaultIsAtTop,
}: Options): PullToRefreshState {
  const [phase, setPhase] = useState<Phase>('idle');
  const [pull, setPull] = useState(0);

  const startRef = useRef<PointerStart | null>(null);
  const onRefreshRef = useRef(onRefresh);
  const isAtTopRef = useRef(isAtTop);
  const phaseRef = useRef<Phase>('idle');
  const settleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);
  useEffect(() => {
    isAtTopRef.current = isAtTop;
  }, [isAtTop]);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    return () => {
      if (settleTimerRef.current != null) {
        window.clearTimeout(settleTimerRef.current);
      }
    };
  }, []);

  const resetToIdle = useCallback(() => {
    setPhase('idle');
    setPull(0);
  }, []);

  const runRefresh = useCallback(() => {
    setPhase('refreshing');
    setPull(TRIGGER_PX);
    const started = Date.now();
    let result: unknown;
    try {
      result = onRefreshRef.current();
    } catch (err) {
      // Swallow so a throwing callback doesn't leave the spinner stuck
      // — we still finish the settle animation. Callers that need to
      // surface failure should do so via their own error state (e.g.
      // React Query's isError), not by throwing out of onRefresh.
      console.error('[PullToRefresh] onRefresh threw', err);
      result = undefined;
    }
    const finish = () => {
      const elapsed = Date.now() - started;
      const wait = Math.max(0, MIN_SPIN_MS - elapsed);
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null;
        setPhase('settling');
        setPull(0);
        // Hand control back to 'idle' once the CSS transition ends.
        // We don't listen for transitionend (flaky in jsdom) — a short
        // delay longer than the CSS transition is enough.
        settleTimerRef.current = window.setTimeout(() => {
          settleTimerRef.current = null;
          resetToIdle();
        }, 220);
      }, wait);
    };
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<unknown>).then(finish, finish);
    } else {
      finish();
    }
  }, [resetToIdle]);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      if (!enabled) return;
      if (phaseRef.current === 'refreshing' || phaseRef.current === 'settling') return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (!isAtTopRef.current()) return;
      startRef.current = {
        x: e.clientX,
        y: e.clientY,
        pointerId: e.pointerId,
        armed: false,
      };
    },
    [enabled],
  );

  const onPointerMove = useCallback((e: PointerEvent<HTMLElement>) => {
    const start = startRef.current;
    if (!start || start.pointerId !== e.pointerId) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;

    if (!start.armed) {
      // Abort if the gesture starts primarily horizontal — that's a
      // swipe-to-dismiss on a row, not a pull.
      if (Math.abs(dx) > Math.abs(dy) * ANGLE_RATIO && Math.abs(dx) > START_THRESHOLD_PX) {
        startRef.current = null;
        return;
      }
      // Or an upward drag — that's just a normal page scroll attempt.
      if (dy < -START_THRESHOLD_PX) {
        startRef.current = null;
        return;
      }
      if (dy < START_THRESHOLD_PX) return;
      start.armed = true;
      setPhase('pulling');
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // jsdom / unsupported environments: safe to ignore.
      }
    }

    const raw = Math.max(0, dy - START_THRESHOLD_PX);
    const next = Math.min(MAX_PULL_PX, raw * RESISTANCE);
    setPull(next);
  }, []);

  const onPointerUp = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const start = startRef.current;
      if (!start || start.pointerId !== e.pointerId) return;
      const wasArmed = start.armed;
      startRef.current = null;
      if (!wasArmed) {
        resetToIdle();
        return;
      }
      const dy = e.clientY - start.y;
      const raw = Math.max(0, dy - START_THRESHOLD_PX);
      const displayed = Math.min(MAX_PULL_PX, raw * RESISTANCE);
      if (displayed >= TRIGGER_PX) {
        runRefresh();
      } else {
        setPhase('settling');
        setPull(0);
        settleTimerRef.current = window.setTimeout(() => {
          settleTimerRef.current = null;
          resetToIdle();
        }, 220);
      }
    },
    [resetToIdle, runRefresh],
  );

  const onPointerCancel = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const start = startRef.current;
      if (!start || start.pointerId !== e.pointerId) return;
      startRef.current = null;
      if (phaseRef.current === 'pulling') {
        setPhase('settling');
        setPull(0);
        settleTimerRef.current = window.setTimeout(() => {
          settleTimerRef.current = null;
          resetToIdle();
        }, 220);
      }
    },
    [resetToIdle],
  );

  const progress = Math.min(1, pull / TRIGGER_PX);

  return {
    phase,
    pull,
    progress,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
    },
  };
}

export const PULL_TO_REFRESH_TRIGGER_PX = TRIGGER_PX;
export const PULL_TO_REFRESH_MAX_PX = MAX_PULL_PX;
