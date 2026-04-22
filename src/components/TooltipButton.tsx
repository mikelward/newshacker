import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import './TooltipButton.css';

const DEFAULT_DELAY_MS = 500;
const DEFAULT_DURATION_MS = 1200;
const MOVE_CANCEL_PX = 10;

export interface TooltipButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * Short label shown in the long-press tooltip on touch devices, and
   * used as the `title` attribute so desktop hover surfaces the same
   * copy. Icon-only buttons MUST pass this; text buttons don't need it.
   */
  tooltip: string;
  tooltipDelayMs?: number;
  tooltipDurationMs?: number;
}

export const TooltipButton = forwardRef<HTMLButtonElement, TooltipButtonProps>(
  function TooltipButton(
    {
      tooltip,
      tooltipDelayMs = DEFAULT_DELAY_MS,
      tooltipDurationMs = DEFAULT_DURATION_MS,
      className,
      title,
      children,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onContextMenu,
      onClick,
      ...rest
    },
    forwardedRef,
  ) {
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    useImperativeHandle(
      forwardedRef,
      () => buttonRef.current as HTMLButtonElement,
    );

    const tooltipId = useId();

    const [open, setOpen] = useState(false);
    const [position, setPosition] = useState<{
      top: number;
      left: number;
      placement: 'above' | 'below';
    } | null>(null);
    const [xShift, setXShift] = useState(0);
    const tooltipRef = useRef<HTMLSpanElement | null>(null);

    const startRef = useRef<{
      x: number;
      y: number;
      pointerId: number;
    } | null>(null);
    const showTimerRef = useRef<number | null>(null);
    const hideTimerRef = useRef<number | null>(null);
    // True while the tooltip is up for long-press reasons (touch).
    // False while it's up for hover reasons (mouse). We track it
    // because the two modes have different hide rules: long-press
    // auto-hides after a duration and swallows the follow-up click;
    // hover persists until mouseleave and does not swallow clicks.
    const longPressShownRef = useRef(false);
    const activatedRef = useRef(false);

    const clearShowTimer = useCallback(() => {
      if (showTimerRef.current != null) {
        window.clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
    }, []);
    const clearHideTimer = useCallback(() => {
      if (hideTimerRef.current != null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    }, []);

    useEffect(
      () => () => {
        clearShowTimer();
        clearHideTimer();
      },
      [clearShowTimer, clearHideTimer],
    );

    // After the tooltip renders, measure its width and nudge it back
    // inside the viewport if it overhangs. The positioning math in
    // `showTooltip` only knows the anchor point (button center); the
    // tooltip's rendered width is what actually determines whether it
    // fits. We compute the correction as an *absolute* offset from
    // the ideal (unshifted) center so a single pass stabilizes — no
    // incremental feedback loop.
    useLayoutEffect(() => {
      if (!open || !position) return;
      const tip = tooltipRef.current;
      if (!tip) return;
      const rect = tip.getBoundingClientRect();
      if (rect.width === 0) return;
      const vv =
        typeof window !== 'undefined' ? window.visualViewport : null;
      const viewportWidth =
        vv?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 0);
      const MARGIN = 8;
      const halfWidth = rect.width / 2;
      const idealLeft = position.left - halfWidth;
      const idealRight = position.left + halfWidth;
      let nextShift = 0;
      if (idealRight > viewportWidth - MARGIN) {
        nextShift = viewportWidth - MARGIN - idealRight;
      }
      if (idealLeft + nextShift < MARGIN) {
        nextShift = MARGIN - idealLeft;
      }
      if (nextShift !== xShift) setXShift(nextShift);
    }, [open, position, xShift]);

    const showTooltip = useCallback(
      (mode: 'longpress' | 'hover') => {
        const btn = buttonRef.current;
        if (!btn) return;
        const rect = btn.getBoundingClientRect();
        // Use the visual viewport when available so we stay inside the
        // *visible* area as the mobile address bar collapses.
        const vv =
          typeof window !== 'undefined' ? window.visualViewport : null;
        const viewportWidth =
          vv?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 0);
        const viewportHeight =
          vv?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 0);
        const SPACE_NEEDED = 44; // 6+13 line-height*~1.3 + 10 padding + 8 gap + slack
        const preferAbove = rect.top >= SPACE_NEEDED;
        const placement: 'above' | 'below' =
          preferAbove || viewportHeight - rect.bottom < SPACE_NEEDED
            ? 'above'
            : 'below';
        const MARGIN = 8;
        const rawLeft = rect.left + rect.width / 2;
        const left = Math.min(
          Math.max(rawLeft, MARGIN),
          Math.max(MARGIN, viewportWidth - MARGIN),
        );
        setPosition({
          top: placement === 'above' ? rect.top : rect.bottom,
          left,
          placement,
        });
        // Reset any pre-existing horizontal shift from a previous show so
        // the measurement effect can re-compute from the ideal center.
        setXShift(0);
        setOpen(true);
        clearHideTimer();
        longPressShownRef.current = mode === 'longpress';
        if (mode === 'longpress') {
          hideTimerRef.current = window.setTimeout(() => {
            hideTimerRef.current = null;
            setOpen(false);
          }, tooltipDurationMs);
        }
        // Hover mode has no auto-hide timer — mouseleave/blur hides it.
      },
      [tooltipDurationMs, clearHideTimer],
    );

    const handlePointerDown = useCallback(
      (e: PointerEvent<HTMLButtonElement>) => {
        onPointerDown?.(e);
        // A TooltipButton is an independent tap target; don't let its
        // pointerdown bubble into ancestor gesture listeners (e.g. a
        // story row's long-press-opens-menu timer) and compete with
        // the tooltip gesture. We only stop it here — move/up/cancel
        // are harmless to ancestors since those listeners key off
        // state they set in their own pointerdown handler.
        e.stopPropagation();
        // Mouse gets the hover-triggered tooltip via mouseenter; only
        // fire the long-press behavior for touch/pen.
        if (e.pointerType === 'mouse') return;
        startRef.current = {
          x: e.clientX,
          y: e.clientY,
          pointerId: e.pointerId,
        };
        activatedRef.current = false;
        clearShowTimer();
        showTimerRef.current = window.setTimeout(() => {
          showTimerRef.current = null;
          activatedRef.current = true;
          showTooltip('longpress');
        }, tooltipDelayMs);
      },
      [onPointerDown, tooltipDelayMs, clearShowTimer, showTooltip],
    );

    const handlePointerMove = useCallback(
      (e: PointerEvent<HTMLButtonElement>) => {
        onPointerMove?.(e);
        const start = startRef.current;
        if (!start || start.pointerId !== e.pointerId) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) {
          clearShowTimer();
          startRef.current = null;
        }
      },
      [onPointerMove, clearShowTimer],
    );

    const handlePointerUp = useCallback(
      (e: PointerEvent<HTMLButtonElement>) => {
        onPointerUp?.(e);
        startRef.current = null;
        clearShowTimer();
      },
      [onPointerUp, clearShowTimer],
    );

    const handlePointerCancel = useCallback(
      (e: PointerEvent<HTMLButtonElement>) => {
        onPointerCancel?.(e);
        startRef.current = null;
        clearShowTimer();
        clearHideTimer();
        setOpen(false);
        activatedRef.current = false;
        longPressShownRef.current = false;
      },
      [onPointerCancel, clearShowTimer, clearHideTimer],
    );

    // Mouse hover / keyboard focus: desktop equivalent of the
    // touch-long-press tooltip. Shows the same styled tooltip after
    // the same delay; hides on leave/blur (no auto-timeout).
    // onPointerEnter is used instead of onMouseEnter so we can gate
    // on pointerType — we don't want to re-show the tooltip on a
    // synthetic mouseenter that follows a touch gesture.
    const hoverActiveRef = useRef(false);
    const hideHoverTooltip = useCallback(() => {
      hoverActiveRef.current = false;
      clearShowTimer();
      if (!longPressShownRef.current) {
        clearHideTimer();
        setOpen(false);
      }
    }, [clearShowTimer, clearHideTimer]);
    const handlePointerEnter = useCallback(
      (e: PointerEvent<HTMLButtonElement>) => {
        if (e.pointerType !== 'mouse') return;
        hoverActiveRef.current = true;
        clearShowTimer();
        showTimerRef.current = window.setTimeout(() => {
          showTimerRef.current = null;
          if (!hoverActiveRef.current) return;
          showTooltip('hover');
        }, tooltipDelayMs);
      },
      [tooltipDelayMs, clearShowTimer, showTooltip],
    );
    const handlePointerLeave = useCallback(
      (e: PointerEvent<HTMLButtonElement>) => {
        if (e.pointerType !== 'mouse') return;
        hideHoverTooltip();
      },
      [hideHoverTooltip],
    );
    const handleBlur = useCallback(() => {
      hideHoverTooltip();
    }, [hideHoverTooltip]);

    const handleContextMenu = useCallback(
      (e: MouseEvent<HTMLButtonElement>) => {
        onContextMenu?.(e);
        if (activatedRef.current || showTimerRef.current != null) {
          e.preventDefault();
        }
      },
      [onContextMenu],
    );

    const handleClick = useCallback(
      (e: MouseEvent<HTMLButtonElement>) => {
        // If the long-press tooltip fired, the user was inspecting the
        // button, not invoking it — swallow the click.
        if (activatedRef.current) {
          activatedRef.current = false;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        onClick?.(e);
      },
      [onClick],
    );

    const mergedClassName = className
      ? `${className} tooltip-button`
      : 'tooltip-button';

    const portalTarget =
      typeof document !== 'undefined' ? document.body : null;

    // Our styled tooltip now covers both the touch long-press and
    // mouse hover paths, so we no longer emit a native `title`
    // attribute — that would double up with our portal tooltip on
    // desktop. Consumers that pass an explicit `title` prop still
    // win (it's a raw HTML escape hatch for cases like an exact
    // string other code needs to read).
    return (
      <>
        <button
          ref={buttonRef}
          className={mergedClassName}
          title={title}
          aria-describedby={open ? tooltipId : undefined}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
          onBlur={handleBlur}
          onContextMenu={handleContextMenu}
          onClick={handleClick}
          {...rest}
        >
          {children}
        </button>
        {open && position && portalTarget
          ? createPortal(
              <span
                ref={tooltipRef}
                id={tooltipId}
                role="tooltip"
                className={`tooltip-button__tooltip tooltip-button__tooltip--${position.placement}`}
                style={
                  {
                    top: position.top,
                    left: position.left,
                    '--tooltip-x-shift': `${xShift}px`,
                  } as CSSProperties
                }
              >
                {tooltip}
              </span>,
              portalTarget,
            )
          : null}
      </>
    );
  },
);
