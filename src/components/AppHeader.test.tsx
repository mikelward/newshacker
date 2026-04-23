import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { AppHeader } from './AppHeader';
import { useFeedBar } from '../hooks/useFeedBar';
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

  it('shows a Refresh button left of Undo on feed pages', () => {
    renderWithProviders(<AppHeader />, { route: '/top' });
    const refresh = screen.getByTestId('refresh-btn');
    const undo = screen.getByTestId('undo-btn');
    expect(refresh).toBeInTheDocument();
    // DOM order check — refresh precedes undo in the actions group.
    const parent = refresh.parentElement!;
    const buttons = Array.from(parent.children);
    expect(buttons.indexOf(refresh)).toBeLessThan(buttons.indexOf(undo));
  });

  it('disables Refresh when no feed has registered a handler', () => {
    renderWithProviders(<AppHeader />, { route: '/top' });
    expect(screen.getByTestId('refresh-btn')).toBeDisabled();
  });

  it('calls the registered feed refresh handler when Refresh is pressed', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    function FeedShim() {
      const { setRefresh } = useFeedBar();
      useEffect(() => {
        setRefresh(onRefresh);
        return () => setRefresh(null);
      }, [setRefresh]);
      return null;
    }
    renderWithProviders(
      <>
        <AppHeader />
        <FeedShim />
      </>,
      { route: '/top' },
    );
    await waitFor(() => {
      expect(screen.getByTestId('refresh-btn')).not.toBeDisabled();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('refresh-btn'));
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('disables Refresh while the browser is offline', () => {
    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    const onRefresh = vi.fn();
    function FeedShim() {
      const { setRefresh } = useFeedBar();
      useEffect(() => {
        setRefresh(onRefresh);
        return () => setRefresh(null);
      }, [setRefresh]);
      return null;
    }
    renderWithProviders(
      <>
        <AppHeader />
        <FeedShim />
      </>,
      { route: '/top' },
    );
    expect(screen.getByTestId('refresh-btn')).toBeDisabled();
  });

  it('does not render Refresh (or any feed-scoped actions) on non-feed pages', () => {
    renderWithProviders(<AppHeader />, { route: '/pinned' });
    expect(screen.queryByTestId('refresh-btn')).toBeNull();
    expect(screen.queryByTestId('undo-btn')).toBeNull();
    expect(screen.queryByTestId('sweep-btn')).toBeNull();
  });

  it('treats the home path (/) as a feed page so Refresh/Undo/Sweep show there too', () => {
    renderWithProviders(<AppHeader />, { route: '/' });
    expect(screen.getByTestId('refresh-btn')).toBeInTheDocument();
    expect(screen.getByTestId('undo-btn')).toBeInTheDocument();
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

  it('AppHeader keeps white rings on .app-header__menu-btn and .app-header__icon-btn', async () => {
    const css = await readCss('AppHeader.css');
    expect(css).toMatch(
      new RegExp(`\\.app-header__menu-btn${whiteRing.source}`, 's'),
    );
    expect(css).toMatch(
      new RegExp(`\\.app-header__icon-btn${whiteRing.source}`, 's'),
    );
  });

  it('HeaderAccountMenu gives .header-account__btn a white focus-visible ring', async () => {
    const css = await readCss('HeaderAccountMenu.css');
    expect(css).toMatch(
      new RegExp(`\\.header-account__btn${whiteRing.source}`, 's'),
    );
  });
});
