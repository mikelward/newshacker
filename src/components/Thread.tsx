import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useItemTree } from '../hooks/useItemTree';
import { useInfiniteScroll } from '../hooks/useInfiniteScroll';
import { useFavorites } from '../hooks/useFavorites';
import { useInternalLinkClick } from '../hooks/useInternalLinkClick';
import { usePinnedStories } from '../hooks/usePinnedStories';
import { useSummary } from '../hooks/useSummary';
import { extractDomain, formatTimeAgo, pluralize } from '../lib/format';
import { markArticleOpenedId } from '../lib/openedStories';
import { prefetchPinnedStory } from '../lib/pinnedStoryPrefetch';
import { sanitizeCommentHtml } from '../lib/sanitize';
import { Comment } from './Comment';
import { ThreadSkeleton } from './Skeletons';
import { ErrorState, EmptyState } from './States';
import './Thread.css';

interface Props {
  id: number;
}

export const TOP_LEVEL_PAGE_SIZE = 20;

// Material Symbols Outlined — Apache 2.0, Google. viewBox 0 -960 960 960,
// fill-based paths that take `color` via currentColor.
const MS_VIEWBOX = '0 -960 960 960';

function OpenInNewIcon() {
  return (
    <svg
      className="thread__action-icon"
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="28"
      height="28"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h280v80H200v560h560v-280h80v280q0 33-23.5 56.5T760-120H200Zm188-212-56-56 372-372H560v-80h280v280h-80v-144L388-332Z" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg
      className="thread__action-icon"
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="28"
      height="28"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m634-448 86 77v60H510v241l-30 30-30-30v-241H240v-60l80-77v-332h-50v-60h414v60h-50v332Zm-313 77h312l-59-55v-354H380v354l-59 55Zm156 0Z" />
    </svg>
  );
}

function PinFilledIcon() {
  return (
    <svg
      className="thread__action-icon"
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="28"
      height="28"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m634-448 86 77v60H510v241l-30 30-30-30v-241H240v-60l80-77v-333h-50v-60h414v60h-50v333Z" />
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg
      className="thread__action-icon"
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="28"
      height="28"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m480-121-41-37q-105.77-97.12-174.88-167.56Q195-396 154-451.5T96.5-552Q80-597 80-643q0-90.15 60.5-150.58Q201-854 290-854q57 0 105.5 27t84.5 78q42-54 89-79.5T670-854q89 0 149.5 60.42Q880-733.15 880-643q0 46-16.5 91T806-451.5Q765-396 695.88-325.56 626.77-255.12 521-158l-41 37Zm0-79q101.24-93 166.62-159.5Q712-426 750.5-476t54-89.14q15.5-39.13 15.5-77.72 0-66.14-42-108.64T670.22-794q-51.52 0-95.37 31.5T504-674h-49q-26-56-69.85-88-43.85-32-95.37-32Q224-794 182-751.5t-42 108.82q0 38.68 15.5 78.18 15.5 39.5 54 90T314-358q66 66 166 158Zm0-297Z" />
    </svg>
  );
}

function HeartFilledIcon() {
  return (
    <svg
      className="thread__action-icon"
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="28"
      height="28"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m480-121-41-37q-106-97-175-167.5t-110-126Q113-507 96.5-552T80-643q0-90 60.5-150.5T290-854q57 0 105.5 27t84.5 78q42-54 89-79.5T670-854q89 0 149.5 60.5T880-643q0 46-16.5 91T806-451.5q-41 55.5-110 126T521-158l-41 37Z" />
    </svg>
  );
}

function SummaryCard({ url }: { url: string }) {
  const { data, isFetching, isError, error, refetch } = useSummary(url, true);
  const loading = isFetching && !data;

  return (
    <div
      className="thread__summary-card"
      data-testid="thread-summary-card"
      role="region"
      aria-label="AI summary"
      aria-live="polite"
      aria-busy={loading}
    >
      {loading ? (
        <span className="thread__summary-loading">Summarizing…</span>
      ) : null}
      {loading ? (
        <div
          className="thread__summary-skeleton"
          data-testid="thread-summary-skeleton"
          aria-hidden="true"
        >
          <span className="thread__summary-skeleton-line" />
          <span className="thread__summary-skeleton-line" />
          <span className="thread__summary-skeleton-line" />
          <span className="thread__summary-skeleton-line" />
          <span className="thread__summary-skeleton-line" />
          <span className="thread__summary-skeleton-line thread__summary-skeleton-line--short" />
        </div>
      ) : null}
      {data ? <p className="thread__summary-body">{data.summary}</p> : null}
      {isError && !isFetching ? (
        <div className="thread__summary-error">
          <p>
            Could not summarize.
            {error instanceof Error && error.message
              ? ` ${error.message}.`
              : ''}
          </p>
          <button
            type="button"
            className="thread__summary-retry"
            onClick={() => refetch()}
          >
            Retry
          </button>
        </div>
      ) : null}
      {data ? (
        <div className="thread__summary-footer">
          Generated by Gemini 2.5 Flash — may be inaccurate.
        </div>
      ) : null}
    </div>
  );
}

export function Thread({ id }: Props) {
  const { data, isLoading, isError, refetch } = useItemTree(id);
  const queryClient = useQueryClient();
  const [visibleCount, setVisibleCount] = useState(TOP_LEVEL_PAGE_SIZE);
  const { isPinned, pin, unpin } = usePinnedStories();
  const pinned = isPinned(id);
  const item = data?.item;
  const handleTogglePinned = useCallback(() => {
    if (pinned) {
      unpin(id);
    } else {
      pin(id);
      if (item) prefetchPinnedStory(queryClient, item);
    }
  }, [pinned, id, pin, unpin, item, queryClient]);
  const { isFavorite, favorite, unfavorite } = useFavorites();
  const favorited = isFavorite(id);
  const handleToggleFavorite = useCallback(() => {
    if (favorited) unfavorite(id);
    else favorite(id);
  }, [favorited, id, favorite, unfavorite]);
  const handleLinkClick = useInternalLinkClick();

  const kidIds = data?.kidIds ?? [];
  const shown = kidIds.slice(0, visibleCount);
  const hasMore = visibleCount < kidIds.length;

  const sentinelRef = useInfiniteScroll<HTMLDivElement>({
    enabled: hasMore,
    onLoadMore: () => setVisibleCount((n) => n + TOP_LEVEL_PAGE_SIZE),
  });

  if (isLoading) {
    return (
      <div className="thread" aria-busy="true" aria-label="Loading thread">
        <ThreadSkeleton />
      </div>
    );
  }
  if (isError) {
    return <ErrorState message="Could not load thread." onRetry={() => refetch()} />;
  }
  if (!data || !item) {
    return <EmptyState message="Item not found." />;
  }

  if (item.deleted || item.dead) {
    return (
      <div className="thread">
        <header className="thread__header">
          <h1 className="thread__title">
            {item.deleted ? '[deleted]' : '[dead]'}
          </h1>
        </header>
      </div>
    );
  }

  const age = item.time ? formatTimeAgo(item.time) : '';
  const points = item.score ?? 0;
  const commentCount = item.descendants ?? 0;
  const domain = extractDomain(item.url);
  const hasExternalUrl = !!item.url;

  return (
    <article className="thread">
      <header className="thread__header">
        <h1 className="thread__title">{item.title ?? '[untitled]'}</h1>
        {item.url ? <SummaryCard url={item.url} /> : null}
        <div className="thread__actions">
          {item.url ? (
            <a
              className="thread__action thread__action--primary"
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => markArticleOpenedId(item.id)}
            >
              <OpenInNewIcon />
              <span className="thread__action-label">Read article</span>
            </a>
          ) : null}
          <button
            type="button"
            className={
              'thread__action thread__action--icon' +
              (pinned ? ' thread__action--active' : '')
            }
            data-testid="thread-pin"
            aria-pressed={pinned}
            onClick={handleTogglePinned}
          >
            {pinned ? <PinFilledIcon /> : <PinIcon />}
            <span className="visually-hidden">
              {pinned ? 'Unpin' : 'Pin'}
            </span>
          </button>
          <button
            type="button"
            className={
              'thread__action thread__action--icon' +
              (favorited ? ' thread__action--active' : '')
            }
            data-testid="thread-favorite"
            aria-pressed={favorited}
            onClick={handleToggleFavorite}
          >
            {favorited ? <HeartFilledIcon /> : <HeartIcon />}
            <span className="visually-hidden">
              {favorited ? 'Unfavorite' : 'Favorite'}
            </span>
          </button>
        </div>
        <div className="thread__meta" data-testid="thread-meta">
          {hasExternalUrl ? (
            domain ? (
              <>
                <a
                  href={`https://${domain}/`}
                  className="thread__domain"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {domain}
                </a>
                {' · '}
              </>
            ) : null
          ) : item.by ? (
            <>
              <Link to={`/user/${item.by}`} className="thread__author">
                {item.by}
              </Link>
              {' · '}
            </>
          ) : null}
          {age ? `${age} · ` : ''}
          {points} {pluralize(points, 'point')} · {commentCount}{' '}
          {pluralize(commentCount, 'comment')}
        </div>
        {item.text ? (
          <div
            className="thread__text"
            onClick={handleLinkClick}
            dangerouslySetInnerHTML={{ __html: sanitizeCommentHtml(item.text) }}
          />
        ) : null}
      </header>
      <ol className="thread__comments">
        {shown.map((kidId) => (
          <li key={kidId}>
            <Comment id={kidId} depth={0} />
          </li>
        ))}
      </ol>
      {hasMore ? (
        <div
          ref={sentinelRef}
          className="thread__sentinel"
          data-testid="comments-sentinel"
          aria-hidden="true"
        />
      ) : null}
    </article>
  );
}
