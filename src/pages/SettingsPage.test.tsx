import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { SettingsPage } from './SettingsPage';
import { renderWithProviders } from '../test/renderUtils';

function resetAppearance() {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-chrome');
  document.documentElement.removeAttribute('data-font-size');
}

describe('<SettingsPage>', () => {
  beforeEach(() => {
    resetAppearance();
    // The Connected-apps section calls useAuth → /api/me. Stub it to a fast
    // 401 so these appearance/reading tests stay logged-out and never open a
    // real socket (the section stays hidden for a logged-out user).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 })),
    );
  });
  afterEach(() => {
    resetAppearance();
    vi.unstubAllGlobals();
  });

  it('renders the title and section headings', () => {
    renderWithProviders(<SettingsPage />, { route: '/settings' });
    expect(
      screen.getByRole('heading', { level: 1, name: /settings/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: /appearance/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: /reading/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: /hot rule/i }),
    ).toBeInTheDocument();
  });

  it('mirrors the appearance pickers with the stored values selected', () => {
    renderWithProviders(<SettingsPage />, { route: '/settings' });
    // Defaults: System mode, Mono app-bar, Medium text size.
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'Mono' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'Medium' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('changes appearance settings and persists them', () => {
    renderWithProviders(<SettingsPage />, { route: '/settings' });

    act(() => {
      fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    });
    expect(window.localStorage.getItem('newshacker:theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    act(() => {
      fireEvent.click(screen.getByRole('radio', { name: 'Large' }));
    });
    expect(window.localStorage.getItem('newshacker:font-size')).toBe('large');
    expect(document.documentElement.getAttribute('data-font-size')).toBe(
      'large',
    );
  });

  it('mirrors the Home feed picker (Top default) and persists changes', () => {
    renderWithProviders(<SettingsPage />, { route: '/settings' });
    expect(
      screen.getByRole('radio', { name: 'Home shows Top' }),
    ).toHaveAttribute('aria-checked', 'true');

    act(() => {
      fireEvent.click(screen.getByRole('radio', { name: 'Home shows Hot' }));
    });
    expect(window.localStorage.getItem('newshacker:homeFeed')).toBe('hot');
    expect(
      screen.getByRole('radio', { name: 'Home shows Hot' }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('Reading toggles default to off and persist when flipped', () => {
    renderWithProviders(<SettingsPage />, { route: '/settings' });
    const hide = screen.getByRole('checkbox', {
      name: /hide stories as you scroll past/i,
    });
    const sticky = screen.getByRole('checkbox', {
      name: /sticky bottom toolbar/i,
    });
    expect(hide).not.toBeChecked();
    expect(sticky).not.toBeChecked();

    act(() => {
      fireEvent.click(hide);
    });
    expect(hide).toBeChecked();
    expect(window.localStorage.getItem('newshacker:hideOnScroll')).toBe('1');

    act(() => {
      fireEvent.click(sticky);
    });
    expect(sticky).toBeChecked();
    expect(window.localStorage.getItem('newshacker:stickyBottomBar')).toBe('1');

    // Turning a toggle back off clears its key.
    act(() => {
      fireEvent.click(hide);
    });
    expect(hide).not.toBeChecked();
    expect(window.localStorage.getItem('newshacker:hideOnScroll')).toBeNull();
  });

  it('hosts the Hot rule editor (New branch + reset)', () => {
    renderWithProviders(<SettingsPage />, { route: '/settings' });
    // "New" is unique to the Hot rule's branch legends (the Home feed picker
    // above is Top/Hot, so it has no "New"); the reset button is editor-only.
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByTestId('hot-rule-card-reset')).toBeInTheDocument();
  });

  it('sizes the shared Hot rule controls to the touch floor on this page', () => {
    // The Hot rule editor is reused from the compact /hot toolbar panel; on
    // this primary mobile surface the page scopes its controls up to the 44px
    // floor (Golden rule 5). jsdom can't compute layout, so assert the source
    // contract — page-scoped overrides exist for the toggle, slider, and reset.
    const css = readFileSync(
      resolve(process.cwd(), 'src/pages/SettingsPage.css'),
      'utf8',
    );
    expect(css).toMatch(
      /\.settings-page \.hot-rule-card__slider\s*\{[^}]*min-height:\s*var\(--tap-min\)/,
    );
    expect(css).toMatch(
      /\.settings-page \.hot-rule-card__reset\s*\{[^}]*min-height:\s*var\(--tap-min\)/,
    );
    expect(css).toMatch(/\.settings-page \.hot-rule-card__toggle\s*\{[^}]*24px/);
  });

  it('links to Help, About, Debug, and back to Top', () => {
    renderWithProviders(<SettingsPage />, { route: '/settings' });
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
    expect(
      screen.getByRole('link', { name: /back to top/i }),
    ).toHaveAttribute('href', '/top');
  });
});
