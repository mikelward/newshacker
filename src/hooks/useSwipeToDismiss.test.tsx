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
  onDismiss: () => void;
  enabled?: boolean;
  onLinkClick?: () => void;
}

function Harness({ onDismiss, enabled, onLinkClick }: HarnessProps) {
  const { handlers, dragging, isDismissing, offset } = useSwipeToDismiss({
    onDismiss,
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

  it('calls onDismiss after a horizontal swipe past the threshold', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const row = screen.getByTestId('row');

    dispatch(row, 'pointerdown', 100, 100);
    dispatch(row, 'pointermove', 250, 105);
    dispatch(row, 'pointerup', 250, 105);

    expect(row.getAttribute('data-dismissing')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('snaps back (no dismiss) when swipe is below the threshold', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const row = screen.getByTestId('row');

    dispatch(row, 'pointerdown', 100, 100);
    dispatch(row, 'pointermove', 140, 102);
    dispatch(row, 'pointerup', 140, 102);

    expect(row.getAttribute('data-dismissing')).toBe('false');
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(row.getAttribute('data-offset')).toBe('0');
  });

  it('ignores predominantly vertical motion (lets the page scroll)', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const row = screen.getByTestId('row');

    dispatch(row, 'pointerdown', 100, 100);
    dispatch(row, 'pointermove', 115, 200);
    dispatch(row, 'pointerup', 115, 200);

    expect(row.getAttribute('data-dragging')).toBe('false');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('does nothing when disabled', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} enabled={false} />);
    const row = screen.getByTestId('row');

    dispatch(row, 'pointerdown', 100, 100);
    dispatch(row, 'pointermove', 260, 100);
    dispatch(row, 'pointerup', 260, 100);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('suppresses the synthetic click that follows a swipe', () => {
    const onDismiss = vi.fn();
    const onLinkClick = vi.fn();
    render(<Harness onDismiss={onDismiss} onLinkClick={onLinkClick} />);
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
    render(<Harness onDismiss={vi.fn()} onLinkClick={onLinkClick} />);
    const row = screen.getByTestId('row');
    const link = screen.getByTestId('inner-link');

    dispatch(row, 'pointerdown', 100, 100);
    dispatch(row, 'pointerup', 100, 100);
    fireEvent.click(link);
    expect(onLinkClick).toHaveBeenCalledTimes(1);
  });
});
