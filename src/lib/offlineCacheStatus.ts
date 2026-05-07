import type { QueryClient } from '@tanstack/react-query';
import { commentsSummaryQueryKey } from '../hooks/useCommentsSummary';
import type { ItemRoot } from '../hooks/useItemTree';
import { summaryQueryKey } from '../hooks/useSummary';
import { COMMENT_BATCH_LIMIT } from './commentPrefetch';
import type { HNItem } from './hn';
import { hasSelfPostBody } from './selfPostBody';

export type CachePieceStatus = 'present' | 'missing' | 'not-applicable' | 'unknown';
export type CommentCacheStatus = 'full' | 'partial' | 'missing' | 'not-applicable';
export type OverallOfflineCacheStatus = 'full' | 'partial' | 'missing';

export interface OfflineCommentCacheStatus {
  status: CommentCacheStatus;
  cached: number;
  expected: number;
  missingIds: number[];
}

export interface OfflineCacheStatus {
  storyId: number;
  overall: OverallOfflineCacheStatus;
  root: 'present' | 'missing';
  firstComments: OfflineCommentCacheStatus;
  articleSummary: CachePieceStatus;
  commentsSummary: CachePieceStatus;
}

function hasArticleSummarySurface(item: HNItem): boolean {
  return !!item.url || hasSelfPostBody(item.text);
}

function hasCommentsSummarySurface(item: HNItem, kidIds: readonly number[]): boolean {
  return kidIds.length > 0 || (item.descendants ?? 0) > 0;
}

function pieceIsComplete(status: CachePieceStatus): boolean {
  return status === 'present' || status === 'not-applicable' || status === 'unknown';
}

function commentStatusFor(
  client: QueryClient,
  kidIds: readonly number[],
): OfflineCommentCacheStatus {
  const expectedIds = kidIds.slice(0, COMMENT_BATCH_LIMIT);
  if (expectedIds.length === 0) {
    return {
      status: 'not-applicable',
      cached: 0,
      expected: 0,
      missingIds: [],
    };
  }

  const missingIds = expectedIds.filter(
    (id) => client.getQueryData(['comment', id]) === undefined,
  );
  const cached = expectedIds.length - missingIds.length;
  return {
    status:
      cached === expectedIds.length
        ? 'full'
        : cached > 0
          ? 'partial'
          : 'missing',
    cached,
    expected: expectedIds.length,
    missingIds,
  };
}

function summaryStatus(
  client: QueryClient,
  key: readonly unknown[],
  applicable: boolean,
): CachePieceStatus {
  if (!applicable) return 'not-applicable';
  return client.getQueryData(key) === undefined ? 'missing' : 'present';
}

export function getOfflineCacheStatus(
  client: QueryClient,
  storyId: number,
): OfflineCacheStatus {
  const root = client.getQueryData<ItemRoot | null>(['itemRoot', storyId]);
  if (!root) {
    return {
      storyId,
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
    };
  }

  const firstComments = commentStatusFor(client, root.kidIds);
  const articleSummary = summaryStatus(
    client,
    summaryQueryKey(storyId),
    hasArticleSummarySurface(root.item),
  );
  const commentsSummary = summaryStatus(
    client,
    commentsSummaryQueryKey(storyId),
    hasCommentsSummarySurface(root.item, root.kidIds),
  );

  const complete =
    firstComments.status === 'full' ||
    firstComments.status === 'not-applicable';
  return {
    storyId,
    overall:
      complete &&
      pieceIsComplete(articleSummary) &&
      pieceIsComplete(commentsSummary)
        ? 'full'
        : 'partial',
    root: 'present',
    firstComments,
    articleSummary,
    commentsSummary,
  };
}
