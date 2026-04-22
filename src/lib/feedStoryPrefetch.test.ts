// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  FEED_PREFETCH_SCORE_THRESHOLD,
  prefetchFeedStory,
} from './feedStoryPrefetch';
import { summaryQueryKey } from '../hooks/useSummary';
import { commentsSummaryQueryKey } from '../hooks/useCommentsSummary';

describe('prefetchFeedStory', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes a 100-point score threshold', () => {
    expect(FEED_PREFETCH_SCORE_THRESHOLD).toBe(100);
  });

  it('warms the item root, top-level comments, article summary, and comments summary — same shape as pin-time', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/item/77.json')) {
        return new Response(
          JSON.stringify({
            id: 77,
            type: 'story',
            title: 'Trending',
            url: 'https://example.com/trending',
            kids: [771, 772, 773],
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
        const body = ids.map((id) => ({
          id,
          type: 'comment',
          by: 'alice',
          text: `body ${id}`,
          time: 1,
          kids: [],
        }));
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/summary')) {
        return new Response(
          JSON.stringify({ summary: 'warmed article summary' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/comments-summary')) {
        return new Response(
          JSON.stringify({ insights: ['warmed insight'] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    prefetchFeedStory(client, {
      id: 77,
      url: 'https://example.com/trending',
    });

    await vi.waitFor(() => {
      expect(client.getQueryData(['itemRoot', 77])).toMatchObject({
        item: { id: 77 },
        kidIds: [771, 772, 773],
      });
      expect(client.getQueryData(['comment', 771])).toMatchObject({ id: 771 });
      expect(client.getQueryData(summaryQueryKey(77))).toEqual({
        summary: 'warmed article summary',
      });
      expect(client.getQueryData(commentsSummaryQueryKey(77))).toEqual({
        insights: ['warmed insight'],
      });
    });

    const itemsBatches = fetchMock.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : c[0].toString()))
      .filter((u) => u.includes('/api/items'));
    expect(itemsBatches).toHaveLength(1);
  });

  it('skips the article-summary prefetch for self-posts without a url — matches pin-time', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/item/7.json')) {
        return new Response(
          JSON.stringify({ id: 7, type: 'story', title: 'Self post' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/comments-summary')) {
        return new Response('{"error":"no kids"}', {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    prefetchFeedStory(client, { id: 7 });

    await vi.waitFor(() => {
      expect(client.getQueryData(['itemRoot', 7])).toBeTruthy();
    });

    const calls = fetchMock.mock.calls.map((c) =>
      typeof c[0] === 'string' ? c[0] : c[0].toString(),
    );
    expect(calls.some((u) => u.includes('/api/summary'))).toBe(false);
  });

  it('is a no-op when the item root is already cached', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(['itemRoot', 99], {
      item: { id: 99, title: 'Already cached' },
      kidIds: [],
    });

    prefetchFeedStory(client, {
      id: 99,
      url: 'https://example.com/99',
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
