import { useEffect, useRef } from 'react';

interface PopoverDismissOptions {
  /** Whether the popover is currently open. */
  open: boolean;
  /** Close the popover. */
  onDismiss: () => void;
  /**
   * Return true when an event target is within the popover (or its trigger) —
   * such interactions must NOT dismiss it. Re-read fresh on every event, so a
   * new closure each render is fine (no need to memoize).
   */
  isInside: (target: Node) => boolean;
  /**
   * Wire outside-press dismissal + the first-press-only swallow. Default true.
   * Set false for modal/sheet variants that dismiss via their own backdrop and
   * only want the Escape handling (the document-level outside listener would be
   * redundant there).
   */
  dismissOnOutsidePress?: boolean;
}

/**
 * Shared dismissal contract for every dropdown/popover in the app, so they all
 * behave identically:
 *
 * - **Escape** closes it (and stops propagation, so a page-level Escape handler
 *   doesn't also fire).
 * - **A press outside** closes it. The listener is capture-phase `pointerdown`
 *   so it fires before any `stopPropagation()` (e.g. TooltipButton's long-press
 *   plumbing) and before the target's own handlers, on mouse, touch, and pen
 *   alike.
 * - **The first press outside only dismisses** — the trailing `click` that same
 *   gesture fires is swallowed, so dismissing the popover never also activates
 *   whatever sits underneath (a row's stretched link, a neighboring row, a
 *   toolbar button). A second press is needed to act.
 *
 * The swallow is armed only for a primary-button press (right/middle fire
 * `contextmenu`/`auxclick`, not a primary `click`); a keyboard activation
 * (`detail === 0`, no preceding pointer event) is let through; and if the
 * gesture ends without a click (a drag or text selection released elsewhere),
 * the next `pointerdown` tears the swallower down so it can't eat an unrelated
 * later click.
 */
export function usePopoverDismiss({
  open,
  onDismiss,
  isInside,
  dismissOnOutsidePress = true,
}: PopoverDismissOptions): void {
  // Keep the latest callbacks in refs so the listener effect can depend only on
  // `open` (and the boolean flag) — callers don't have to memoize
  // `onDismiss`/`isInside`. The refs are synced in an effect, not during render
  // (the react-hooks "refs" rule forbids touching `.current` while rendering);
  // it runs after every commit, before any user event, so the listeners always
  // see the latest callbacks.
  const onDismissRef = useRef(onDismiss);
  const isInsideRef = useRef(isInside);
  useEffect(() => {
    onDismissRef.current = onDismiss;
    isInsideRef.current = isInside;
  });

  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onDismissRef.current();
      }
    };
    document.addEventListener('keydown', onKey);

    let teardownOutside: (() => void) | undefined;
    if (dismissOnOutsidePress) {
      const onPointerDown = (e: PointerEvent) => {
        const target = e.target as Node | null;
        if (!target || isInsideRef.current(target)) return;
        onDismissRef.current();
        // The dismissing press must not also drive whatever is underneath.
        // The click swallow below covers click-activated controls; this
        // capture-phase stopPropagation additionally prevents the press from
        // reaching a pointerdown-activated handler (e.g. a drag-to-reorder
        // handle), which would otherwise start a drag on the very press that
        // only meant to dismiss. We don't preventDefault — native scroll,
        // focus, and text selection should still work.
        e.stopPropagation();
        // Only a primary-button press is followed by the `click` we need to
        // swallow; skip right/middle (they fire contextmenu/auxclick).
        if (e.button !== 0) return;
        const swallowClick = (clickEvent: MouseEvent) => {
          // A keyboard activation (Enter/Space) fires a click with detail 0 and
          // no preceding pointer event — never the trailing click of the press
          // we armed for. Let it through; just drop the now-stale swallower.
          if (clickEvent.detail === 0) {
            teardownSwallow();
            return;
          }
          clickEvent.preventDefault();
          clickEvent.stopPropagation();
          teardownSwallow();
        };
        const teardownSwallow = () => {
          document.removeEventListener('click', swallowClick, true);
          document.removeEventListener('pointerdown', teardownSwallow, true);
        };
        document.addEventListener('click', swallowClick, true);
        // If the gesture ends without a click, the next pointerdown — the start
        // of a brand-new gesture — tears the swallower down. Registered after
        // the arming gesture's own pointerdown, so it only fires for later ones.
        document.addEventListener('pointerdown', teardownSwallow, true);
      };
      document.addEventListener('pointerdown', onPointerDown, true);
      teardownOutside = () =>
        document.removeEventListener('pointerdown', onPointerDown, true);
    }

    return () => {
      document.removeEventListener('keydown', onKey);
      teardownOutside?.();
    };
  }, [open, dismissOnOutsidePress]);
}
