import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider } from './Toast';
import { useToast } from '../hooks/useToast';

function Trigger({
  onTrigger,
}: {
  onTrigger: (api: ReturnType<typeof useToast>) => void;
}) {
  const toast = useToast();
  return (
    <button data-testid="trigger" onClick={() => onTrigger(toast)}>
      go
    </button>
  );
}

describe('<ToastProvider>', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a toast message and auto-dismisses after the duration', () => {
    render(
      <ToastProvider>
        <Trigger
          onTrigger={(t) => t.showToast({ message: 'Saved', durationMs: 1000 })}
        />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByTestId('trigger'));
    expect(screen.getByText('Saved')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1001);
    });
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('fires onAction when the action button is clicked and hides the toast', () => {
    const onAction = vi.fn();
    render(
      <ToastProvider>
        <Trigger
          onTrigger={(t) =>
            t.showToast({
              message: 'Dismissed',
              actionLabel: 'Undo',
              onAction,
              durationMs: 10_000,
            })
          }
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByTestId('trigger'));
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Dismissed')).toBeNull();
  });

  it('replaces the current toast when a new one is shown', () => {
    render(
      <ToastProvider>
        <Trigger
          onTrigger={(t) => t.showToast({ message: 'First', durationMs: 5000 })}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByTestId('trigger'));
    expect(screen.getByText('First')).toBeInTheDocument();

    // Second toast replaces the first.
    render(
      <ToastProvider>
        <Trigger
          onTrigger={(t) => t.showToast({ message: 'Second', durationMs: 5000 })}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getAllByTestId('trigger')[1]);
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('stays put indefinitely when durationMs is Infinity', () => {
    render(
      <ToastProvider>
        <Trigger
          onTrigger={(t) =>
            t.showToast({
              message: 'New version available',
              durationMs: Number.POSITIVE_INFINITY,
            })
          }
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByTestId('trigger'));
    expect(screen.getByText('New version available')).toBeInTheDocument();

    // A sticky toast must survive an arbitrarily long idle; if the
    // timer fires we'd lose the update nudge without the user ever
    // seeing it.
    act(() => {
      vi.advanceTimersByTime(60 * 60 * 1000);
    });
    expect(screen.getByText('New version available')).toBeInTheDocument();
  });

  it('useToast() is a safe no-op with no provider', () => {
    let caught: unknown = null;
    function Consumer() {
      const toast = useToast();
      try {
        toast.showToast({ message: 'no-op' });
      } catch (e) {
        caught = e;
      }
      return null;
    }
    expect(() => render(<Consumer />)).not.toThrow();
    expect(caught).toBeNull();
  });
});
