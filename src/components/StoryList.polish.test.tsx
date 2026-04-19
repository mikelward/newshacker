import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
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

  it('advances pages via the infinite-scroll sentinel', async () => {
    // First fetch grabs 90 items; sentinel triggers one more page of 30.
    const ids = Array.from({ length: 120 }, (_, i) => i + 1);
    const items = Object.fromEntries(ids.map((id) => [id, makeStory(id)]));
    installHNFetchMock({ feeds: { topstories: ids }, items });

    type Entry = { isIntersecting: boolean };
    let observer: { callback: (e: Entry[]) => void } | null = null;
    const MockIO = function (cb: (e: Entry[]) => void) {
      observer = { callback: cb };
      return {
        observe: () => {},
        disconnect: () => {},
        unobserve: () => {},
        takeRecords: () => [] as Entry[],
      };
    };
    vi.stubGlobal('IntersectionObserver', MockIO);

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(90);
    });

    // Trigger the sentinel intersection.
    expect(observer).not.toBeNull();
    act(() => {
      observer!.callback([{ isIntersecting: true }]);
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(120);
    });
  });
});
