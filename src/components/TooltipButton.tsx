import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ButtonHTMLAttributes,
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

    const startRef = useRef<{
      x: number;
      y: number;
      pointerId: number;
    } | null>(null);
    const showTimerRef = useRef<number | null>(null);
    const hideTimerRef = useRef<number | null>(null);
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

    const showTooltip = useCallback(() => {
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
      setOpen(true);
      clearHideTimer();
      hideTimerRef.current = window.setTimeout(() => {
        hideTimerRef.current = null;
        setOpen(false);
      }, tooltipDurationMs);
    }, [tooltipDurationMs, clearHideTimer]);

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
        // Desktop mouse already gets the native `title` tooltip on hover;
        // only fire the long-press behavior for touch/pen.
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
          showTooltip();
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
      },
      [onPointerCancel, clearShowTimer, clearHideTimer],
    );

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

    return (
      <>
        <button
          ref={buttonRef}
          className={mergedClassName}
          title={title ?? tooltip}
          aria-describedby={open ? tooltipId : undefined}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onContextMenu={handleContextMenu}
          onClick={handleClick}
          {...rest}
        >
          {children}
        </button>
        {open && position && portalTarget
          ? createPortal(
              <span
                id={tooltipId}
                role="tooltip"
                className={`tooltip-button__tooltip tooltip-button__tooltip--${position.placement}`}
                style={{ top: position.top, left: position.left }}
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
