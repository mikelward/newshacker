// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  prefetchCommentBatch,
  COMMENT_BATCH_LIMIT,
} from './commentPrefetch';
import type { HNItem } from './hn';

function makeComment(id: number): HNItem {
  return {
    id,
    type: 'comment',
    by: 'alice',
    text: `comment ${id}`,
    time: 1_700_000_000,
    kids: [],
  };
}

function newClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

describe('prefetchCommentBatch', () => {
  it('writes each fetched comment to the ["comment", id] key so useCommentItem hydrates from cache', async () => {
    const fetcher = vi.fn(async (ids: number[]) => ids.map(makeComment));
    const client = newClient();

    await prefetchCommentBatch(client, [10, 20, 30], fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith([10, 20, 30], undefined, {
      fields: 'full',
    });
    expect(client.getQueryData(['comment', 10])).toMatchObject({ id: 10 });
    expect(client.getQueryData(['comment', 20])).toMatchObject({ id: 20 });
    expect(client.getQueryData(['comment', 30])).toMatchObject({ id: 30 });
  });

  it('caps the request at the top-level limit (single batch, no mega-thread burst)', async () => {
    const many = Array.from({ length: 120 }, (_, i) => i + 1);
    const fetcher = vi.fn(async (ids: number[]) => ids.map(makeComment));
    const client = newClient();

    await prefetchCommentBatch(client, many, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const requestedIds = fetcher.mock.calls[0][0] as number[];
    expect(requestedIds).toHaveLength(COMMENT_BATCH_LIMIT);
    expect(requestedIds[0]).toBe(1);
    expect(requestedIds[requestedIds.length - 1]).toBe(
      COMMENT_BATCH_LIMIT,
    );
  });

  it('no-ops when there are no top-level kids', async () => {
    const fetcher = vi.fn(async () => []);
    const client = newClient();

    await prefetchCommentBatch(client, [], fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    expect(client.getQueryCache().findAll()).toHaveLength(0);
  });

  it('skips null entries (deleted / unknown ids) without crashing', async () => {
    const fetcher = vi.fn(async (ids: number[]) =>
      ids.map((id) => (id === 2 ? null : makeComment(id))),
    );
    const client = newClient();

    await prefetchCommentBatch(client, [1, 2, 3], fetcher);

    expect(client.getQueryData(['comment', 1])).toMatchObject({ id: 1 });
    expect(client.getQueryData(['comment', 2])).toBeUndefined();
    expect(client.getQueryData(['comment', 3])).toMatchObject({ id: 3 });
  });

  it('swallows fetcher errors so pinning is never blocked by a prefetch failure', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('offline');
    });
    const client = newClient();

    await expect(
      prefetchCommentBatch(client, [1, 2, 3], fetcher),
    ).resolves.toBeUndefined();
    expect(client.getQueryData(['comment', 1])).toBeUndefined();
  });

  it('overwrites existing cached comment data on a subsequent batch so edits and deletions surface on root refetch', async () => {
    const client = newClient();

    const firstFetcher = async (ids: number[]): Promise<Array<HNItem | null>> =>
      ids.map((id) => ({ ...makeComment(id), text: `original ${id}` }));
    await prefetchCommentBatch(client, [42], firstFetcher);
    expect(client.getQueryData<HNItem>(['comment', 42])?.text).toBe(
      'original 42',
    );

    const secondFetcher = async (ids: number[]): Promise<Array<HNItem | null>> =>
      ids.map((id) => ({ ...makeComment(id), text: `edited ${id}` }));
    await prefetchCommentBatch(client, [42], secondFetcher);

    expect(client.getQueryData<HNItem>(['comment', 42])?.text).toBe(
      'edited 42',
    );
  });

  it('preserves kids on cached comments so offline UI shows accurate reply counts', async () => {
    const fetcher = async (ids: number[]): Promise<Array<HNItem | null>> =>
      ids.map((id) => ({
        id,
        type: 'comment',
        by: 'bob',
        text: `comment ${id}`,
        time: 1,
        kids: [id * 10, id * 10 + 1],
      }));
    const client = newClient();

    await prefetchCommentBatch(client, [5], fetcher);

    const cached = client.getQueryData<HNItem>(['comment', 5]);
    expect(cached?.kids).toEqual([50, 51]);
  });
});
