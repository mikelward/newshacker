import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { SearchPage } from './SearchPage';
import { renderWithProviders } from '../test/renderUtils';
import {
  HIDDEN_STORIES_CHANGE_EVENT,
  addHiddenId,
} from '../lib/hiddenStories';

interface AlgoliaPageFixture {
  hits: Array<{
    objectID: string;
    title?: string;
    url?: string;
    author?: string;
    points?: number;
    num_comments?: number;
    created_at_i?: number;
    _tags?: string[];
  }>;
  page: number;
  nbPages: number;
}

function stubAlgolia(
  byEndpoint: Partial<Record<'search' | 'search_by_date', Record<number, AlgoliaPageFixture>>>,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const parsed = new URL(url);
    const path = parsed.pathname.endsWith('/search_by_date')
      ? 'search_by_date'
      : 'search';
    const page = Number(parsed.searchParams.get('page') ?? '0');
    const fixture = byEndpoint[path]?.[page] ?? {
      hits: [],
      page,
      nbPages: 0,
    };
    return new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('<SearchPage>', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('renders the search input and sort toggle', () => {
    stubAlgolia({});
    renderWithProviders(<SearchPage />, { route: '/search' });
    expect(screen.getByTestId('search-input')).toBeInTheDocument();
    expect(screen.getByTestId('sort-relevance')).toBeInTheDocument();
    expect(screen.getByTestId('sort-date')).toBeInTheDocument();
  });

  it('shows the prompt empty state with no query', () => {
    stubAlgolia({});
    renderWithProviders(<SearchPage />, { route: '/search' });
    expect(screen.getByText(/Type a query above/i)).toBeInTheDocument();
  });

  it('runs a search from a ?q=… URL on first render', async () => {
    stubAlgolia({
      search: {
        0: {
          hits: [
            { objectID: '1', title: 'Rust async patterns' },
            { objectID: '2', title: 'Rust by example' },
          ],
          page: 0,
          nbPages: 1,
        },
      },
    });
    renderWithProviders(<SearchPage />, { route: '/search?q=rust' });
    await waitFor(() => {
      expect(screen.getByText('Rust async patterns')).toBeInTheDocument();
    });
    expect(screen.getByText('Rust by example')).toBeInTheDocument();
  });

  it('switches endpoint when the Date sort is selected', async () => {
    const fetchMock = stubAlgolia({
      search: {
        0: {
          hits: [{ objectID: '1', title: 'Relevant' }],
          page: 0,
          nbPages: 1,
        },
      },
      search_by_date: {
        0: {
          hits: [{ objectID: '2', title: 'Recent' }],
          page: 0,
          nbPages: 1,
        },
      },
    });
    renderWithProviders(<SearchPage />, { route: '/search?q=rust' });
    await waitFor(() => {
      expect(screen.getByText('Relevant')).toBeInTheDocument();
    });
    act(() => {
      fireEvent.click(screen.getByTestId('sort-date'));
    });
    await waitFor(() => {
      expect(screen.getByText('Recent')).toBeInTheDocument();
    });
    // Confirm at least one call went to the date endpoint.
    const dateCalls = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/search_by_date'));
    expect(dateCalls.length).toBeGreaterThan(0);
  });

  it('shows a "no results" empty state when Algolia returns nothing', async () => {
    stubAlgolia({
      search: { 0: { hits: [], page: 0, nbPages: 0 } },
    });
    renderWithProviders(<SearchPage />, { route: '/search?q=zzzqzz' });
    await waitFor(() => {
      expect(screen.getByText(/No results for "zzzqzz"/i)).toBeInTheDocument();
    });
  });

  it('shows a More button when more pages are available', async () => {
    stubAlgolia({
      search: {
        0: {
          hits: [{ objectID: '1', title: 'A' }],
          page: 0,
          nbPages: 3,
        },
      },
    });
    renderWithProviders(<SearchPage />, { route: '/search?q=rust' });
    await waitFor(() => {
      expect(screen.getByText('A')).toBeInTheDocument();
    });
    expect(screen.getByTestId('search-more')).toBeInTheDocument();
  });

  it('filters out hits that are already in the user\'s hidden list', async () => {
    stubAlgolia({
      search: {
        0: {
          hits: [
            { objectID: '1', title: 'Visible' },
            { objectID: '2', title: 'Stay Hidden' },
          ],
          page: 0,
          nbPages: 1,
        },
      },
    });
    addHiddenId(2);
    renderWithProviders(<SearchPage />, { route: '/search?q=rust' });
    await waitFor(() => {
      expect(screen.getByText('Visible')).toBeInTheDocument();
    });
    expect(screen.queryByText('Stay Hidden')).toBeNull();
  });

  it('removes a hit from the list when the row is hidden from /search', async () => {
    stubAlgolia({
      search: {
        0: {
          hits: [
            { objectID: '1', title: 'Alpha' },
            { objectID: '2', title: 'Beta' },
          ],
          page: 0,
          nbPages: 1,
        },
      },
    });
    renderWithProviders(<SearchPage />, { route: '/search?q=rust' });
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });
    // Hide via the row's long-press menu would be ideal, but the
    // gesture path is unit-tested elsewhere. Drive the public hide()
    // API directly so this test focuses on whether SearchPage filters
    // its rendered hits in response.
    act(() => {
      addHiddenId(1);
      window.dispatchEvent(new CustomEvent(HIDDEN_STORIES_CHANGE_EVENT));
    });
    await waitFor(() => {
      expect(screen.queryByText('Alpha')).toBeNull();
    });
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('appends the next page when More is pressed', async () => {
    stubAlgolia({
      search: {
        0: {
          hits: [{ objectID: '1', title: 'First' }],
          page: 0,
          nbPages: 2,
        },
        1: {
          hits: [{ objectID: '2', title: 'Second' }],
          page: 1,
          nbPages: 2,
        },
      },
    });
    renderWithProviders(<SearchPage />, { route: '/search?q=rust' });
    await waitFor(() => {
      expect(screen.getByText('First')).toBeInTheDocument();
    });
    act(() => {
      fireEvent.click(screen.getByTestId('search-more'));
    });
    await waitFor(() => {
      expect(screen.getByText('Second')).toBeInTheDocument();
    });
  });
});
