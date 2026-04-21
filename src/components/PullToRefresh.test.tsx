import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { PullToRefresh, PULL_TO_REFRESH_TRIGGER_PX } from './PullToRefresh';

function dispatch(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
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

describe('<PullToRefresh>', () => {
  beforeEach(() => {
    Object.defineProperty(Element.prototype, 'setPointerCapture', {
      value: vi.fn(),
      configurable: true,
    });
    Object.defineProperty(window, 'scrollY', {
      value: 0,
      configurable: true,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders its children', () => {
    render(
      <PullToRefresh onRefresh={() => {}}>
        <div data-testid="child">hello</div>
      </PullToRefresh>,
    );
    expect(screen.getByTestId('child')).toHaveTextContent('hello');
  });

  it('invokes onRefresh when a pull crosses the trigger threshold', () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    render(
      <PullToRefresh onRefresh={onRefresh}>
        <div data-testid="child">feed</div>
      </PullToRefresh>,
    );
    const wrap = screen.getByTestId('pull-to-refresh');

    dispatch(wrap, 'pointerdown', 100, 100);
    dispatch(
      wrap,
      'pointermove',
      100,
      100 + PULL_TO_REFRESH_TRIGGER_PX * 2 + 20,
    );
    dispatch(
      wrap,
      'pointerup',
      100,
      100 + PULL_TO_REFRESH_TRIGGER_PX * 2 + 20,
    );

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(wrap.getAttribute('data-phase')).toBe('refreshing');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(wrap.getAttribute('data-phase')).toBe('idle');
  });

  it('exposes an accessible status label for the indicator', () => {
    render(
      <PullToRefresh onRefresh={() => {}}>
        <div>feed</div>
      </PullToRefresh>,
    );
    // Role=status means the spinner area is an aria-live polite region
    // so screen readers announce refresh state changes.
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
