import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSearchResults } from './useSearchResults';

function newClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, networkMode: 'always' },
    },
  });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

interface PageFixture {
  hits: Array<{ objectID: string; title?: string }>;
  page: number;
  nbPages: number;
}

function stubAlgoliaPages(pages: Record<number, PageFixture>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const parsed = new URL(url);
    const page = Number(parsed.searchParams.get('page') ?? '0');
    const fixture = pages[page];
    if (!fixture) {
      return new Response(JSON.stringify({ hits: [], page, nbPages: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('useSearchResults', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('is idle for an empty query and does not fetch', () => {
    const fetchMock = stubAlgoliaPages({});
    const { result } = renderHook(() => useSearchResults('', 'relevance'), {
      wrapper: wrapperFor(newClient()),
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.hits).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats whitespace-only queries as empty', () => {
    const fetchMock = stubAlgoliaPages({});
    renderHook(() => useSearchResults('   ', 'relevance'), {
      wrapper: wrapperFor(newClient()),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches the first page when the query is non-empty', async () => {
    stubAlgoliaPages({
      0: { hits: [{ objectID: '1', title: 'A' }], page: 0, nbPages: 2 },
    });
    const { result } = renderHook(
      () => useSearchResults('rust', 'relevance'),
      { wrapper: wrapperFor(newClient()) },
    );
    await waitFor(() => {
      expect(result.current.hits.map((h) => h.id)).toEqual([1]);
    });
    expect(result.current.hasMore).toBe(true);
  });

  it('loadMore appends the next page', async () => {
    stubAlgoliaPages({
      0: { hits: [{ objectID: '1' }], page: 0, nbPages: 2 },
      1: { hits: [{ objectID: '2' }], page: 1, nbPages: 2 },
    });
    const { result } = renderHook(
      () => useSearchResults('rust', 'relevance'),
      { wrapper: wrapperFor(newClient()) },
    );
    await waitFor(() => {
      expect(result.current.hits.map((h) => h.id)).toEqual([1]);
    });
    act(() => result.current.loadMore());
    await waitFor(() => {
      expect(result.current.hits.map((h) => h.id)).toEqual([1, 2]);
    });
    expect(result.current.hasMore).toBe(false);
  });

  it('hits the date endpoint when sort=date', async () => {
    const fetchMock = stubAlgoliaPages({
      0: { hits: [], page: 0, nbPages: 0 },
    });
    renderHook(() => useSearchResults('rust', 'date'), {
      wrapper: wrapperFor(newClient()),
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toContain('/search_by_date?');
  });
});
