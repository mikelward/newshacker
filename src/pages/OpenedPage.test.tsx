import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { OpenedPage } from './OpenedPage';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { addOpenedId } from '../lib/openedStories';

describe('<OpenedPage>', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('shows an empty state when nothing is opened', () => {
    installHNFetchMock({ items: {} });
    renderWithProviders(<OpenedPage />);
    expect(
      screen.getByText(/haven't opened any stories/i),
    ).toBeInTheDocument();
  });

  it('lists opened stories newest first', async () => {
    installHNFetchMock({
      items: {
        11: makeStory(11, { title: 'Eleven' }),
        22: makeStory(22, { title: 'Twenty-two' }),
      },
    });
    const now = Date.now();
    addOpenedId(11, now - 2000);
    addOpenedId(22, now - 1000);

    renderWithProviders(<OpenedPage />);
    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });
    const rows = screen.getAllByTestId('story-row');
    expect(rows[0]).toHaveTextContent('Twenty-two');
    expect(rows[1]).toHaveTextContent('Eleven');
  });

  it('renders opened rows with the opened modifier class', async () => {
    installHNFetchMock({
      items: { 7: makeStory(7, { title: 'Seven' }) },
    });
    addOpenedId(7);

    renderWithProviders(<OpenedPage />);
    await waitFor(() => {
      expect(screen.getByTestId('story-row')).toBeInTheDocument();
    });
    expect(screen.getByTestId('story-row').className).toContain(
      'story-row--opened',
    );
  });
});
