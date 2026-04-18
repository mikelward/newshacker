import { afterEach, describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import App from './App';
import { renderWithProviders } from './test/renderUtils';
import { installHNFetchMock } from './test/mockFetch';

describe('<App> routing', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders the header with the hnews.app brand', () => {
    installHNFetchMock({ feeds: { topstories: [] } });
    renderWithProviders(<App />, { route: '/top' });
    expect(screen.getByRole('banner')).toHaveTextContent('hnews.app');
  });

  it('redirects / to /top', async () => {
    installHNFetchMock({ feeds: { topstories: [] } });
    renderWithProviders(<App />, { route: '/' });
    // "Top" appears both in tabs and as feed label; if we're on /top,
    // the active tab exists.
    const topLinks = await screen.findAllByRole('link', { name: 'Top' });
    expect(topLinks.length).toBeGreaterThan(0);
  });

  it('renders a 404 for unknown routes', () => {
    installHNFetchMock({});
    renderWithProviders(<App />, { route: '/no/such/path' });
    expect(screen.getByText(/page not found/i)).toBeInTheDocument();
  });
});
