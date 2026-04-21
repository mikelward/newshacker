import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { AppDrawer } from './AppDrawer';
import { renderWithProviders } from '../test/renderUtils';
import { THEME_STORAGE_KEY } from '../lib/theme';

describe('<AppDrawer>', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });
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
    expect(screen.getByRole('link', { name: 'Favorites' })).toHaveAttribute(
      'href',
      '/favorites',
    );
    expect(screen.getByRole('link', { name: 'Pinned' })).toHaveAttribute(
      'href',
      '/pinned',
    );
    expect(screen.getByRole('link', { name: 'Opened' })).toHaveAttribute(
      'href',
      '/opened',
    );
    expect(screen.getByRole('link', { name: 'Ignored' })).toHaveAttribute(
      'href',
      '/ignored',
    );
    expect(screen.getByRole('link', { name: 'Help' })).toHaveAttribute(
      'href',
      '/help',
    );
    expect(screen.getByRole('link', { name: 'About' })).toHaveAttribute(
      'href',
      '/about',
    );
    expect(screen.getByRole('link', { name: 'Debug' })).toHaveAttribute(
      'href',
      '/debug',
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

  it('exposes a theme radiogroup with System selected by default', () => {
    renderWithProviders(<AppDrawer open={true} onClose={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('switches the theme when a radio is clicked', () => {
    renderWithProviders(<AppDrawer open={true} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    fireEvent.click(screen.getByRole('radio', { name: 'System' }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('panel background follows the theme variable, not a hardcoded light color', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/components/AppDrawer.css'),
      'utf8',
    );
    const panelRule = css.match(/\.app-drawer__panel\s*\{[^}]*\}/);
    expect(panelRule, 'expected .app-drawer__panel rule').not.toBeNull();
    const block = panelRule![0];
    expect(block).toMatch(/background:\s*var\(--hn-bg\)/);
    expect(block).not.toMatch(/#f6f6ef/i);
  });
});
