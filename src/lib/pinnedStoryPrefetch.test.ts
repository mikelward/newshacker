// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { prefetchPinnedStory } from './pinnedStoryPrefetch';
import { summaryQueryKey } from '../hooks/useSummary';
import { commentsSummaryQueryKey } from '../hooks/useCommentsSummary';
import { addPinnedId, clearPinnedIds } from './pinnedStories';

describe('prefetchPinnedStory', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    if (typeof window !== 'undefined') window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (typeof window !== 'undefined') {
      clearPinnedIds();
      window.localStorage.clear();
    }
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

  it('seeds itemRoot synchronously from row data before the full item request returns', async () => {
    let resolveRoot!: (value: Response) => void;
    const rootPromise = new Promise<Response>((resolve) => {
      resolveRoot = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/item/77')) return rootPromise;
      if (url.includes('/api/summary')) {
        return new Response(JSON.stringify({ error: 'not configured' }), {
          status: 503,
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
      id: 77,
      type: 'story',
      title: 'Immediate row title',
      url: 'https://example.com/immediate',
      descendants: 5,
    });

    expect(client.getQueryData(['itemRoot', 77])).toMatchObject({
      item: { id: 77, title: 'Immediate row title' },
      kidIds: [],
    });

    resolveRoot(
      new Response(
        JSON.stringify({
          id: 77,
          type: 'story',
          title: 'Full item title',
          url: 'https://example.com/immediate',
          kids: [7701],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await vi.waitFor(() => {
      expect(client.getQueryData(['itemRoot', 77])).toMatchObject({
        item: { title: 'Full item title' },
        kidIds: [7701],
      });
    });
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

  it('locks every prefetched query at gcTime Infinity when the story is already pinned', async () => {
    // Happy path for "pinned articles never get evicted from the client
    // cache": when prefetchPinnedStory is called for a story that's
    // present in the pinned-ids list, every cache entry it warms — item
    // root, both AI summaries, and the per-comment entries — must end
    // up with gcTime Infinity so React Query never schedules a gc
    // timeout against them. Companion tests in pinnedQueryRetention
    // cover the path where the query already exists with a finite
    // gcTime when the pin happens.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/item/808')) {
        return new Response(
          JSON.stringify({
            id: 808,
            type: 'story',
            title: 'Locked',
            url: 'https://example.com/locked',
            kids: [8081],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/items')) {
        const parsed = new URL(url, 'http://localhost');
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
        return new Response(JSON.stringify({ summary: 'pinned' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/comments-summary')) {
        return new Response(JSON.stringify({ insights: ['pinned'] }), {
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

    // Pin BEFORE prefetch — matches the production order:
    // usePinnedStories.pin(id) writes localStorage and dispatches the
    // change event, then the caller invokes prefetchPinnedStory.
    addPinnedId(808);
    prefetchPinnedStory(client, {
      id: 808,
      url: 'https://example.com/locked',
    });

    await vi.waitFor(() => {
      expect(client.getQueryData(['itemRoot', 808])).toBeTruthy();
      expect(client.getQueryData(summaryQueryKey(808))).toEqual({
        summary: 'pinned',
      });
      expect(client.getQueryData(commentsSummaryQueryKey(808))).toEqual({
        insights: ['pinned'],
      });
      expect(client.getQueryData(['comment', 8081])).toMatchObject({ id: 8081 });
    });

    const cache = client.getQueryCache();
    const gcTimeFor = (key: readonly unknown[]) =>
      cache.find({ queryKey: key, exact: true })?.gcTime;
    expect(gcTimeFor(['itemRoot', 808])).toBe(Infinity);
    expect(gcTimeFor(summaryQueryKey(808))).toBe(Infinity);
    expect(gcTimeFor(commentsSummaryQueryKey(808))).toBe(Infinity);
    expect(gcTimeFor(['comment', 8081])).toBe(Infinity);
  });

  it('keeps the regular 7-day gcTime for feed warms (story not in pinned list)', async () => {
    // prefetchFeedStory reuses prefetchPinnedStory for trending feed
    // rows where the user has not pinned the story. Those entries must
    // still expire normally — locking every drive-by feed warm at
    // Infinity would let an active feed-browser pile up unbounded
    // localStorage usage with no recovery.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/item/909')) {
        return new Response(
          JSON.stringify({
            id: 909,
            type: 'story',
            title: 'Trending',
            url: 'https://example.com/trending',
            kids: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/summary')) {
        return new Response(JSON.stringify({ summary: 'trending' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/comments-summary')) {
        return new Response(JSON.stringify({ insights: [] }), {
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

    // Story is NOT pinned.
    prefetchPinnedStory(client, {
      id: 909,
      url: 'https://example.com/trending',
    });

    await vi.waitFor(() => {
      expect(client.getQueryData(['itemRoot', 909])).toBeTruthy();
    });

    const root = client
      .getQueryCache()
      .find({ queryKey: ['itemRoot', 909], exact: true });
    expect(root?.gcTime).not.toBe(Infinity);
    expect(root?.gcTime).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
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
