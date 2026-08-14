import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prefetchHomeFeedIds } from './feedBootPrefetch';

// The home feed's id list is the first link in a serial chain — the
// /api/items batch cannot start until it answers — so it is fetched from
// the entry module rather than from a React effect. These pin the two
// properties that gives us: the request goes out on the call itself (no
// mount, no effect), and it lands under the key the feed's own observer
// reads.

describe('prefetchHomeFeedIds', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });
  afterEach(() => {
    client.clear();
    vi.unstubAllGlobals();
  });

  it('fetches the top feed id list and caches it under ["storyIds","top"]', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify([11, 22, 33]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    prefetchHomeFeedIds(client);

    await vi.waitFor(() => {
      expect(client.getQueryData(['storyIds', 'top'])).toEqual([11, 22, 33]);
    });
    expect(
      fetchMock.mock.calls.map(([input]) => String(input)),
    ).toContain('https://hacker-news.firebaseio.com/v0/topstories.json');
  });

  it('puts the request on the wire synchronously, without waiting for a mount', () => {
    // The whole point of moving this out of <BootPrefetch>'s effect: by
    // the time the call returns, the fetch has already been issued.
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>(() => {}), // never settles
    );
    vi.stubGlobal('fetch', fetchMock);

    prefetchHomeFeedIds(client);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves a failed prefetch for the feed observer to retry, without throwing', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
        throw new TypeError('Failed to fetch');
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(() => prefetchHomeFeedIds(client)).not.toThrow();

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(client.getQueryData(['storyIds', 'top'])).toBeUndefined();
  });
});
