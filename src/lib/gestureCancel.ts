/**
 * "Something else has claimed this gesture — stand down."
 *
 * Broadcast on `window` when a multi-touch gesture takes over from a
 * single-pointer one. It exists because the two kinds of gesture in this app
 * don't share an event stream and can't see each other: the row swipe
 * (`useSwipeToDismiss`) and pull-to-refresh (`usePullToRefresh`) track *pointer*
 * events, while the pinch (`usePinchFontSize`) reads *touch* events, which is
 * the only API that reports two fingers at once.
 *
 * `preventDefault()` on a touch event does not reach across: it stops the page
 * scrolling and zooming, but the pointer stream keeps flowing, so a pinch that
 * starts on a story row leaves that row's swipe still tracking the first
 * finger. Spread the fingers horizontally and its eventual `pointerup` commits
 * the swipe action — a destructive action the user never asked for, while they were
 * resizing text. The browser fires no `pointercancel` for this, because nothing
 * went wrong from its point of view.
 *
 * A window event rather than context so the pinch handler, which is mounted once
 * at the app root, doesn't have to know which rows exist or be threaded through
 * every list; the same shape the theme uses (`newshacker:themeChanged`).
 */
export const GESTURE_CANCEL_EVENT = 'newshacker:gestureCancel';

/**
 * The half of standing down that no subscriber can do for itself: swallowing
 * the click a finger still resting on a control will fire when it lifts.
 *
 * Subscribing works for a gesture that owns state (the swipe, the pull, the
 * reorder drag). It does not work for *activation*, because there is no one
 * place that activates: `TooltipButton` is one of many, and the story-row menu items,
 * the login dialog's buttons and others are plain `<button>`s that will never
 * subscribe to anything. Asking each to opt in leaves the next one written
 * without it — and the failure is a destructive action (hiding a story,
 * casting a vote) taken while they were only resizing text.
 *
 * So this is a capture-phase swallow at the document, armed by the broadcast
 * and disarmed by the next `pointerdown`: a fresh press is a new intention, so
 * anything the pinch interrupted is over by then. It cannot strand a control —
 * every real pointer click is preceded by the `pointerdown` that disarms it —
 * and it leaves keyboard activation (`detail === 0`) alone, which has no
 * pointer behind it and so can never be the tail of an abandoned gesture.
 */
let swallowClicks = false;
let suppressorInstalled = false;

function installClickSuppressor(): void {
  if (suppressorInstalled) return;
  suppressorInstalled = true;
  document.addEventListener(
    'click',
    (e) => {
      if (!swallowClicks) return;
      if ((e as MouseEvent).detail === 0) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  document.addEventListener(
    'pointerdown',
    () => {
      swallowClicks = false;
    },
    true,
  );
}

/** Tell every single-pointer gesture in flight to abandon itself. */
export function cancelPointerGestures(): void {
  if (typeof window === 'undefined') return;
  installClickSuppressor();
  swallowClicks = true;
  window.dispatchEvent(new CustomEvent(GESTURE_CANCEL_EVENT));
}

/** Subscribe to the broadcast; returns the unsubscribe. */
export function onGestureCancel(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(GESTURE_CANCEL_EVENT, handler);
  return () => window.removeEventListener(GESTURE_CANCEL_EVENT, handler);
}
