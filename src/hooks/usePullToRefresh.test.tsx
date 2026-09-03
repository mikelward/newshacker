import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import {
  PULL_TO_REFRESH_TRIGGER_PX,
  usePullToRefresh,
} from './usePullToRefresh';
import { cancelPointerGestures } from '../lib/gestureCancel';

function dispatch(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  clientX: number,
  clientY: number,
) {
  const evt = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(evt, {
    pointerId: 1,
    pointerType: 'touch',
    clientX,
    clientY,
    button: 0,
    isPrimary: true,
  });
  act(() => {
    target.dispatchEvent(evt);
  });
}

interface HarnessProps {
  onRefresh: () => void | Promise<unknown>;
  enabled?: boolean;
  atTop?: boolean;
}

function Harness({ onRefresh, enabled, atTop = true }: HarnessProps) {
  const { phase, pull, progress, handlers } = usePullToRefresh({
    onRefresh,
    enabled,
    isAtTop: () => atTop,
  });
  return (
    <div
      data-testid="ptr"
      data-phase={phase}
      data-pull={String(pull)}
      data-progress={progress.toFixed(2)}
      {...handlers}
    />
  );
}

describe('usePullToRefresh', () => {
  beforeEach(() => {
    Object.defineProperty(Element.prototype, 'setPointerCapture', {
      value: vi.fn(),
      configurable: true,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('abandons a pull armed in the same tick a pinch claims the fingers', () => {
    // The race: the second finger lands just as the first crosses the arm
    // threshold. `setPhase('pulling')` is queued but the effect that syncs
    // `phaseRef` has not run, so a cancel handler that trusts the ref alone
    // reads `idle`, clears the tracked pointer, and skips the reset — leaving
    // the queued `pulling` painted with nothing left to finish it.
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    const el = screen.getByTestId('ptr');

    dispatch(el, 'pointerdown', 100, 100);
    // Arm and cancel inside one act(), so no effect flushes between them.
    act(() => {
      const evt = new Event('pointermove', { bubbles: true, cancelable: true });
      Object.assign(evt, {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 100,
        clientY: 200,
        button: 0,
        isPrimary: true,
      });
      el.dispatchEvent(evt);
      cancelPointerGestures();
    });

    expect(el.dataset.phase).toBe('idle');
    expect(el.dataset.pull).toBe('0');
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('fires onRefresh when a downward pull crosses the trigger distance', () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    const el = screen.getByTestId('ptr');

    dispatch(el, 'pointerdown', 100, 100);
    // Far enough below trigger (after 0.5 resistance + 8px start
    // threshold) to commit.
    dispatch(el, 'pointermove', 100, 100 + PULL_TO_REFRESH_TRIGGER_PX * 2 + 20);
    expect(el.getAttribute('data-phase')).toBe('pulling');
    dispatch(el, 'pointerup', 100, 100 + PULL_TO_REFRESH_TRIGGER_PX * 2 + 20);

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(el.getAttribute('data-phase')).toBe('refreshing');

    // Settle transition completes.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(el.getAttribute('data-phase')).toBe('idle');
  });

  it('does not fire onRefresh if the pull is released below the trigger', () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    const el = screen.getByTestId('ptr');

    dispatch(el, 'pointerdown', 100, 100);
    // Small pull: 20px raw after 8px start threshold = 12px, *0.5 = 6px
    // displayed, well below the trigger.
    dispatch(el, 'pointermove', 100, 120);
    dispatch(el, 'pointerup', 100, 120);

    expect(onRefresh).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(el.getAttribute('data-phase')).toBe('idle');
  });

  it('ignores the gesture if the document is not scrolled to the top', () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} atTop={false} />);
    const el = screen.getByTestId('ptr');

    dispatch(el, 'pointerdown', 100, 100);
    dispatch(el, 'pointermove', 100, 400);
    dispatch(el, 'pointerup', 100, 400);

    expect(onRefresh).not.toHaveBeenCalled();
    expect(el.getAttribute('data-phase')).toBe('idle');
  });

  it('aborts on predominantly horizontal motion (lets swipe own it)', () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    const el = screen.getByTestId('ptr');

    dispatch(el, 'pointerdown', 100, 100);
    dispatch(el, 'pointermove', 200, 110);
    dispatch(el, 'pointerup', 200, 110);

    expect(onRefresh).not.toHaveBeenCalled();
    expect(el.getAttribute('data-phase')).toBe('idle');
  });

  it('aborts on upward motion (normal scroll-up intent)', () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    const el = screen.getByTestId('ptr');

    dispatch(el, 'pointerdown', 100, 100);
    dispatch(el, 'pointermove', 100, 50);
    dispatch(el, 'pointerup', 100, 50);

    expect(onRefresh).not.toHaveBeenCalled();
    expect(el.getAttribute('data-phase')).toBe('idle');
  });

  it('keeps the spinner up until the async onRefresh resolves', async () => {
    vi.useFakeTimers();
    let resolveFn!: () => void;
    const onRefresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFn = resolve;
        }),
    );
    render(<Harness onRefresh={onRefresh} />);
    const el = screen.getByTestId('ptr');

    dispatch(el, 'pointerdown', 100, 100);
    dispatch(el, 'pointermove', 100, 100 + PULL_TO_REFRESH_TRIGGER_PX * 2 + 20);
    dispatch(el, 'pointerup', 100, 100 + PULL_TO_REFRESH_TRIGGER_PX * 2 + 20);

    expect(el.getAttribute('data-phase')).toBe('refreshing');

    // Even after the minimum spin window, we're still refreshing
    // because the promise hasn't resolved.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(el.getAttribute('data-phase')).toBe('refreshing');

    // Resolve the pending refresh.
    await act(async () => {
      resolveFn();
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(el.getAttribute('data-phase')).toBe('idle');
  });

  it('does nothing when disabled', () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} enabled={false} />);
    const el = screen.getByTestId('ptr');

    dispatch(el, 'pointerdown', 100, 100);
    dispatch(el, 'pointermove', 100, 400);
    dispatch(el, 'pointerup', 100, 400);

    expect(onRefresh).not.toHaveBeenCalled();
    expect(el.getAttribute('data-phase')).toBe('idle');
  });

  it('resets to idle on pointercancel mid-pull', () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    const el = screen.getByTestId('ptr');

    dispatch(el, 'pointerdown', 100, 100);
    dispatch(el, 'pointermove', 100, 140);
    expect(el.getAttribute('data-phase')).toBe('pulling');
    dispatch(el, 'pointercancel', 100, 140);
    expect(onRefresh).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(el.getAttribute('data-phase')).toBe('idle');
  });
});
