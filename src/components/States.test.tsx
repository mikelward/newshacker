import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmptyState, ErrorState, LoadingState } from './States';

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

describe('<LoadingState>', () => {
  it('exposes an accessible status with a default label', () => {
    render(<LoadingState />);
    const region = screen.getByRole('status');
    expect(region).toBeInTheDocument();
    expect(region).toHaveTextContent(/loading/i);
  });

  it('uses a custom label when provided', () => {
    render(<LoadingState label="Fetching stories…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Fetching stories…');
  });

  it('keeps the label visually hidden by default', () => {
    const { container } = render(<LoadingState label="Loading…" />);
    expect(container.querySelector('.state__sr-only')).toHaveTextContent(
      'Loading…',
    );
    expect(container.querySelector('.state__loading-label')).toBeNull();
  });

  it('renders the label as visible on-screen text when showLabel is set', () => {
    const { container } = render(<LoadingState label="Loading…" showLabel />);
    const visible = container.querySelector('.state__loading-label');
    expect(visible).toHaveTextContent('Loading…');
    expect(container.querySelector('.state__sr-only')).toBeNull();
  });
});
