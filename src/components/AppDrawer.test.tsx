import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { AppDrawer } from './AppDrawer';
import { renderWithProviders } from '../test/renderUtils';

describe('<AppDrawer>', () => {
  it('renders nothing when closed', () => {
    renderWithProviders(<AppDrawer open={false} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders feed links and library links when open', () => {
    renderWithProviders(<AppDrawer open={true} onClose={() => {}} />);
    expect(screen.getByRole('link', { name: 'Top' })).toHaveAttribute(
      'href',
      '/top',
    );
    expect(screen.getByRole('link', { name: 'New' })).toHaveAttribute(
      'href',
      '/new',
    );
    expect(screen.getByRole('link', { name: 'Opened' })).toHaveAttribute(
      'href',
      '/opened',
    );
    expect(screen.getByRole('link', { name: 'Ignored' })).toHaveAttribute(
      'href',
      '/ignored',
    );
    expect(screen.getByRole('link', { name: 'About' })).toHaveAttribute(
      'href',
      '/about',
    );
  });

  it('calls onClose when the scrim is clicked', () => {
    const onClose = vi.fn();
    const { container } = renderWithProviders(
      <AppDrawer open={true} onClose={onClose} />,
    );
    const scrim = container.querySelector('.app-drawer__scrim');
    expect(scrim).not.toBeNull();
    fireEvent.click(scrim!);
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when the in-panel close (X) button is clicked', () => {
    const onClose = vi.fn();
    renderWithProviders(<AppDrawer open={true} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('drawer-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    renderWithProviders(<AppDrawer open={true} onClose={onClose} />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalled();
  });
});
