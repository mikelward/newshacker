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

  it('links the offline pill to the offline story list', () => {
    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    renderWithProviders(<AppHeader />, { route: '/top' });
    expect(screen.getByRole('link', { name: /view offline stories/i })).toHaveAttribute(
      'href',
      '/offline',
    );
  });

  it('shows the offline pill on non-feed routes too', () => {
    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    renderWithProviders(<AppHeader />, { route: '/pinned' });
    expect(screen.getByTestId('offline-indicator')).toBeInTheDocument();
  });

  it('does not render Undo or Sweep buttons in the header — they live on the list toolbar', () => {
    renderWithProviders(<AppHeader />, { route: '/top' });
    expect(screen.queryByTestId('undo-btn')).toBeNull();
    expect(screen.queryByTestId('sweep-btn')).toBeNull();
  });

  it('does not render a Refresh button anywhere', () => {
    renderWithProviders(<AppHeader />, { route: '/top' });
    expect(screen.queryByTestId('refresh-btn')).toBeNull();
  });

  it('points the brand/home link at / (not /top)', () => {
    renderWithProviders(<AppHeader />, { route: '/new' });
    expect(screen.getByRole('link', { name: /newshacker home/i })).toHaveAttribute(
      'href',
      '/',
    );
  });

  it('shows a search button on feed pages that navigates to /search', () => {
    renderWithProviders(<AppHeader />, { route: '/top' });
    const btn = screen.getByTestId('search-btn');
    expect(btn).toHaveAccessibleName(/search hacker news/i);
    fireEvent.click(btn);
    // Search button doesn't render on /search itself.
    expect(screen.queryByTestId('search-btn')).toBeNull();
  });

  it('shows a search button on non-feed pages too', () => {
    renderWithProviders(<AppHeader />, { route: '/pinned' });
    expect(screen.getByTestId('search-btn')).toBeInTheDocument();
  });

  it('does not show a search button on /search', () => {
    renderWithProviders(<AppHeader />, { route: '/search' });
    expect(screen.queryByTestId('search-btn')).toBeNull();
  });
});
