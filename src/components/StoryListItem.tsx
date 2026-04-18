import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import type { HNItem } from '../lib/hn';
import { extractDomain, formatTimeAgo, pluralize } from '../lib/format';
import { useSwipeToDismiss } from '../hooks/useSwipeToDismiss';
import './StoryListItem.css';

interface Props {
  story: HNItem;
  rank?: number;
  isLoggedIn?: boolean;
  isOpened?: boolean;
  onDismiss?: (id: number) => void;
  onMarkOpened?: (id: number) => void;
}

export function StoryListItem({
  story,
  isLoggedIn = false,
  isOpened = false,
  onDismiss,
  onMarkOpened,
}: Props) {
  const hasExternalUrl = !!story.url;
  const domain = extractDomain(story.url);
  const commentCount = story.descendants ?? 0;
  const points = story.score ?? 0;
  const age = story.time ? formatTimeAgo(story.time) : '';

  const title = story.title ?? '[untitled]';
  const domainLabel = hasExternalUrl ? domain : 'self post';

  const handleDismiss = useCallback(() => {
    onDismiss?.(story.id);
  }, [onDismiss, story.id]);

  const handleOpen = useCallback(() => {
    onMarkOpened?.(story.id);
  }, [onMarkOpened, story.id]);

  const { dragging, isDismissing, style, handlers } = useSwipeToDismiss({
    onDismiss: handleDismiss,
    enabled: !!onDismiss,
  });

  const titleInner = <span className="story-row__title-text">{title}</span>;

  const rowClass =
    'story-row' +
    (dragging ? ' story-row--dragging' : '') +
    (isDismissing ? ' story-row--dismissing' : '') +
    (isOpened ? ' story-row--opened' : '');

  return (
    <article
      className={rowClass}
      data-testid="story-row"
      style={style}
      {...handlers}
    >
      {isLoggedIn ? (
        <div className="story-row__vote">
          <button
            type="button"
            className="vote-btn"
            aria-label={`Upvote ${title}`}
          >
            <span aria-hidden="true">▲</span>
          </button>
        </div>
      ) : null}

      <div className="story-row__body">
        {hasExternalUrl ? (
          <a
            className="story-row__title"
            data-testid="story-title"
            href={story.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleOpen}
          >
            {titleInner}
          </a>
        ) : (
          <Link
            className="story-row__title"
            data-testid="story-title"
            to={`/item/${story.id}`}
            onClick={handleOpen}
          >
            {titleInner}
          </Link>
        )}

        {domainLabel ? (
          <span className="story-row__domain">{domainLabel}</span>
        ) : null}

        <div className="story-row__meta-row">
          <span className="story-row__meta" data-testid="story-meta">
            {points} {pluralize(points, 'point')} · {age}
          </span>
          <Link
            to={`/item/${story.id}`}
            className="comments-btn"
            data-testid="comments-btn"
            onClick={(e) => {
              e.stopPropagation();
              handleOpen();
            }}
            aria-label={`${commentCount} ${pluralize(commentCount, 'comment')}`}
          >
            {commentCount} {pluralize(commentCount, 'comment')}
          </Link>
        </div>
      </div>
    </article>
  );
}
