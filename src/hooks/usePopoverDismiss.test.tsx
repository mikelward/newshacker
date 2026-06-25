import { act, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePopoverDismiss } from './usePopoverDismiss';

// A minimal consumer: open by default, with an "inside" region the hook must
// not dismiss on. `dismiss` is called whenever the hook asks to close, and the
// marker disappears so tests can assert the open/closed state.
function Harness({
  dismiss,
  dismissOnOutsidePress,
}: {
  dismiss: () => void;
  dismissOnOutsidePress?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const insideRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss({
    open,
    onDismiss: () => {
      setOpen(false);
      dismiss();
    },
    isInside: (target) => !!insideRef.current?.contains(target),
    dismissOnOutsidePress,
  });
  return (
    <div ref={insideRef} data-testid="inside">
      <button data-testid="inside-btn">in</button>
      {open ? <span data-testid="marker" /> : null}
    </div>
  );
}

const cleanups: Array<() => void> = [];
function makeOutside() {
  const el = document.createElement('button');
  const onClick = vi.fn();
  el.addEventListener('click', onClick);
  document.body.appendChild(el);
  cleanups.push(() => document.body.removeChild(el));
  return { el, onClick };
}
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const pointerDown = () => new MouseEvent('pointerdown', { bubbles: true });
const click = () =>
  new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });

describe('usePopoverDismiss', () => {
  it('dismisses on an outside press and swallows that gesture’s trailing click', () => {
    const dismiss = vi.fn();
    const { onClick, el } = makeOutside();
    render(<Harness dismiss={dismiss} />);
    act(() => {
      el.dispatchEvent(pointerDown());
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('marker')).toBeNull();
    const c = click();
    act(() => {
      el.dispatchEvent(c);
    });
    expect(onClick).not.toHaveBeenCalled();
    expect(c.defaultPrevented).toBe(true);
  });

  it('stops the dismissing press from reaching a pointerdown-activated control', () => {
    const dismiss = vi.fn();
    const { el } = makeOutside();
    // A control that does work on pointerdown itself (e.g. a drag handle).
    const onOutsidePointerDown = vi.fn();
    el.addEventListener('pointerdown', onOutsidePointerDown);
    render(<Harness dismiss={dismiss} />);
    act(() => {
      el.dispatchEvent(pointerDown());
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
    // The press dismissed the popover but must NOT have reached the control —
    // otherwise it would both dismiss and act on the same press.
    expect(onOutsidePointerDown).not.toHaveBeenCalled();
  });

  it('does not dismiss on a press inside the popover region', () => {
    const dismiss = vi.fn();
    render(<Harness dismiss={dismiss} />);
    act(() => {
      screen.getByTestId('inside-btn').dispatchEvent(pointerDown());
    });
    expect(dismiss).not.toHaveBeenCalled();
    expect(screen.getByTestId('marker')).toBeInTheDocument();
  });

  it('dismisses on Escape', () => {
    const dismiss = vi.fn();
    render(<Harness dismiss={dismiss} />);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses but does not swallow when the press is a non-primary button', () => {
    const dismiss = vi.fn();
    const { onClick, el } = makeOutside();
    render(<Harness dismiss={dismiss} />);
    act(() => {
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 2 }));
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
    const c = click();
    act(() => {
      el.dispatchEvent(c);
    });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(c.defaultPrevented).toBe(false);
  });

  it('does not swallow a keyboard-activated click (detail 0)', () => {
    const dismiss = vi.fn();
    const { onClick, el } = makeOutside();
    render(<Harness dismiss={dismiss} />);
    act(() => {
      el.dispatchEvent(pointerDown());
    });
    const kb = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      detail: 0,
    });
    act(() => {
      el.dispatchEvent(kb);
    });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(kb.defaultPrevented).toBe(false);
  });

  it('when dismissOnOutsidePress is false, ignores outside presses but still closes on Escape', () => {
    const dismiss = vi.fn();
    const { el } = makeOutside();
    render(<Harness dismiss={dismiss} dismissOnOutsidePress={false} />);
    act(() => {
      el.dispatchEvent(pointerDown());
    });
    expect(dismiss).not.toHaveBeenCalled();
    expect(screen.getByTestId('marker')).toBeInTheDocument();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});
