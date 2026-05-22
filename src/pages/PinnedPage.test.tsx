import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { IsRestoringProvider, QueryClient } from '@tanstack/react-query';
import { PinnedPage } from './PinnedPage';
import { Thread } from '../components/Thread';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { addPinnedId } from '../lib/pinnedStories';
import type { HNItem } from '../lib/hn';
import { _resetNetworkStatusForTests } from '../lib/networkStatus';

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('<PinnedPage>', () => {
  beforeEach(() => {
    window.localStorage.clear();
    _resetNetworkStatusForTests();
  });
  afterEach(() => {
    window.localStorage.clear();
    _resetNetworkStatusForTests();
    vi.unstubAllGlobals();
  });

  it('shows an empty state when nothing is pinned', () => {
    installHNFetchMock({ items: {} });
    renderWithProviders(<PinnedPage />);
    expect(screen.getByText(/Nothing pinned yet/i)).toBeInTheDocument();
  });

  it('shows pinned stories', async () => {
    installHNFetchMock({
      items: {
        1: makeStory(1, { title: 'Alpha' }),
        2: makeStory(2, { title: 'Beta' }),
      },
    });
    addPinnedId(1);
    addPinnedId(2);

    renderWithProviders(<PinnedPage />);

    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });
  });

  it('tapping the pin button unpins and removes the row', async () => {
    installHNFetchMock({
      items: { 5: makeStory(5, { title: 'Five' }) },
    });
    addPinnedId(5);

    renderWithProviders(<PinnedPage />);
    await waitFor(() => {
      expect(screen.getByText('Five')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.click(screen.getByTestId('pin-btn'));
    });

    await waitFor(() => {
      expect(screen.queryByText('Five')).toBeNull();
    });

    const stored = window.localStorage.getItem('newshacker:pinnedStoryIds');
    const parsed = stored
      ? (JSON.parse(stored) as Array<{ id: number; deleted?: true }>)
      : [];
    expect(parsed.filter((e) => !e.deleted)).toEqual([]);
  });

  it('orders pinned stories oldest first by pin time', async () => {
    installHNFetchMock({
      items: {
        1: makeStory(1, { title: 'One' }),
        2: makeStory(2, { title: 'Two' }),
      },
    });
    const now = Date.now();
    addPinnedId(1, now - 2000);
    addPinnedId(2, now - 1000);

    renderWithProviders(<PinnedPage />);
    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });
    const rows = screen.getAllByTestId('story-row');
    expect(rows[0]).toHaveTextContent('One');
    expect(rows[1]).toHaveTextContent('Two');
  });

  it('hydrates the thread from the pinned-list cache while the full warm is still in flight', async () => {
    const thinStory: HNItem = makeStory(9, {
      title: 'Seeded pinned story',
      descendants: 1,
    });
    delete thinStory.kids;
    const fullStory: HNItem = { ...thinStory, kids: [901] };
    const comment: HNItem = {
      id: 901,
      type: 'comment',
      by: 'alice',
      text: 'cached comment',
      time: 1_700_000_000,
    };
    const rootFetch = deferredResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/items')) {
        const parsed = new URL(url, 'http://localhost');
        const ids = (parsed.searchParams.get('ids') ?? '')
          .split(',')
          .filter(Boolean)
          .map(Number);
        const body = ids.map((id) => {
          if (id === 9) return thinStory;
          if (id === 901) return comment;
          return null;
        });
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/v0/item/9.json')) {
        return rootFetch.promise;
      }
      if (url.includes('/api/summary') || url.includes('/api/comments-summary')) {
        return new Response(JSON.stringify({ error: 'not configured' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    addPinnedId(9);

    const pinned = renderWithProviders(<PinnedPage />);
    await waitFor(() => {
      expect(screen.getByText('Seeded pinned story')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(pinned.client.getQueryData(['itemRoot', 9])).toMatchObject({
        item: { id: 9, title: 'Seeded pinned story' },
        kidIds: [],
      });
    });

    pinned.unmount();
    renderWithProviders(<Thread id={9} />, {
      route: '/item/9',
      client: pinned.client,
    });

    expect(screen.getByText('Seeded pinned story')).toBeInTheDocument();
    expect(screen.queryByLabelText(/loading thread/i)).toBeNull();

    await act(async () => {
      rootFetch.resolve(
        new Response(JSON.stringify(fullStory), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    await waitFor(() => {
      expect(pinned.client.getQueryData(['itemRoot', 9])).toMatchObject({
        kidIds: [901],
      });
    });
  });

  it('renders cached item roots when the pinned batch is unavailable offline', async () => {
    addPinnedId(42);
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0, staleTime: 0, networkMode: 'offlineFirst' },
      },
    });
    client.setQueryData(['itemRoot', 42], {
      item: makeStory(42, { title: 'Cached offline pin', kids: [] }),
      kidIds: [],
    });
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<PinnedPage />, { client });

    await waitFor(() => {
      expect(screen.getByText('Cached offline pin')).toBeInTheDocument();
    });
    expect(screen.queryByText('Could not load stories.')).toBeNull();
  });

  it('waits for persisted cache restore before showing a pinned-list error', async () => {
    addPinnedId(77);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    renderWithProviders(
      <IsRestoringProvider value={true}>
        <PinnedPage />
      </IsRestoringProvider>,
    );

    expect(screen.getByLabelText(/loading stories/i)).toBeInTheDocument();
    expect(screen.queryByText('Could not load stories.')).toBeNull();
  });

  it('renders a cached item root that arrives after the pinned list already errored', async () => {
    addPinnedId(88);
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0, staleTime: 0, networkMode: 'offlineFirst' },
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    renderWithProviders(<PinnedPage />, { client });

    await waitFor(() => {
      expect(screen.getByText('Could not load stories.')).toBeInTheDocument();
    });

    act(() => {
      client.setQueryData(['itemRoot', 88], {
        item: makeStory(88, { title: 'Broadcast cached pin', kids: [] }),
        kidIds: [],
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Broadcast cached pin')).toBeInTheDocument();
      expect(screen.queryByText('Could not load stories.')).toBeNull();
    });
  });
});
