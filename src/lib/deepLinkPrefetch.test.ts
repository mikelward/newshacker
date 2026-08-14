import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  parseDeepLinkedItemId,
  prefetchDeepLinkedItem,
} from './deepLinkPrefetch';
import { installHNFetchMock, makeStory } from '../test/mockFetch';

function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, networkMode: 'always' },
    },
  });
}

describe('parseDeepLinkedItemId', () => {
  it('reads the id out of a thread path', () => {
    expect(parseDeepLinkedItemId('/item/123')).toBe(123);
    expect(parseDeepLinkedItemId('/item/123/')).toBe(123);
  });

  it('ignores everything that is not a thread path', () => {
    for (const path of [
      '/',
      '/pinned',
      '/item',
      '/item/',
      '/item/abc',
      '/item/12x',
      '/item/123/extra',
      '/user/hnuser',
    ]) {
      expect(parseDeepLinkedItemId(path)).toBeNull();
    }
  });

  it('rejects an id that is not a usable item number', () => {
    expect(parseDeepLinkedItemId('/item/0')).toBeNull();
    expect(parseDeepLinkedItemId(`/item/${'9'.repeat(30)}`)).toBeNull();
  });
});

describe('prefetchDeepLinkedItem', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('fetches the item and both summaries in parallel', async () => {
    const fetchMock = installHNFetchMock({
      items: { 123: makeStory(123, { title: 'Deep linked', kids: [] }) },
      summaries: { 123: { summary: 'S123' } },
      commentsSummaries: { 123: { insights: ['i123'] } },
    });
    const client = newClient();

    prefetchDeepLinkedItem(client, '/item/123');

    // All three are on the wire before any of them has answered — the
    // summaries in particular don't wait for the item to report that
    // the story has an article, which is what the thread page does.
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((u) => u.includes('/api/summary'))).toBe(true);
    expect(urls.some((u) => u.includes('/api/comments-summary'))).toBe(true);

    await vi.waitFor(() => {
      expect(client.getQueryData(['itemRoot', 123])).toMatchObject({
        item: { title: 'Deep linked' },
      });
      expect(client.getQueryData(['summary', 123])).toMatchObject({
        summary: 'S123',
      });
      expect(client.getQueryData(['comments-summary', 123])).toMatchObject({
        insights: ['i123'],
      });
    });
  });

  it('does nothing on a non-thread route', () => {
    const fetchMock = installHNFetchMock({ items: {} });
    prefetchDeepLinkedItem(newClient(), '/pinned');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves the thread page nothing to refetch: same keys, same shape', async () => {
    const fetchMock = installHNFetchMock({
      items: {
        456: makeStory(456, { title: 'Four five six', kids: [4561] }),
        4561: makeStory(4561, { title: 'A comment' }),
      },
      summaries: { 456: { summary: 'S456' } },
      commentsSummaries: { 456: { insights: ['i456'] } },
    });
    const client = newClient();

    prefetchDeepLinkedItem(client, '/item/456');
    await vi.waitFor(() => {
      expect(client.getQueryData(['itemRoot', 456])).toMatchObject({
        item: { title: 'Four five six' },
        kidIds: [4561],
      });
    });
    // The root's own comment warm rides along, exactly as useItemTree's
    // queryFn does — a thread mounting on this cache paints its first
    // comments without a round trip.
    expect(client.getQueryData(['comment', 4561])).toMatchObject({
      title: 'A comment',
    });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('survives a failing prefetch without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const client = newClient();

    expect(() => prefetchDeepLinkedItem(client, '/item/789')).not.toThrow();
    await vi.waitFor(() => {
      expect(client.getQueryState(['itemRoot', 789])?.fetchStatus).toBe('idle');
    });
    expect(client.getQueryData(['itemRoot', 789])).toBeUndefined();
  });
});
