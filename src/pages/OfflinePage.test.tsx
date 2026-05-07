import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { OfflinePage } from './OfflinePage';
import { renderWithProviders } from '../test/renderUtils';
import { makeStory } from '../test/mockFetch';
import { summaryQueryKey } from '../hooks/useSummary';
import { commentsSummaryQueryKey } from '../hooks/useCommentsSummary';
import { addDoneId } from '../lib/doneStories';
import { addHiddenId } from '../lib/hiddenStories';
import { addPinnedId, getPinnedIds } from '../lib/pinnedStories';

function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, networkMode: 'offlineFirst' },
    },
  });
}

describe('<OfflinePage>', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('shows an empty state when no story roots are cached', () => {
    renderWithProviders(<OfflinePage />);
    expect(screen.getByText(/No offline stories yet/i)).toBeInTheDocument();
  });

  it('lists cached story roots newest-cache first without fetching', async () => {
    const client = newClient();
    client.setQueryData(
      ['itemRoot', 1],
      { item: makeStory(1, { title: 'Older cached' }), kidIds: [] },
      { updatedAt: 1_000 },
    );
    client.setQueryData(
      ['itemRoot', 2],
      { item: makeStory(2, { title: 'Newer cached' }), kidIds: [] },
      { updatedAt: 2_000 },
    );
    client.setQueryData(
      ['itemRoot', 3],
      { item: { id: 3, type: 'comment', text: 'not a story' }, kidIds: [] },
      { updatedAt: 3_000 },
    );
    const fetchMock = vi.fn(async () => new Response('not expected'));
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<OfflinePage />, { client });

    const rows = screen.getAllByTestId('story-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Newer cached');
    expect(rows[1]).toHaveTextContent('Older cached');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('filters hidden and done stories like the home feed', () => {
    const client = newClient();
    client.setQueryData(['itemRoot', 1], {
      item: makeStory(1, { title: 'Visible cached' }),
      kidIds: [],
    });
    client.setQueryData(['itemRoot', 2], {
      item: makeStory(2, { title: 'Hidden cached' }),
      kidIds: [],
    });
    client.setQueryData(['itemRoot', 3], {
      item: makeStory(3, { title: 'Done cached' }),
      kidIds: [],
    });
    addHiddenId(2);
    addDoneId(3);

    renderWithProviders(<OfflinePage />, { client });

    expect(screen.getByText('Visible cached')).toBeInTheDocument();
    expect(screen.queryByText('Hidden cached')).toBeNull();
    expect(screen.queryByText('Done cached')).toBeNull();
  });

  it('updates when a cached root arrives after render', async () => {
    const client = newClient();
    renderWithProviders(<OfflinePage />, { client });
    expect(screen.getByText(/No offline stories yet/i)).toBeInTheDocument();

    act(() => {
      client.setQueryData(['itemRoot', 9], {
        item: makeStory(9, { title: 'Arrived later' }),
        kidIds: [],
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Arrived later')).toBeInTheDocument();
    });
  });

  it('supports the normal row pin action', async () => {
    const client = newClient();
    client.setQueryData(['itemRoot', 7], {
      item: makeStory(7, { title: 'Pin from offline' }),
      kidIds: [],
    });

    renderWithProviders(<OfflinePage />, { client });
    fireEvent.click(screen.getByTestId('pin-btn'));

    expect(getPinnedIds()).toEqual(new Set([7]));
    await waitFor(() => {
      expect(screen.getByTestId('pin-btn')).toHaveAttribute('aria-pressed', 'true');
    });
  });

  it('warms the full pinned-story cache when pinning from offline rows', async () => {
    const client = newClient();
    client.setQueryData(['itemRoot', 10], {
      item: makeStory(10, {
        title: 'Pin warms from offline',
        url: 'https://example.com/offline-pin',
      }),
      kidIds: [],
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/v0/item/10.json')) {
        return new Response(
          JSON.stringify(
            makeStory(10, {
              title: 'Pin warms from offline',
              url: 'https://example.com/offline-pin',
              kids: [1001],
            }),
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/items')) {
        return new Response(
          JSON.stringify([
            {
              id: 1001,
              type: 'comment',
              by: 'alice',
              text: 'warmed comment',
              time: 1,
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/summary')) {
        return new Response(JSON.stringify({ summary: 'warmed summary' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/comments-summary')) {
        return new Response(JSON.stringify({ insights: ['warmed insight'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<OfflinePage />, { client });
    fireEvent.click(screen.getByTestId('pin-btn'));

    await waitFor(() => {
      expect(client.getQueryData(['itemRoot', 10])).toMatchObject({
        kidIds: [1001],
      });
      expect(client.getQueryData(['comment', 1001])).toMatchObject({
        id: 1001,
      });
      expect(client.getQueryData(summaryQueryKey(10))).toEqual({
        summary: 'warmed summary',
      });
      expect(client.getQueryData(commentsSummaryQueryKey(10))).toEqual({
        insights: ['warmed insight'],
      });
    });
  });

  it('renders pinned rows as already pinned', () => {
    const client = newClient();
    client.setQueryData(['itemRoot', 8], {
      item: makeStory(8, { title: 'Already pinned offline' }),
      kidIds: [],
    });
    addPinnedId(8);

    renderWithProviders(<OfflinePage />, { client });

    expect(screen.getByTestId('pin-btn')).toHaveAttribute('aria-pressed', 'true');
  });
});
