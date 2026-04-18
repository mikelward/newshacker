import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { useItemTree } from '../hooks/useItemTree';
import { useInfiniteScroll } from '../hooks/useInfiniteScroll';
import { useSavedStories } from '../hooks/useSavedStories';
import { extractDomain, formatTimeAgo, pluralize } from '../lib/format';
import { sanitizeCommentHtml } from '../lib/sanitize';
import { Comment } from './Comment';
import { ThreadSkeleton } from './Skeletons';
import { ErrorState, EmptyState } from './States';
import { useToast } from '../hooks/useToast';
import './Thread.css';

interface Props {
  id: number;
}

export const TOP_LEVEL_PAGE_SIZE = 20;

export function Thread({ id }: Props) {
  const { data, isLoading, isError, refetch } = useItemTree(id);
  const [visibleCount, setVisibleCount] = useState(TOP_LEVEL_PAGE_SIZE);
  const { isSaved, save, unsave } = useSavedStories();
  const saved = isSaved(id);
  const { showToast } = useToast();
  const handleToggleSaved = useCallback(() => {
    if (saved) {
      unsave(id);
      showToast({ message: 'Unsaved' });
    } else {
      save(id);
      showToast({ message: 'Saved' });
    }
  }, [saved, id, save, unsave, showToast]);

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
  if (!data) {
    return <EmptyState message="Item not found." />;
  }

  const { item } = data;

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

  const domain = extractDomain(item.url);
  const age = item.time ? formatTimeAgo(item.time) : '';
  const points = item.score ?? 0;
  const commentCount = item.descendants ?? 0;

  return (
    <article className="thread">
      <header className="thread__header">
        <h1 className="thread__title">{item.title ?? '[untitled]'}</h1>
        {item.url ? (
          <a
            className="thread__read-article"
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Read article{domain ? ` · ${domain}` : ''}
          </a>
        ) : null}
        <button
          type="button"
          className={
            'thread__save' + (saved ? ' thread__save--active' : '')
          }
          data-testid="thread-save"
          aria-pressed={saved}
          onClick={handleToggleSaved}
        >
          {saved ? 'Saved' : 'Save'}
        </button>
        <div className="thread__meta">
          <span>
            {points} {pluralize(points, 'point')}
          </span>
          {item.by ? (
            <>
              <span aria-hidden="true"> · </span>
              <Link to={`/user/${item.by}`} className="thread__author">
                {item.by}
              </Link>
            </>
          ) : null}
          {age ? (
            <>
              <span aria-hidden="true"> · </span>
              <span>{age}</span>
            </>
          ) : null}
        </div>
        {item.text ? (
          <div
            className="thread__text"
            dangerouslySetInnerHTML={{ __html: sanitizeCommentHtml(item.text) }}
          />
        ) : null}
        <div className="thread__comment-count">
          {commentCount} {pluralize(commentCount, 'comment')}
        </div>
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
