import { afterEach, describe, it, expect } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { AppHeader } from './AppHeader';
import { renderWithProviders } from '../test/renderUtils';

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value,
  });
}

describe('<AppHeader>', () => {
  afterEach(() => {
    setOnline(true);
  });

  it('does not render a top-right page-title label', () => {
    renderWithProviders(<AppHeader />, { route: '/top' });
    expect(document.querySelector('.app-header__feed')).toBeNull();
  });

  it('renders exactly one newshacker brand label', () => {
    renderWithProviders(<AppHeader />, { route: '/no/such/path' });
    const banner = screen.getByRole('banner');
    const matches = banner.textContent?.match(/newshacker/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('does not render the old feed tab row', () => {
    renderWithProviders(<AppHeader />, { route: '/top' });
    expect(document.querySelector('.app-header__tabs')).toBeNull();
  });

  it('opens the drawer when the menu button is pressed', () => {
    renderWithProviders(<AppHeader />, { route: '/top' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('hides the offline pill when the browser reports online', () => {
    setOnline(true);
    renderWithProviders(<AppHeader />, { route: '/top' });
    expect(screen.queryByTestId('offline-indicator')).toBeNull();
  });

  it('shows an offline pill when the browser goes offline', () => {
    setOnline(true);
    renderWithProviders(<AppHeader />, { route: '/top' });
    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByTestId('offline-indicator')).toBeInTheDocument();
  });

  it('shows the offline pill on non-feed routes too', () => {
    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    renderWithProviders(<AppHeader />, { route: '/pinned' });
    expect(screen.getByTestId('offline-indicator')).toBeInTheDocument();
  });

  it('does not render any feed-scoped actions in the header itself', () => {
    // Refresh/Undo/Sweep all live in the separate FeedActionToolbar now.
    renderWithProviders(<AppHeader />, { route: '/top' });
    expect(screen.queryByTestId('refresh-btn')).toBeNull();
    expect(screen.queryByTestId('undo-btn')).toBeNull();
    expect(screen.queryByTestId('sweep-btn')).toBeNull();
  });

  it('points the brand/home link at / (not /top)', () => {
    renderWithProviders(<AppHeader />, { route: '/new' });
    expect(screen.getByRole('link', { name: /newshacker home/i })).toHaveAttribute(
      'href',
      '/',
    );
  });
});

// The global `:focus-visible { outline: 2px solid var(--nh-orange) }` rule
// in `global.css` is invisible against the orange header, so every
// focusable surface that lives on the header needs its own white ring
// override. A raw-CSS check is enough to pin the invariant — we don't
// need jsdom to actually simulate `:focus-visible` matching.
describe('orange-header focus-visible invariants', () => {
  async function readCss(relPath: string): Promise<string> {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(resolve(here, relPath), 'utf8');
  }

  const whiteRing = /:focus-visible\s*\{[^}]*outline:\s*2px\s+solid\s+#fff/;

  it('AppHeader gives .app-header__home a white focus-visible ring', async () => {
    const css = await readCss('AppHeader.css');
    expect(css).toMatch(
      new RegExp(`\\.app-header__home${whiteRing.source}`, 's'),
    );
  });

  it('AppHeader keeps a white ring on .app-header__menu-btn', async () => {
    const css = await readCss('AppHeader.css');
    expect(css).toMatch(
      new RegExp(`\\.app-header__menu-btn${whiteRing.source}`, 's'),
    );
  });

  it('HeaderAccountMenu gives .header-account__btn a white focus-visible ring', async () => {
    const css = await readCss('HeaderAccountMenu.css');
    expect(css).toMatch(
      new RegExp(`\\.header-account__btn${whiteRing.source}`, 's'),
    );
  });
});
