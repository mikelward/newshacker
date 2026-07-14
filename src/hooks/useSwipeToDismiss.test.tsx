import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useSwipeToDismiss } from './useSwipeToDismiss';

function dispatch(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  clientX: number,
  clientY: number,
  opts: { pointerId?: number; pointerType?: string; buttons?: number } = {},
) {
  const evt = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(evt, {
    pointerId: opts.pointerId ?? 1,
    pointerType: opts.pointerType ?? 'touch',
    // A held touch/mouse press reports buttons=1; a button-less hover move
    // reports 0. Default to 1 so ordinary gestures behave like a real press.
    buttons: opts.buttons ?? 1,
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
  onButtonClick?: () => void;
}

function Harness({
  onSwipeRight,
  onSwipeLeft,
  onLongPress,
  enabled,
  onLinkClick,
  onButtonClick,
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
      <button
        type="button"
        data-testid="inner-button"
        onClick={() => onButtonClick?.()}
      >
        action
      </button>
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

  // Boundary tests pinning the lighter commit threshold. On the default 300px
  // row (mockRowWidth above) the threshold is max(SWIPE_MIN_PX 48, 300·0.2) =
  // 60px. Both cases sit in the 60–75px band, so they'd behave the opposite way
  // under the old max(56, 25%) = 75px threshold — guarding against a silent
  // revert of the lighter feel.
  it('commits a swipe just past the lighter threshold (would snap back under the old 75px)', () => {
    vi.useFakeTimers();
    const onSwipeRight = vi.fn();
    render(<Harness onSwipeRight={onSwipeRight} />);
    const row = screen.getByTestId('row');

    // 65px right of start: ≥ new 60px threshold, < old 75px.
    dispatch(row, 'pointerdown', 100, 100);
    dispatch(row, 'pointermove', 165, 105);
    dispatch(row, 'pointerup', 165, 105);

    expect(row.getAttribute('data-dismissing')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(onSwipeRight).toHaveBeenCalledTimes(1);
  });

  it('snaps back below the lighter threshold (no commit)', () => {
    vi.useFakeTimers();
    const onSwipeRight = vi.fn();
    render(<Harness onSwipeRight={onSwipeRight} />);
    const row = screen.getByTestId('row');

    // 55px right of start: < new 60px threshold, so the swipe does not commit.
    dispatch(row, 'pointerdown', 100, 100);
    dispatch(row, 'pointermove', 155, 105);
    dispatch(row, 'pointerup', 155, 105);

    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(onSwipeRight).not.toHaveBeenCalled();
    expect(row.getAttribute('data-dismissing')).toBe('false');
    expect(row.getAttribute('data-offset')).toBe('0');
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

  // Regression guard for the "make swipes a little easier to activate"
  // tuning. On a 300px row, max(SWIPE_MIN_PX, width * SWIPE_RATIO)
  // must stay ≤ 80px so a modest 80px drag still commits. If a future
  // change tightens the thresholds back to the old 105px commit, this
  // test fails loudly instead of quietly regressing the feel.
  it('commits on a modest 80px swipe (looser threshold)', () => {
    vi.useFakeTimers();
    const onSwipeRight = vi.fn();
    render(<Harness onSwipeRight={onSwipeRight} />);
    const row = screen.getByTestId('row');

    dispatch(row, 'pointerdown', 100, 100);
    dispatch(row, 'pointermove', 180, 102);
    dispatch(row, 'pointerup', 180, 102);

    expect(row.getAttribute('data-dismissing')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(onSwipeRight).toHaveBeenCalledTimes(1);
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

  it('ignores a second finger mid-swipe so the first gesture still commits', () => {
    // Regression: a second finger's pointerdown mid-swipe overwrote the
    // in-flight gesture's start state, so the first finger's release was
    // ignored and its swipe silently dropped.
    vi.useFakeTimers();
    const onSwipeRight = vi.fn();
    render(<Harness onSwipeRight={onSwipeRight} />);
    const row = screen.getByTestId('row');

    dispatch(row, 'pointerdown', 100, 100, { pointerId: 1 });
    dispatch(row, 'pointermove', 250, 105, { pointerId: 1 });
    // A second finger touches down and lifts mid-swipe — it must not clobber
    // finger 1's start state.
    dispatch(row, 'pointerdown', 50, 200, { pointerId: 2 });
    dispatch(row, 'pointerup', 50, 200, { pointerId: 2 });
    // Finger 1 releases past the threshold; its swipe must still commit.
    dispatch(row, 'pointerup', 250, 105, { pointerId: 1 });

    expect(row.getAttribute('data-dismissing')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(onSwipeRight).toHaveBeenCalledTimes(1);
  });

  it('drops a stale mouse start when a later move reports no buttons held', () => {
    // A mouse press released OUTSIDE the row delivers no pointerup (capture is
    // only taken once a swipe arms), so the start state goes stale. Since a
    // mouse reuses one pointerId for the whole session, the next button-less
    // hover-move must drop the stale start instead of dragging the row.
    const onSwipeRight = vi.fn();
    const onLinkClick = vi.fn();
    render(<Harness onSwipeRight={onSwipeRight} onLinkClick={onLinkClick} />);
    const row = screen.getByTestId('row');
    const link = screen.getByTestId('inner-link');

    dispatch(row, 'pointerdown', 100, 100, { pointerType: 'mouse', buttons: 1 });
    dispatch(row, 'pointermove', 400, 100, { pointerType: 'mouse', buttons: 0 });
    // The stale start was dropped, so no drag armed…
    expect(row.getAttribute('data-dragging')).toBe('false');
    // …and a later plain click goes through instead of being eaten as a swipe.
    fireEvent.click(link);
    expect(onLinkClick).toHaveBeenCalledTimes(1);
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it('lets a tap on an action button through even when a swipe just armed', () => {
    // The click-capture guard cancels an accidental row-BODY activation at the
    // tail of a swipe — but it must not eat a deliberate tap on an action
    // button, or the next button press would be a silent no-op.
    vi.useFakeTimers();
    const onButtonClick = vi.fn();
    render(
      <Harness
        onSwipeRight={vi.fn()}
        onLongPress={vi.fn()}
        onButtonClick={onButtonClick}
      />,
    );
    const row = screen.getByTestId('row');
    const button = screen.getByTestId('inner-button');

    // A below-threshold horizontal scrub arms `justSwiped` yet snaps back.
    dispatch(row, 'pointerdown', 100, 100);
    dispatch(row, 'pointermove', 112, 100);
    dispatch(row, 'pointerup', 112, 100);

    fireEvent.click(button);
    expect(onButtonClick).toHaveBeenCalledTimes(1);
  });
});
