import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useSwipeToDismiss } from './useSwipeToDismiss';

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
  onSwipeRight?: () => void;
  onSwipeLeft?: () => void;
  onLongPress?: () => void;
  enabled?: boolean;
  onLinkClick?: () => void;
}

function Harness({
  onSwipeRight,
  onSwipeLeft,
  onLongPress,
  enabled,
  onLinkClick,
}: HarnessProps) {
  const { handlers, dragging, isDismissing, offset } = useSwipeToDismiss({
    onSwipeRight,
    onSwipeLeft,
    onLongPress,
    enabled,
  });
  return (
    <div
      data-testid="row"
      data-dragging={dragging ? 'true' : 'false'}
      data-dismissing={isDismissing ? 'true' : 'false'}
      data-offset={String(offset)}
      {...handlers}
    >
      <a
        href="#target"
        data-testid="inner-link"
        onClick={() => onLinkClick?.()}
      >
        link
      </a>
    </div>
  );
}

function mockRowWidth(width: number) {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    return {
      width,
      height: 72,
      top: 0,
      left: 0,
      right: width,
      bottom: 72,
      x: 0,
      y: 0,
      toJSON() {},
    } as DOMRect;
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

describe('useSwipeToDismiss', () => {
  let restoreRect: () => void;
  beforeEach(() => {
    restoreRect = mockRowWidth(300);
    Object.defineProperty(Element.prototype, 'setPointerCapture', {
      value: vi.fn(),
      configurable: true,
    });
  });
  afterEach(() => {
    restoreRect();
    vi.useRealTimers();
  });

  it('calls onSwipeRight after a rightward swipe past the threshold', () => {
    vi.useFakeTimers();
    const onSwipeRight = vi.fn();
    render(<Harness onSwipeRight={onSwipeRight} />);
    const row = screen.getByTestId('row');

    dispatch(row, 'pointerdown', 100, 100);
    dispatch(row, 'pointermove', 250, 105);
    dispatch(row, 'pointerup', 250, 105);

    expect(row.getAttribute('data-dismissing')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(onSwipeRight).toHaveBeenCalledTimes(1);
  });

  it('calls onSwipeLeft after a leftward swipe past the threshold', () => {
    vi.useFakeTimers();
    const onSwipeLeft = vi.fn();
    const onSwipeRight = vi.fn();
    render(
      <Harness onSwipeLeft={onSwipeLeft} onSwipeRight={onSwipeRight} />,
    );
    const row = screen.getByTestId('row');

    dispatch(row, 'pointerdown', 250, 100);
    dispatch(row, 'pointermove', 100, 105);
    dispatch(row, 'pointerup', 100, 105);

    expect(row.getAttribute('data-dismissing')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it('does not call a handler for a direction with no handler wired', () => {
    vi.useFakeTimers();
    const onSwipeRight = vi.fn();
    // Only onSwipeRight is wired; leftward swipe should snap back.
    render(<Harness onSwipeRight={onSwipeRight} />);
    const row = screen.getByTestId('row');

    dispatch(row, 'pointerdown', 250, 100);
    dispatch(row, 'pointermove', 100, 105);
    dispatch(row, 'pointerup', 100, 105);

    expect(row.getAttribute('data-dismissing')).toBe('false');
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(onSwipeRight).not.toHaveBeenCalled();
    expect(row.getAttribute('data-offset')).toBe('0');
  });

  it('snaps back (no call) when swipe is below the threshold', () => {
    vi.useFakeTimers();
    const onSwipeRight = vi.fn();
    render(<Harness onSwipeRight={onSwipeRight} />);
    const row = screen.getByTestId('row');

    dispatch(row, 'pointerdown', 100, 100);
    dispatch(row, 'pointermove', 140, 102);
    dispatch(row, 'pointerup', 140, 102);

    expect(row.getAttribute('data-dismissing')).toBe('false');
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(onSwipeRight).not.toHaveBeenCalled();
    expect(row.getAttribute('data-offset')).toBe('0');
  });

  it('ignores predominantly vertical motion (lets the page scroll)', () => {
    const onSwipeRight = vi.fn();
    render(<Harness onSwipeRight={onSwipeRight} />);
    const row = screen.getByTestId('row');

    dispatch(row, 'pointerdown', 100, 100);
    dispatch(row, 'pointermove', 115, 200);
    dispatch(row, 'pointerup', 115, 200);

    expect(row.getAttribute('data-dragging')).toBe('false');
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it('does nothing when disabled', () => {
    const onSwipeRight = vi.fn();
    render(<Harness onSwipeRight={onSwipeRight} enabled={false} />);
    const row = screen.getByTestId('row');

    dispatch(row, 'pointerdown', 100, 100);
    dispatch(row, 'pointermove', 260, 100);
    dispatch(row, 'pointerup', 260, 100);
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it('suppresses the synthetic click that follows a swipe', () => {
    const onSwipeRight = vi.fn();
    const onLinkClick = vi.fn();
    render(
      <Harness onSwipeRight={onSwipeRight} onLinkClick={onLinkClick} />,
    );
    const row = screen.getByTestId('row');
    const link = screen.getByTestId('inner-link');

    dispatch(row, 'pointerdown', 100, 100);
    dispatch(row, 'pointermove', 140, 100);
    dispatch(row, 'pointerup', 140, 100);
    fireEvent.click(link);
    expect(onLinkClick).not.toHaveBeenCalled();
  });

  it('allows a plain tap to go through', () => {
    const onLinkClick = vi.fn();
    render(<Harness onSwipeRight={vi.fn()} onLinkClick={onLinkClick} />);
    const row = screen.getByTestId('row');
    const link = screen.getByTestId('inner-link');

    dispatch(row, 'pointerdown', 100, 100);
    dispatch(row, 'pointerup', 100, 100);
    fireEvent.click(link);
    expect(onLinkClick).toHaveBeenCalledTimes(1);
  });

  it('fires onLongPress after the press is held past the threshold', () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    render(<Harness onLongPress={onLongPress} />);
    const row = screen.getByTestId('row');

    dispatch(row, 'pointerdown', 100, 100);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('suppresses the click that follows a long-press', () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const onLinkClick = vi.fn();
    render(
      <Harness onLongPress={onLongPress} onLinkClick={onLinkClick} />,
    );
    const row = screen.getByTestId('row');
    const link = screen.getByTestId('inner-link');

    dispatch(row, 'pointerdown', 100, 100);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    dispatch(row, 'pointerup', 100, 100);
    fireEvent.click(link);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLinkClick).not.toHaveBeenCalled();
  });

  it('cancels long-press if the pointer moves more than the tolerance', () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    render(<Harness onLongPress={onLongPress} onSwipeRight={vi.fn()} />);
    const row = screen.getByTestId('row');

    dispatch(row, 'pointerdown', 100, 100);
    dispatch(row, 'pointermove', 120, 100); // 20px > tolerance
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('does not fire long-press if pointerup happens before threshold', () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const onLinkClick = vi.fn();
    render(
      <Harness onLongPress={onLongPress} onLinkClick={onLinkClick} />,
    );
    const row = screen.getByTestId('row');
    const link = screen.getByTestId('inner-link');

    dispatch(row, 'pointerdown', 100, 100);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    dispatch(row, 'pointerup', 100, 100);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    fireEvent.click(link);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(onLinkClick).toHaveBeenCalledTimes(1);
  });

  it('prevents the context menu when a long-press handler is wired', () => {
    render(<Harness onLongPress={vi.fn()} />);
    const row = screen.getByTestId('row');
    const evt = new Event('contextmenu', { bubbles: true, cancelable: true });
    row.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
  });
});
