import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { prefetchFavoriteStory } from './favoriteStoryPrefetch';
import { summaryQueryKey } from '../hooks/useSummary';
import { commentsSummaryQueryKey } from '../hooks/useCommentsSummary';

describe('prefetchFavoriteStory', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prefetches item root and AI summary so /favorites has both without a round-trip', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/item/42')) {
        return new Response(
          JSON.stringify({
            id: 42,
            type: 'story',
            title: 'Cached favorite',
            url: 'https://example.com/cached',
            kids: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/summary')) {
        return new Response(JSON.stringify({ summary: 'prefetched summary' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    prefetchFavoriteStory(client, { id: 42, url: 'https://example.com/cached' });

    await vi.waitFor(() => {
      expect(client.getQueryData(['itemRoot', 42])).toBeTruthy();
      expect(client.getQueryData(summaryQueryKey(42))).toEqual({
        summary: 'prefetched summary',
      });
    });
  });

  it('also batches top-level comments via /api/items so offline /favorites has discussion', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/item/88')) {
        return new Response(
          JSON.stringify({
            id: 88,
            type: 'story',
            title: 'Fav',
            url: 'https://example.com/fav',
            kids: [881, 882],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/items')) {
        const parsed = new URL(url, 'http://localhost');
        expect(parsed.searchParams.get('fields')).toBe('full');
        const ids = (parsed.searchParams.get('ids') ?? '')
          .split(',')
          .map(Number);
        return new Response(
          JSON.stringify(
            ids.map((id) => ({
              id,
              type: 'comment',
              by: 'alice',
              text: `body ${id}`,
              time: 1,
              kids: [],
            })),
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/summary')) {
        return new Response(JSON.stringify({ summary: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    prefetchFavoriteStory(client, { id: 88, url: 'https://example.com/fav' });

    await vi.waitFor(() => {
      expect(client.getQueryData(['comment', 881])).toMatchObject({ id: 881 });
      expect(client.getQueryData(['comment', 882])).toMatchObject({ id: 882 });
    });
  });

  it('prefetches the comments summary when the favorited story has kids', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/item/99')) {
        return new Response(
          JSON.stringify({
            id: 99,
            type: 'story',
            title: 'Fav with comments',
            url: 'https://example.com/99',
            kids: [991],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/comments-summary')) {
        return new Response(
          JSON.stringify({ insights: ['cached insight'] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/items')) {
        return new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/summary')) {
        return new Response(JSON.stringify({ summary: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    prefetchFavoriteStory(client, { id: 99, url: 'https://example.com/99' });

    await vi.waitFor(() => {
      expect(client.getQueryData(commentsSummaryQueryKey(99))).toEqual({
        insights: ['cached insight'],
      });
    });
  });

  it('fires the comments-summary prefetch in parallel with the item fetch', async () => {
    // Prefetch unconditionally rather than waiting on the HN item fetch to
    // confirm kids exist. See prefetchFavoriteStory for the rationale. The
    // invariant we care about: /api/comments-summary completes before
    // /item/<id> resolves, which requires it to be in flight independently.
    let resolveItem!: () => void;
    const itemBlocker = new Promise<void>((r) => {
      resolveItem = r;
    });
    const completedBefore = {
      item: false,
      commentsSummary: false,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/item/77')) {
        await itemBlocker;
        completedBefore.item = true;
        return new Response(
          JSON.stringify({
            id: 77,
            type: 'story',
            title: 'Favorited',
            url: 'https://example.com/77',
            kids: [771],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/comments-summary')) {
        completedBefore.commentsSummary = true;
        return new Response(
          JSON.stringify({ insights: ['warmed'] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/summary')) {
        return new Response(JSON.stringify({ summary: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    prefetchFavoriteStory(client, { id: 77, url: 'https://example.com/77' });

    await vi.waitFor(() => {
      expect(client.getQueryData(commentsSummaryQueryKey(77))).toEqual({
        insights: ['warmed'],
      });
    });
    expect(completedBefore.commentsSummary).toBe(true);
    expect(completedBefore.item).toBe(false);

    resolveItem();
    await vi.waitFor(() => {
      expect(client.getQueryData(['itemRoot', 77])).toBeTruthy();
    });
  });

  it('skips the summary prefetch for self-posts without a url', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/item/')) {
        return new Response(
          JSON.stringify({ id: 7, type: 'story', title: 'Self post' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    prefetchFavoriteStory(client, { id: 7 });

    await vi.waitFor(() => {
      expect(client.getQueryData(['itemRoot', 7])).toBeTruthy();
    });

    const calls = fetchMock.mock.calls.map((c) =>
      typeof c[0] === 'string' ? c[0] : c[0].toString(),
    );
    expect(calls.some((u) => u.includes('/api/summary'))).toBe(false);
  });
});
