import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Thread } from './Thread';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value,
  });
}

describe('<Thread> offline messaging', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setOnline(true);
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    setOnline(true);
  });

  it('tells the user to pin while online when the thread fetch fails offline', async () => {
    // Fetch always rejects to mimic an offline network layer.
    const fetchMock = vi.fn(async () => {
      throw new TypeError('network down');
    });
    vi.stubGlobal('fetch', fetchMock);
    setOnline(false);

    renderWithProviders(<Thread id={999} />, { route: '/item/999' });

    await waitFor(() => {
      expect(
        screen.getByText(/not available offline/i),
      ).toBeInTheDocument();
    });
    // No retry button while offline — network is known to be down.
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('shows the offline-specific summary message when the summary has never been fetched', async () => {
    installHNFetchMock({
      items: {
        321: makeStory(321, {
          title: 'Offline read',
          url: 'https://example.com/offline',
          kids: [],
        }),
      },
      // Summary fixture is absent on purpose so the request 500s, standing
      // in for "never cached and we are offline".
    });
    setOnline(false);

    renderWithProviders(<Thread id={321} />, { route: '/item/321' });

    // Thread header renders from the mocked item fetch, then the summary
    // card shows the offline copy instead of the generic error.
    await waitFor(() => {
      expect(screen.getByTestId('summary-offline')).toBeInTheDocument();
    });
    expect(
      screen.getByText(/pin this story while online/i),
    ).toBeInTheDocument();
  });
});
