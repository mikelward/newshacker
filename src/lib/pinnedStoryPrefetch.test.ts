import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { prefetchPinnedStory } from './pinnedStoryPrefetch';
import { summaryQueryKey } from '../hooks/useSummary';

describe('prefetchPinnedStory', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prefetches item root and AI summary so /pinned has both without a round-trip', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/item/42')) {
        return new Response(
          JSON.stringify({
            id: 42,
            type: 'story',
            title: 'Cached story',
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

    prefetchPinnedStory(client, { id: 42, url: 'https://example.com/cached' });

    await vi.waitFor(() => {
      expect(client.getQueryData(['itemRoot', 42])).toBeTruthy();
      expect(
        client.getQueryData(summaryQueryKey('https://example.com/cached')),
      ).toEqual({ summary: 'prefetched summary' });
    });

    // Item fetch went to Firebase, summary went to /api/summary.
    const calls = fetchMock.mock.calls.map((c) =>
      typeof c[0] === 'string' ? c[0] : c[0].toString(),
    );
    expect(calls.some((u) => u.includes('/item/42'))).toBe(true);
    expect(calls.some((u) => u.includes('/api/summary'))).toBe(true);
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

    prefetchPinnedStory(client, { id: 7 });

    await vi.waitFor(() => {
      expect(client.getQueryData(['itemRoot', 7])).toBeTruthy();
    });

    const calls = fetchMock.mock.calls.map((c) =>
      typeof c[0] === 'string' ? c[0] : c[0].toString(),
    );
    expect(calls.some((u) => u.includes('/api/summary'))).toBe(false);
  });
});
