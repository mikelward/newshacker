import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePinchFontSize } from './usePinchFontSize';
import { ZOOM_PER_STEP } from '../lib/pinchFontSize';
import { FONT_SIZE_STORAGE_KEY } from '../lib/fontSize';
import { onGestureCancel } from '../lib/gestureCancel';

/** jsdom has no real TouchEvent, and the hook only ever reads `touches`
 * — so a plain cancelable Event carrying that list exercises the same path
 * while letting a test assert `defaultPrevented`. */
function fireTouch(
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  xs: number[],
  target?: Element,
  /** Per-finger targets, for the mixed case where the fingers land on
   * different elements. Falls back to `target` for every finger. */
  targets?: Array<Element | undefined>,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', {
    value: xs.map((clientX, i) => ({
      clientX,
      clientY: 0,
      target: targets?.[i] ?? target ?? document.body,
    })),
  });
  if (target) {
    Object.defineProperty(event, 'target', { value: target });
  }
  window.dispatchEvent(event);
  return event;
}

/** Two fingers `spread` px apart, centered so neither finger's position
 * matters — only the gap does. */
const pinchTo = (
  type: 'touchstart' | 'touchmove',
  spread: number,
  target?: Element,
): Event => fireTouch(type, [0, spread], target);

const attribute = () => document.documentElement.getAttribute('data-font-size');
const stored = () => window.localStorage.getItem(FONT_SIZE_STORAGE_KEY);

// 100px start gap: a step out lands at 112px, a step in at ~89px.
const START = 100;
const OUT_ONE_STEP = START * ZOOM_PER_STEP;
const OUT_TWO_STEPS = START * ZOOM_PER_STEP ** 2;
const IN_ONE_STEP = START / ZOOM_PER_STEP;

describe('usePinchFontSize', () => {
  beforeEach(() => {
    renderHook(() => usePinchFontSize());
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-font-size');
  });

  it('repaints as the fingers move without writing storage', () => {
    pinchTo('touchstart', START);
    pinchTo('touchmove', OUT_ONE_STEP);
    expect(attribute()).toBe('17');
    pinchTo('touchmove', OUT_TWO_STEPS);
    expect(attribute()).toBe('18');
    // Still mid-gesture: the size on screen is a preview, not a decision.
    expect(stored()).toBeNull();
  });

  it('persists once, at the size the gesture settled on', () => {
    pinchTo('touchstart', START);
    pinchTo('touchmove', OUT_TWO_STEPS);
    pinchTo('touchmove', OUT_ONE_STEP);
    fireTouch('touchend', []);
    expect(stored()).toBe('17');
    expect(attribute()).toBe('17');
  });

  it('walks back down the ladder when the fingers close', () => {
    pinchTo('touchstart', START);
    pinchTo('touchmove', IN_ONE_STEP);
    fireTouch('touchend', []);
    expect(stored()).toBe('15');
  });

  it('measures every step from the size the fingers landed on', () => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, '20');
    pinchTo('touchstart', START);
    pinchTo('touchmove', OUT_ONE_STEP);
    fireTouch('touchend', []);
    expect(stored()).toBe('22');
  });

  it('clamps at the end of the ladder but remembers the overshoot', () => {
    pinchTo('touchstart', START);
    // From the 16px default that is 14 rungs' worth of spread against a ladder
    // that has 10 left, so it clamps with two steps of overshoot banked.
    pinchTo('touchmove', START * ZOOM_PER_STEP ** 12);
    expect(attribute()).toBe('32');
    // Coming back to one step out from the *base* gives 17, not the 30 a
    // gesture that had clamped its own count would report: the fingers, not the
    // end of the ladder, say where the size is.
    pinchTo('touchmove', START * ZOOM_PER_STEP);
    expect(attribute()).toBe('17');
    fireTouch('touchend', []);
    expect(stored()).toBe('17');
  });

  it('arms a pinch that starts too close together and then spreads', () => {
    // Below the minimum the ratio is noise, so the gesture cannot start — but
    // the fingers are still down and still the user's pinch. Leaving it null
    // for the rest of the interaction meant Chromium page-zoomed the text
    // while Safari, already suppressed, did nothing at all.
    pinchTo('touchstart', 10);
    pinchTo('touchmove', 20);
    expect(attribute()).toBeNull();

    // Now far enough apart to measure: this becomes the baseline.
    pinchTo('touchmove', 100);
    pinchTo('touchmove', 100 * ZOOM_PER_STEP);
    expect(attribute()).toBe('17');
    fireTouch('touchend', []);
    expect(stored()).toBe('17');
  });

  it('holds a below-threshold pinch rather than letting the page zoom', () => {
    // Safari's zoom is already suppressed for these fingers, so Chromium must
    // not be left free to zoom instead — the same pinch would do two different
    // wrong things depending on the engine.
    fireTouch('touchstart', [0, 10]);
    const move = fireTouch('touchmove', [0, 14]);
    expect(move.defaultPrevented).toBe(true);
    fireTouch('touchend', []);
  });

  it('leaves a below-threshold pinch on an image to the browser', () => {
    // Yielding still wins over holding: an image the browser would zoom is not
    // ours to claim at any finger distance.
    const wrapper = document.createElement('div');
    wrapper.style.touchAction = 'manipulation';
    const img = document.createElement('img');
    wrapper.append(img);
    document.body.append(wrapper);

    fireTouch('touchstart', [0, 10], img);
    const move = fireTouch('touchmove', [0, 14], img);
    expect(move.defaultPrevented).toBe(false);
    fireTouch('touchend', []);

    wrapper.remove();
  });

  it('writes nothing when the gesture ends where it started', () => {
    pinchTo('touchstart', START);
    pinchTo('touchmove', OUT_ONE_STEP);
    pinchTo('touchmove', START);
    fireTouch('touchend', []);
    expect(stored()).toBeNull();
    expect(attribute()).toBeNull();
  });

  it('claims the gesture so the page cannot pan or zoom under it', () => {
    pinchTo('touchstart', START);
    expect(pinchTo('touchmove', OUT_ONE_STEP).defaultPrevented).toBe(true);
  });

  it('leaves one-finger touches entirely alone', () => {
    fireTouch('touchstart', [0]);
    const move = fireTouch('touchmove', [40]);
    expect(move.defaultPrevented).toBe(false);
    expect(attribute()).toBeNull();
  });

  it('ignores two touches that land on top of each other', () => {
    // Below the minimum start gap the ratio is noise, and dividing by it would
    // send the zoom to infinity.
    pinchTo('touchstart', 8);
    pinchTo('touchmove', 200);
    expect(attribute()).toBeNull();
  });

  it('banks the gesture when a third finger arrives', () => {
    pinchTo('touchstart', START);
    pinchTo('touchmove', OUT_ONE_STEP);
    fireTouch('touchstart', [0, OUT_ONE_STEP, 300]);
    expect(stored()).toBe('17');
    // The third finger's frame must not be read as a zoom off the old pair.
    fireTouch('touchmove', [0, 500, 900]);
    expect(attribute()).toBe('17');
  });

  it('keeps suppressing the page zoom while a third finger is down', () => {
    // Banking the size is not standing down. Chromium pinch-zooms from three
    // contacts as readily as two, and page scaling is not something re-arming
    // the remaining pair can undo — so a stray third finger must not be a way
    // to defeat the suppression for the rest of the gesture.
    pinchTo('touchstart', START);
    pinchTo('touchmove', OUT_ONE_STEP);
    fireTouch('touchstart', [0, OUT_ONE_STEP, 300]);
    const move = fireTouch('touchmove', [0, 500, 900]);
    expect(move.defaultPrevented).toBe(true);
    expect(stored()).toBe('17');
  });

  it('still yields to native zoom when three fingers land on an image', () => {
    // The mirror of the rule above: suppression from two contacts up would
    // otherwise cancel a zoom nobody had decided to take, because the yield
    // question used to be asked only of an exact pair.
    const figure = document.createElement('figure');
    const img = document.createElement('img');
    figure.append(img);
    document.body.append(figure);

    fireTouch('touchstart', [0, START, 300], img);
    const move = fireTouch('touchmove', [0, 500, 900], img);
    expect(move.defaultPrevented).toBe(false);
    expect(attribute()).toBeNull();

    figure.remove();
  });

  it('keeps what the user watched happen when the system takes the gesture', () => {
    pinchTo('touchstart', START);
    pinchTo('touchmove', OUT_ONE_STEP);
    fireTouch('touchcancel', []);
    expect(stored()).toBe('17');
  });

  it('yields to native zoom on an image rather than resizing text', () => {
    // The one place a text ladder is no answer: a photograph can only be
    // magnified. Leaving the browser's zoom to it is what keeps the override
    // from costing readers the magnification WCAG 1.4.4 is about.
    const figure = document.createElement('figure');
    const img = document.createElement('img');
    figure.append(img);
    document.body.append(figure);

    pinchTo('touchstart', START, img);
    const move = pinchTo('touchmove', OUT_ONE_STEP, img);
    expect(move.defaultPrevented).toBe(false);
    expect(attribute()).toBeNull();
    expect(stored()).toBeNull();

    figure.remove();
  });

  it('resizes on an image the browser would not zoom anyway', () => {
    // An article row sets `touch-action: pan-y` so its swipe owns horizontal
    // movement, which also excludes pinch-zoom. Standing aside on its thumbnail
    // would suppress the resize and deliver no zoom — the worst of both — so
    // where nobody would zoom, this hook resizes.
    const row = document.createElement('div');
    row.style.touchAction = 'pan-y';
    const img = document.createElement('img');
    row.append(img);
    document.body.append(row);

    pinchTo('touchstart', START, img);
    pinchTo('touchmove', OUT_ONE_STEP, img);
    expect(attribute()).toBe('17');
    fireTouch('touchend', []);

    row.remove();
  });

  it('yields when either finger is on the image, whichever landed last', () => {
    // A TouchEvent's own `target` is only the finger that changed, so reading
    // it alone would make the carve-out depend on pinch direction: inside-then-
    // out would be claimed and the zoom suppressed, out-then-inside would yield.
    const img = document.createElement('img');
    const beside = document.createElement('p');
    document.body.append(img, beside);

    // Second finger lands outside the image — the event's own target is the
    // paragraph, but the pinch still includes the image.
    fireTouch('touchstart', [0, START], beside, [img, beside]);
    fireTouch('touchmove', [0, OUT_ONE_STEP], beside, [img, beside]);
    expect(attribute()).toBeNull();
    fireTouch('touchend', []);

    // And the other way round.
    fireTouch('touchstart', [0, START], img, [beside, img]);
    fireTouch('touchmove', [0, OUT_ONE_STEP], img, [beside, img]);
    expect(attribute()).toBeNull();
    fireTouch('touchend', []);

    img.remove();
    beside.remove();
  });

  it('yields on an image whose ancestors all permit pinch-zoom', () => {
    // The composed walk, the other way round: `manipulation` still allows a
    // pinch, so this one really does reach the browser.
    const wrapper = document.createElement('div');
    wrapper.style.touchAction = 'manipulation';
    const img = document.createElement('img');
    wrapper.append(img);
    document.body.append(wrapper);

    pinchTo('touchstart', START, img);
    pinchTo('touchmove', OUT_ONE_STEP, img);
    expect(attribute()).toBeNull();

    wrapper.remove();
  });

  it('resizes on an image in an iOS home-screen app, where nothing would zoom it', () => {
    // `apple-mobile-web-app-capable` makes iOS drop the page-zoom gesture, so
    // yielding here would suppress the resize and deliver no magnification —
    // the failure the touch-action walk exists to prevent, reached through
    // display mode instead.
    const nav = window.navigator as Navigator & { standalone?: boolean };
    Object.defineProperty(nav, 'standalone', {
      value: true,
      configurable: true,
    });

    const img = document.createElement('img');
    document.body.append(img);
    try {
      pinchTo('touchstart', START, img);
      pinchTo('touchmove', OUT_ONE_STEP, img);
      expect(attribute()).toBe('17');
    } finally {
      delete nav.standalone;
      img.remove();
    }
  });

  it('resizes on an image in an installed Android PWA', () => {
    // Confirmed on a device: the installed app offers no page zoom, on this
    // app's already-permissive viewport. Yielding would deliver nothing.
    const original = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes('standalone'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia;

    const img = document.createElement('img');
    document.body.append(img);
    try {
      pinchTo('touchstart', START, img);
      pinchTo('touchmove', OUT_ONE_STEP, img);
      expect(attribute()).toBe('17');
    } finally {
      window.matchMedia = original;
      img.remove();
    }
  });

  it('still yields on an image in a browser tab', () => {
    // The other side of the switch, and the one that keeps the gate honest:
    // in a tab the magnification is real, so the carve-out must stand aside.
    const original = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia;

    const img = document.createElement('img');
    document.body.append(img);
    try {
      pinchTo('touchstart', START, img);
      pinchTo('touchmove', OUT_ONE_STEP, img);
      expect(attribute()).toBeNull();
    } finally {
      window.matchMedia = original;
      img.remove();
    }
  });

  it('resizes on a control icon rather than handing the browser the page', () => {
    // Every Material glyph is an inline <svg> and `.tooltip-button` is
    // `touch-action: manipulation`, so treating any `svg` as content media
    // meant a pinch that caught the Pin or Done icon zoomed the whole page.
    const button = document.createElement('button');
    button.style.touchAction = 'manipulation';
    const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    button.append(glyph);
    document.body.append(button);

    pinchTo('touchstart', START, glyph as unknown as Element);
    pinchTo('touchmove', OUT_ONE_STEP, glyph as unknown as Element);
    expect(attribute()).toBe('17');

    button.remove();
  });

  it('resizes on a decorative image icon, like a favicon or an avatar', () => {
    // `FeedFavicon` and `UserAvatar` are real <img> elements, so the content
    // selector catches them; both set `aria-hidden`, which is the signal that
    // they are chrome rather than something to magnify.
    const icon = document.createElement('img');
    icon.setAttribute('alt', '');
    icon.setAttribute('aria-hidden', 'true');
    document.body.append(icon);

    pinchTo('touchstart', START, icon);
    pinchTo('touchmove', OUT_ONE_STEP, icon);
    expect(attribute()).toBe('17');

    icon.remove();
  });

  it('still yields on a publisher image with an empty alt', () => {
    // `alt=""` is a normal way to publish an unlabeled photograph, and the
    // sanitizer passes `alt` through while dropping `aria-hidden` — so reading
    // it as "decorative" would classify real article images as chrome and take
    // their native zoom away.
    const photo = document.createElement('img');
    photo.setAttribute('alt', '');
    document.body.append(photo);

    pinchTo('touchstart', START, photo);
    pinchTo('touchmove', OUT_ONE_STEP, photo);
    expect(attribute()).toBeNull();

    photo.remove();
  });

  it('still yields on a decorative image that asks for native zoom', () => {
    // The opt-in outranks the decorative marker, so a chart drawn with
    // aria-hidden art can still hand the gesture to the browser.
    const chart = document.createElement('img');
    chart.setAttribute('aria-hidden', 'true');
    chart.setAttribute('data-native-zoom', '');
    document.body.append(chart);

    pinchTo('touchstart', START, chart);
    pinchTo('touchmove', OUT_ONE_STEP, chart);
    expect(attribute()).toBeNull();

    chart.remove();
  });

  it('still yields on an SVG that asks for native zoom', () => {
    // The opt-in is how a real diagram keeps the browser's magnifier.
    const chart = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chart.setAttribute('data-native-zoom', '');
    document.body.append(chart);

    pinchTo('touchstart', START, chart as unknown as Element);
    pinchTo('touchmove', OUT_ONE_STEP, chart as unknown as Element);
    expect(attribute()).toBeNull();

    chart.remove();
  });

  it('yields anywhere marked data-native-zoom', () => {
    const chart = document.createElement('div');
    chart.setAttribute('data-native-zoom', '');
    const inner = document.createElement('span');
    chart.append(inner);
    document.body.append(chart);

    pinchTo('touchstart', START, inner);
    pinchTo('touchmove', OUT_ONE_STEP, inner);
    expect(attribute()).toBeNull();

    chart.remove();
  });

  it('still claims a pinch on ordinary text', () => {
    const paragraph = document.createElement('p');
    document.body.append(paragraph);

    pinchTo('touchstart', START, paragraph);
    pinchTo('touchmove', OUT_ONE_STEP, paragraph);
    expect(attribute()).toBe('17');

    paragraph.remove();
  });

  it("cancels Safari's own zoom, which no viewport meta can", () => {
    // Fingers on the glass first: on iOS the second `touchstart` precedes
    // `gesturestart`, and that is what marks this a pinch the hook can answer.
    pinchTo('touchstart', START);
    const start = new Event('gesturestart', { cancelable: true });
    document.dispatchEvent(start);
    expect(start.defaultPrevented).toBe(true);
    const change = new Event('gesturechange', { cancelable: true });
    document.dispatchEvent(change);
    expect(change.defaultPrevented).toBe(true);
    fireTouch('touchend', []);
  });

  it("leaves a desktop trackpad pinch alone", () => {
    // macOS Safari fires `gesture*` for a trackpad pinch with no touch events
    // behind it. Nothing here can resize text from that, so preventing it would
    // remove the page zoom and give nothing back.
    const start = new Event('gesturestart', { cancelable: true });
    document.dispatchEvent(start);
    expect(start.defaultPrevented).toBe(false);
    const change = new Event('gesturechange', { cancelable: true });
    document.dispatchEvent(change);
    expect(change.defaultPrevented).toBe(false);
  });

  it('goes back to leaving the trackpad alone once the hand lifts', () => {
    // The flag must not outlive the touch interaction, or a trackpad pinch
    // after a touch pinch would be suppressed on a hybrid machine.
    pinchTo('touchstart', START);
    fireTouch('touchend', []);
    const start = new Event('gesturestart', { cancelable: true });
    document.dispatchEvent(start);
    expect(start.defaultPrevented).toBe(false);
  });

  it("leaves Safari's zoom alone on an image", () => {
    const img = document.createElement('img');
    document.body.append(img);
    pinchTo('touchstart', START, img);
    const start = new Event('gesturestart', { cancelable: true });
    Object.defineProperty(start, 'target', { value: img });
    document.dispatchEvent(start);
    expect(start.defaultPrevented).toBe(false);
    fireTouch('touchend', []);
    img.remove();
  });

  it("keeps Safari's zoom when only one finger is on the image", () => {
    // Safari targets a `GestureEvent` at the two fingers' common ancestor, so
    // a mixed-target pinch arrives here pointing at a plain wrapper. The touch
    // path already yielded on the image; re-deciding from that target alone
    // would kill the very zoom it yielded to.
    const wrapper = document.createElement('div');
    const img = document.createElement('img');
    const beside = document.createElement('span');
    wrapper.append(img, beside);
    document.body.append(wrapper);

    fireTouch('touchstart', [0, START], wrapper, [img, beside]);
    const start = new Event('gesturestart', { cancelable: true });
    // (fingers are down from the touchstart above)
    Object.defineProperty(start, 'target', { value: wrapper });
    document.dispatchEvent(start);
    expect(start.defaultPrevented).toBe(false);

    const change = new Event('gesturechange', { cancelable: true });
    Object.defineProperty(change, 'target', { value: wrapper });
    document.dispatchEvent(change);
    expect(change.defaultPrevented).toBe(false);

    wrapper.remove();
  });

  it('re-decides once the hand leaves the glass', () => {
    // The yield is held past the `touchend` that drops below two fingers, so a
    // trailing `gestureend`/`gesturechange` isn't cut off — but it must not
    // outlive the hand, or the next pinch on text would silently do nothing.
    const img = document.createElement('img');
    document.body.append(img);
    fireTouch('touchstart', [0, START], img);
    fireTouch('touchend', []);

    // A fresh pinch, on text this time: the yield must not have survived the
    // lift, so this one is suppressed.
    const paragraph = document.createElement('p');
    document.body.append(paragraph);
    pinchTo('touchstart', START, paragraph);
    const start = new Event('gesturestart', { cancelable: true });
    Object.defineProperty(start, 'target', { value: paragraph });
    document.dispatchEvent(start);
    expect(start.defaultPrevented).toBe(true);
    fireTouch('touchend', []);

    img.remove();
    paragraph.remove();
  });
});

describe('usePinchFontSize vs. single-pointer gestures', () => {
  beforeEach(() => {
    renderHook(() => usePinchFontSize());
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-font-size');
  });

  it('tells pointer gestures to stand down the moment it claims the pinch', () => {
    // The row swipe and pull-to-refresh track *pointer* events; this hook reads
    // *touch* events. `preventDefault()` here governs only the touch stream, and
    // the browser fires no `pointercancel` — so without the broadcast a pinch
    // spread horizontally across a row leaves that row's swipe still tracking
    // the first finger, and its release commits Done or Pin mid-resize.
    const canceled = vi.fn();
    const stop = onGestureCancel(canceled);
    pinchTo('touchstart', START);
    expect(canceled).toHaveBeenCalledTimes(1);
    stop();
  });

  it('leaves a one-finger gesture alone', () => {
    const canceled = vi.fn();
    const stop = onGestureCancel(canceled);
    fireTouch('touchstart', [0]);
    expect(canceled).not.toHaveBeenCalled();
    stop();
  });

  it('stands them down even for a pinch it declines to claim', () => {
    // The cases we decline are the ones nothing else rescues. A row declares
    // `touch-action: pan-y`, so on its thumbnail the browser will not take the
    // gesture over and never fires the `pointercancel` that would clear the
    // swipe — spreading two fingers there would still release as Done or Pin.
    const canceled = vi.fn();
    const stop = onGestureCancel(canceled);

    const img = document.createElement('img');
    document.body.append(img);
    pinchTo('touchstart', START, img);
    expect(canceled).toHaveBeenCalledTimes(1);
    fireTouch('touchend', []);
    img.remove();

    // Two fingers landing on the same spot are below the minimum start gap, so
    // no resize — but they are still not a swipe.
    pinchTo('touchstart', 8);
    expect(canceled).toHaveBeenCalledTimes(2);
    stop();
  });

  it('re-arms from the remaining two when a third finger lifts', () => {
    pinchTo('touchstart', START);
    pinchTo('touchmove', OUT_ONE_STEP);
    // Third finger arrives: the gesture banks at 17px.
    fireTouch('touchstart', [0, OUT_ONE_STEP, 300]);
    expect(stored()).toBe('17');
    // It lifts, leaving two. Those two must pick straight back up rather than
    // sitting inert until both leave the glass.
    fireTouch('touchend', [0, START]);
    pinchTo('touchmove', OUT_ONE_STEP);
    expect(attribute()).toBe('18');
    fireTouch('touchend', []);
    expect(stored()).toBe('18');
  });

  it('broadcasts once per gesture, not once per frame', () => {
    const canceled = vi.fn();
    const stop = onGestureCancel(canceled);
    pinchTo('touchstart', START);
    pinchTo('touchmove', OUT_ONE_STEP);
    pinchTo('touchmove', OUT_TWO_STEPS);
    expect(canceled).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('usePinchFontSize teardown', () => {
  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-font-size');
  });

  it('stops listening once unmounted', () => {
    const { unmount } = renderHook(() => usePinchFontSize());
    unmount();
    fireTouch('touchstart', [0, START]);
    const move = fireTouch('touchmove', [0, OUT_ONE_STEP]);
    expect(move.defaultPrevented).toBe(false);
    expect(document.documentElement.getAttribute('data-font-size')).toBeNull();
    const gesture = new Event('gesturestart', { cancelable: true });
    document.dispatchEvent(gesture);
    expect(gesture.defaultPrevented).toBe(false);
  });
});
