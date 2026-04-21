import { afterEach, describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import App from './App';
import { renderWithProviders } from './test/renderUtils';
import { installHNFetchMock } from './test/mockFetch';

const analyticsMock = vi.fn((_props: unknown) => null);
vi.mock('@vercel/analytics/react', () => ({
  Analytics: (props: unknown) => analyticsMock(props),
}));

describe('<App> routing', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders the header with the newshacker brand', () => {
    installHNFetchMock({ feeds: { topstories: [] } });
    renderWithProviders(<App />, { route: '/top' });
    expect(screen.getByRole('banner')).toHaveTextContent('newshacker');
  });

  it('redirects / to /top', async () => {
    installHNFetchMock({ feeds: { topstories: [] } });
    renderWithProviders(<App />, { route: '/' });
    expect(
      await screen.findByTestId('empty-state'),
    ).toBeInTheDocument();
  });

  it('renders a 404 for unknown routes', () => {
    installHNFetchMock({});
    renderWithProviders(<App />, { route: '/no/such/path' });
    expect(screen.getByText(/page not found/i)).toBeInTheDocument();
  });

  it('mounts Vercel Web Analytics', () => {
    analyticsMock.mockClear();
    installHNFetchMock({ feeds: { topstories: [] } });
    renderWithProviders(<App />, { route: '/top' });
    expect(analyticsMock).toHaveBeenCalled();
  });
});
