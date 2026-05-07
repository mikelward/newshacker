import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { COMMENT_BATCH_LIMIT } from './commentPrefetch';
import {
  getOfflineCacheStatus,
  type OfflineCacheStatus,
} from './offlineCacheStatus';
import type { HNItem } from './hn';
import type { ItemRoot } from '../hooks/useItemTree';
import { summaryQueryKey } from '../hooks/useSummary';
import { commentsSummaryQueryKey } from '../hooks/useCommentsSummary';

function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
    },
  });
}

function story(overrides: Partial<HNItem> = {}): HNItem {
  return {
    id: 42,
    type: 'story',
    title: 'Cached story',
    by: 'alice',
    time: 1_700_000_000,
    score: 10,
    descendants: 0,
    url: 'https://example.com/story',
    ...overrides,
  };
}

function setRoot(client: QueryClient, item: HNItem, kidIds: number[]): void {
  const root: ItemRoot = { item, kidIds };
  client.setQueryData(['itemRoot', item.id], root);
}

function expectStatus(
  actual: OfflineCacheStatus,
  expected: Partial<OfflineCacheStatus>,
): void {
  expect(actual).toMatchObject(expected);
}

describe('getOfflineCacheStatus', () => {
  it('reports a fully cached pinned story', () => {
    const client = newClient();
    const item = story({ kids: [101, 102], descendants: 2 });
    setRoot(client, item, [101, 102]);
    client.setQueryData(['comment', 101], { id: 101, type: 'comment' });
    client.setQueryData(['comment', 102], { id: 102, type: 'comment' });
    client.setQueryData(summaryQueryKey(42), { summary: 'article' });
    client.setQueryData(commentsSummaryQueryKey(42), { insights: ['one'] });

    expectStatus(getOfflineCacheStatus(client, 42), {
      overall: 'full',
      root: 'present',
      firstComments: {
        status: 'full',
        cached: 2,
        expected: 2,
        missingIds: [],
      },
      articleSummary: 'present',
      commentsSummary: 'present',
    });
  });

  it('reports partial comment coverage and missing summaries', () => {
    const client = newClient();
    const item = story({ kids: [101, 102, 103], descendants: 3 });
    setRoot(client, item, [101, 102, 103]);
    client.setQueryData(['comment', 101], { id: 101, type: 'comment' });

    expectStatus(getOfflineCacheStatus(client, 42), {
      overall: 'partial',
      root: 'present',
      firstComments: {
        status: 'partial',
        cached: 1,
        expected: 3,
        missingIds: [102, 103],
      },
      articleSummary: 'missing',
      commentsSummary: 'missing',
    });
  });

  it('marks summaries as not applicable when the story has no article or comments', () => {
    const client = newClient();
    const item = story({
      url: undefined,
      text: undefined,
      kids: [],
      descendants: 0,
    });
    setRoot(client, item, []);

    expectStatus(getOfflineCacheStatus(client, 42), {
      overall: 'full',
      root: 'present',
      firstComments: {
        status: 'not-applicable',
        cached: 0,
        expected: 0,
        missingIds: [],
      },
      articleSummary: 'not-applicable',
      commentsSummary: 'not-applicable',
    });
  });

  it('checks only the first cached-comment batch for large threads', () => {
    const client = newClient();
    const kidIds = Array.from({ length: COMMENT_BATCH_LIMIT + 5 }, (_, i) => 1000 + i);
    const item = story({ kids: kidIds, descendants: kidIds.length });
    setRoot(client, item, kidIds);
    for (const id of kidIds.slice(0, COMMENT_BATCH_LIMIT)) {
      client.setQueryData(['comment', id], { id, type: 'comment' });
    }
    client.setQueryData(summaryQueryKey(42), { summary: 'article' });
    client.setQueryData(commentsSummaryQueryKey(42), { insights: ['one'] });

    expectStatus(getOfflineCacheStatus(client, 42), {
      overall: 'full',
      firstComments: {
        status: 'full',
        cached: COMMENT_BATCH_LIMIT,
        expected: COMMENT_BATCH_LIMIT,
        missingIds: [],
      },
    });
  });

  it('reports missing when the root item is not cached', () => {
    const client = newClient();

    expectStatus(getOfflineCacheStatus(client, 42), {
      overall: 'missing',
      root: 'missing',
      firstComments: {
        status: 'missing',
        cached: 0,
        expected: 0,
        missingIds: [],
      },
      articleSummary: 'unknown',
      commentsSummary: 'unknown',
    });
  });
});
