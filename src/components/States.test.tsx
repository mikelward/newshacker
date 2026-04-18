import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmptyState, ErrorState } from './States';

describe('<ErrorState>', () => {
  it('shows message and fires onRetry when clicked', async () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Broken" onRetry={onRetry} />);
    expect(screen.getByTestId('error-state')).toHaveTextContent('Broken');
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('hides the retry button when no handler is given', () => {
    render(<ErrorState message="Broken" />);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('uses role=alert for a11y', () => {
    render(<ErrorState message="x" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('<EmptyState>', () => {
  it('shows the message', () => {
    render(<EmptyState message="Nothing yet" />);
    expect(screen.getByTestId('empty-state')).toHaveTextContent('Nothing yet');
  });
});
