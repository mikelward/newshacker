// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { prefetchPinnedStory } from './pinnedStoryPrefetch';
import { summaryQueryKey } from '../hooks/useSummary';
import { commentsSummaryQueryKey } from '../hooks/useCommentsSummary';

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
      expect(client.getQueryData(summaryQueryKey(42))).toEqual({
        summary: 'prefetched summary',
      });
    });

    // Item fetch went to Firebase, summary went to /api/summary.
    const calls = fetchMock.mock.calls.map((c) =>
      typeof c[0] === 'string' ? c[0] : c[0].toString(),
    );
    expect(calls.some((u) => u.includes('/item/42'))).toBe(true);
    expect(calls.some((u) => u.includes('/api/summary'))).toBe(true);
  });

  it('batches top-level comments via /api/items so offline pinned threads have real discussion', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/item/500')) {
        return new Response(
          JSON.stringify({
            id: 500,
            type: 'story',
            title: 'With comments',
            url: 'https://example.com/with-comments',
            kids: [501, 502, 503],
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

    prefetchPinnedStory(client, {
      id: 500,
      url: 'https://example.com/with-comments',
    });

    await vi.waitFor(() => {
      expect(client.getQueryData(['comment', 501])).toMatchObject({ id: 501 });
      expect(client.getQueryData(['comment', 502])).toMatchObject({ id: 502 });
      expect(client.getQueryData(['comment', 503])).toMatchObject({ id: 503 });
    });

    const itemsCalls = fetchMock.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : c[0].toString()))
      .filter((u) => u.includes('/api/items'));
    // Single batch request, not one request per comment.
    expect(itemsCalls).toHaveLength(1);
  });

  it('prefetches the comments summary when the pinned story has kids', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/item/321')) {
        return new Response(
          JSON.stringify({
            id: 321,
            type: 'story',
            title: 'Pinned with comments',
            url: 'https://example.com/321',
            kids: [3211, 3212],
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

    prefetchPinnedStory(client, {
      id: 321,
      url: 'https://example.com/321',
    });

    await vi.waitFor(() => {
      expect(client.getQueryData(commentsSummaryQueryKey(321))).toEqual({
        insights: ['cached insight'],
      });
    });

    const calls = fetchMock.mock.calls.map((c) =>
      typeof c[0] === 'string' ? c[0] : c[0].toString(),
    );
    expect(
      calls.some((u) => u.includes('/api/comments-summary?id=321')),
    ).toBe(true);
  });

  it('fires the comments-summary prefetch in parallel with the item fetch', async () => {
    // We prefetch unconditionally rather than waiting on the HN item fetch
    // to confirm kids exist. Stories with no comments pay a cheap edge 404;
    // every other story wins ~100ms of head start.
    //
    // The invariant we actually care about: /api/comments-summary is in
    // flight before /item/<id> resolves. Use a delayed item response so a
    // sequentially-gated prefetch couldn't possibly beat it.
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
      if (url.includes('/item/322')) {
        await itemBlocker;
        completedBefore.item = true;
        return new Response(
          JSON.stringify({
            id: 322,
            type: 'story',
            title: 'Pinned',
            url: 'https://example.com/322',
            kids: [3221],
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

    prefetchPinnedStory(client, {
      id: 322,
      url: 'https://example.com/322',
    });

    await vi.waitFor(() => {
      expect(client.getQueryData(commentsSummaryQueryKey(322))).toEqual({
        insights: ['warmed'],
      });
    });
    expect(completedBefore.commentsSummary).toBe(true);
    expect(completedBefore.item).toBe(false);

    resolveItem();
    await vi.waitFor(() => {
      expect(client.getQueryData(['itemRoot', 322])).toBeTruthy();
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
