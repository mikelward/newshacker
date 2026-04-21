import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StoryList } from './StoryList';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';

describe('<StoryList> polish states', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders skeleton rows while loading', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    renderWithProviders(<StoryList feed="top" />);
    expect(screen.getByLabelText(/loading stories/i)).toBeInTheDocument();
  });

  it('renders an error state with a working Retry button', async () => {
    let attempt = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        attempt++;
        if (attempt === 1) {
          return new Response('boom', { status: 500 });
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getByTestId('error-state')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toHaveTextContent(/no stories/i);
    });
  });

  it('renders an empty state when the feed has no stories', async () => {
    installHNFetchMock({ feeds: { topstories: [] } });
    renderWithProviders(<StoryList feed="top" />);
    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toHaveTextContent(/no stories/i);
    });
  });

  it('advances pages only when the reader taps More', async () => {
    // Regression: no infinite-scroll sentinel, no auto-prefetch. The feed
    // should stop at 30 rows until the reader explicitly asks for more.
    const ids = Array.from({ length: 90 }, (_, i) => i + 1);
    const items = Object.fromEntries(ids.map((id) => [id, makeStory(id)]));
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(30);
    });

    await userEvent.click(screen.getByRole('button', { name: /^more$/i }));

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(60);
    });
  });
});
