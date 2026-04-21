import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { TooltipButton } from './TooltipButton';

type PointerType = 'touch' | 'pen' | 'mouse';

function dispatch(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  opts: {
    clientX?: number;
    clientY?: number;
    pointerId?: number;
    pointerType?: PointerType;
  } = {},
) {
  const evt = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(evt, {
    pointerId: opts.pointerId ?? 1,
    pointerType: opts.pointerType ?? 'touch',
    clientX: opts.clientX ?? 0,
    clientY: opts.clientY ?? 0,
    button: 0,
    isPrimary: true,
  });
  act(() => {
    target.dispatchEvent(evt);
  });
  return evt;
}

function mockRect(el: Element, rect: Partial<DOMRect>) {
  const defaults = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON() {},
  };
  const full: DOMRect = { ...defaults, ...rect } as DOMRect;
  const original = el.getBoundingClientRect;
  el.getBoundingClientRect = () => full;
  return () => {
    el.getBoundingClientRect = original;
  };
}

describe('TooltipButton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the button with children and passes through native props', () => {
    render(
      <TooltipButton
        tooltip="Pin"
        aria-label="Pin story"
        data-testid="btn"
        disabled
      >
        <span>icon</span>
      </TooltipButton>,
    );
    const btn = screen.getByTestId('btn');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveAttribute('aria-label', 'Pin story');
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent('icon');
  });

  it('sets title to the tooltip so desktop hover shows the same copy', () => {
    render(
      <TooltipButton tooltip="Dismiss unpinned" data-testid="btn">
        x
      </TooltipButton>,
    );
    expect(screen.getByTestId('btn')).toHaveAttribute(
      'title',
      'Dismiss unpinned',
    );
  });

  it('lets the consumer override title while keeping the tooltip text', () => {
    render(
      <TooltipButton tooltip="Pin" title="Pin (custom)" data-testid="btn">
        x
      </TooltipButton>,
    );
    expect(screen.getByTestId('btn')).toHaveAttribute('title', 'Pin (custom)');
  });

  it('does NOT show the tooltip for mouse input (desktop hover uses title)', () => {
    render(
      <TooltipButton tooltip="Pin" data-testid="btn">
        x
      </TooltipButton>,
    );
    const btn = screen.getByTestId('btn');
    dispatch(btn, 'pointerdown', { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('does NOT show the tooltip on a short touch tap', () => {
    const onClick = vi.fn();
    render(
      <TooltipButton tooltip="Pin" data-testid="btn" onClick={onClick}>
        x
      </TooltipButton>,
    );
    const btn = screen.getByTestId('btn');
    dispatch(btn, 'pointerdown', { pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    dispatch(btn, 'pointerup', { pointerType: 'touch' });
    act(() => {
      btn.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows the tooltip after a 500ms long-press on touch', () => {
    render(
      <TooltipButton tooltip="Dismiss unpinned" data-testid="btn">
        x
      </TooltipButton>,
    );
    const btn = screen.getByTestId('btn');
    const restore = mockRect(btn, {
      top: 100,
      left: 40,
      width: 48,
      height: 48,
      right: 88,
      bottom: 148,
    });
    dispatch(btn, 'pointerdown', { pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Dismiss unpinned');
    // Portaled under document.body so it isn't trapped in narrow parents.
    expect(tip.parentElement).toBe(document.body);
    expect(btn).toHaveAttribute('aria-describedby', tip.id);
    restore();
  });

  it('hides the tooltip after the duration elapses', () => {
    render(
      <TooltipButton tooltip="Pin" data-testid="btn" tooltipDurationMs={1000}>
        x
      </TooltipButton>,
    );
    const btn = screen.getByTestId('btn');
    dispatch(btn, 'pointerdown', { pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('cancels the tooltip when the pointer moves beyond the tolerance', () => {
    render(
      <TooltipButton tooltip="Pin" data-testid="btn">
        x
      </TooltipButton>,
    );
    const btn = screen.getByTestId('btn');
    dispatch(btn, 'pointerdown', {
      pointerType: 'touch',
      clientX: 10,
      clientY: 10,
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    dispatch(btn, 'pointermove', {
      pointerType: 'touch',
      clientX: 60,
      clientY: 10,
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('cancels the tooltip when the pointer is released before the delay', () => {
    render(
      <TooltipButton tooltip="Pin" data-testid="btn">
        x
      </TooltipButton>,
    );
    const btn = screen.getByTestId('btn');
    dispatch(btn, 'pointerdown', { pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    dispatch(btn, 'pointerup', { pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('swallows the click that follows a long-press so the action does not fire', () => {
    const onClick = vi.fn();
    render(
      <TooltipButton tooltip="Pin" data-testid="btn" onClick={onClick}>
        x
      </TooltipButton>,
    );
    const btn = screen.getByTestId('btn');
    dispatch(btn, 'pointerdown', { pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    dispatch(btn, 'pointerup', { pointerType: 'touch' });
    act(() => {
      btn.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('prevents the synthetic contextmenu while a long-press is pending', () => {
    render(
      <TooltipButton tooltip="Pin" data-testid="btn">
        x
      </TooltipButton>,
    );
    const btn = screen.getByTestId('btn');
    dispatch(btn, 'pointerdown', { pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const ctx = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      btn.dispatchEvent(ctx);
    });
    expect(ctx.defaultPrevented).toBe(true);
  });

  it('hides the tooltip on pointercancel', () => {
    render(
      <TooltipButton tooltip="Pin" data-testid="btn">
        x
      </TooltipButton>,
    );
    const btn = screen.getByTestId('btn');
    dispatch(btn, 'pointerdown', { pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    dispatch(btn, 'pointercancel', { pointerType: 'touch' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('still invokes the consumer pointer handlers', () => {
    const onPointerDown = vi.fn();
    const onPointerUp = vi.fn();
    render(
      <TooltipButton
        tooltip="Pin"
        data-testid="btn"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      >
        x
      </TooltipButton>,
    );
    const btn = screen.getByTestId('btn');
    dispatch(btn, 'pointerdown', { pointerType: 'touch' });
    dispatch(btn, 'pointerup', { pointerType: 'touch' });
    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(onPointerUp).toHaveBeenCalledTimes(1);
  });
});
