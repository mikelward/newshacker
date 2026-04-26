import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import App from './App';
import { renderWithProviders } from './test/renderUtils';
import { installHNFetchMock } from './test/mockFetch';
import { HOME_FEED_STORAGE_KEY } from './lib/homeFeed';
import { HOME_PROMO_DISMISSED_STORAGE_KEY } from './lib/homePromo';

const analyticsMock = vi.fn((_props: unknown) => null);
vi.mock('@vercel/analytics/react', () => ({
  Analytics: (props: unknown) => analyticsMock(props),
}));

describe('<App> routing', () => {
  beforeEach(() => {
    window.localStorage.removeItem(HOME_FEED_STORAGE_KEY);
    window.localStorage.removeItem(HOME_PROMO_DISMISSED_STORAGE_KEY);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.removeItem(HOME_FEED_STORAGE_KEY);
    window.localStorage.removeItem(HOME_PROMO_DISMISSED_STORAGE_KEY);
  });

  it('renders the header with the newshacker brand', () => {
    installHNFetchMock({ feeds: { topstories: [] } });
    renderWithProviders(<App />, { route: '/top' });
    expect(screen.getByRole('banner')).toHaveTextContent('newshacker');
  });

  it('renders the top feed inline at / by default (no redirect)', async () => {
    // `/` is the home URL and stays `/` — what it renders is the top
    // feed by default, the same underlying component `/top` mounts.
    // The drawer's Home picker (see useHomeFeed) can swap this for /hot.
    installHNFetchMock({ feeds: { topstories: [] } });
    renderWithProviders(<App />, { route: '/' });
    expect(
      await screen.findByTestId('empty-state'),
    ).toBeInTheDocument();
    // The 404 page should not appear; `/` is its own route now.
    expect(screen.queryByText(/page not found/i)).toBeNull();
  });

  it('renders the hot feed inline at / when the home preference is "hot"', async () => {
    // The /hot view merges /top and /new — fixture both as empty so
    // the hot empty-state copy renders without any further fetches.
    window.localStorage.setItem(HOME_FEED_STORAGE_KEY, 'hot');
    installHNFetchMock({ feeds: { topstories: [], newstories: [] } });
    renderWithProviders(<App />, { route: '/' });
    expect(
      await screen.findByText(/nothing hot right now/i),
    ).toBeInTheDocument();
  });

  it('renders the Hot promo card on the default home view', async () => {
    installHNFetchMock({ feeds: { topstories: [] } });
    renderWithProviders(<App />, { route: '/' });
    expect(await screen.findByTestId('empty-state')).toBeInTheDocument();
    expect(screen.getByTestId('home-promo-link')).toHaveAttribute(
      'href',
      '/hot',
    );
  });

  it('does not render the Hot promo card once dismissed', async () => {
    window.localStorage.setItem(HOME_PROMO_DISMISSED_STORAGE_KEY, '1');
    installHNFetchMock({ feeds: { topstories: [] } });
    renderWithProviders(<App />, { route: '/' });
    expect(await screen.findByTestId('empty-state')).toBeInTheDocument();
    expect(screen.queryByTestId('home-promo-link')).not.toBeInTheDocument();
  });

  it('does not render the Hot promo card when the home feed is hot', async () => {
    window.localStorage.setItem(HOME_FEED_STORAGE_KEY, 'hot');
    installHNFetchMock({ feeds: { topstories: [], newstories: [] } });
    renderWithProviders(<App />, { route: '/' });
    expect(
      await screen.findByText(/nothing hot right now/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('home-promo-link')).not.toBeInTheDocument();
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
