import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { AppDrawer } from './AppDrawer';
import { renderWithProviders } from '../test/renderUtils';
import { THEME_STORAGE_KEY } from '../lib/theme';
import { CHROME_STORAGE_KEY } from '../lib/chrome';

describe('<AppDrawer>', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-chrome');
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-chrome');
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
    expect(screen.getByRole('link', { name: 'Hot' })).toHaveAttribute(
      'href',
      '/hot',
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
    expect(screen.getByRole('link', { name: 'Hidden' })).toHaveAttribute(
      'href',
      '/hidden',
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

  it('lists Hot between Top and New in the Feeds section', () => {
    // SPEC.md *Story feeds → /hot* slots /hot in right after Top
    // so it sits next to the closest-related feed. Pin the
    // ordering: drawer-side, the user should see Top → Hot → New.
    renderWithProviders(<AppDrawer open={true} onClose={() => {}} />);
    const feedLabels = ['Top', 'Hot', 'New', 'Best', 'Ask', 'Show', 'Jobs'];
    const links = feedLabels.map((label) =>
      screen.getByRole('link', { name: label }),
    );
    for (let i = 1; i < links.length; i++) {
      expect(
        links[i - 1].compareDocumentPosition(links[i]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
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

  it('renders a visible "Theme" section heading above the mode + theme rows', () => {
    renderWithProviders(<AppDrawer open={true} onClose={() => {}} />);
    // Plain <div class="__section-title">, not a heading element — just
    // visible text above the two segmented rows. Pin its presence so a
    // refactor doesn't silently drop it (as happened once already).
    expect(screen.getByText('Theme')).toBeInTheDocument();
  });

  it('exposes a mode radiogroup with System selected by default', () => {
    renderWithProviders(<AppDrawer open={true} onClose={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: 'Mode' });
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

  it('switches the mode when a radio is clicked', () => {
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

  it('exposes a theme radiogroup with Mono selected by default', () => {
    renderWithProviders(<AppDrawer open={true} onClose={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Mono' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'Duo' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('radio', { name: 'Classic' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('switches the theme when a radio is clicked', () => {
    renderWithProviders(<AppDrawer open={true} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('radio', { name: 'Duo' }));
    expect(window.localStorage.getItem(CHROME_STORAGE_KEY)).toBe('duo');
    expect(document.documentElement.getAttribute('data-chrome')).toBe('duo');
    expect(screen.getByRole('radio', { name: 'Duo' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Classic' }));
    expect(window.localStorage.getItem(CHROME_STORAGE_KEY)).toBe('classic');
    expect(document.documentElement.getAttribute('data-chrome')).toBe(
      'classic',
    );

    // Selecting Mono clears both the stored value and the attribute,
    // returning to the shipping baseline (painted by base CSS with no
    // `data-chrome` override).
    fireEvent.click(screen.getByRole('radio', { name: 'Mono' }));
    expect(window.localStorage.getItem(CHROME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute('data-chrome')).toBe(false);
  });

  it('panel background follows the theme variable, not a hardcoded light color', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/components/AppDrawer.css'),
      'utf8',
    );
    const panelRule = css.match(/\.app-drawer__panel\s*\{[^}]*\}/);
    expect(panelRule, 'expected .app-drawer__panel rule').not.toBeNull();
    const block = panelRule![0];
    expect(block).toMatch(/background:\s*var\(--nh-bg\)/);
    expect(block).not.toMatch(/#f6f6ef/i);
  });
});
