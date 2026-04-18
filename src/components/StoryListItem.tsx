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
  onHide?: (id: number) => void;
}

export function StoryListItem({ story, isLoggedIn = false, onHide }: Props) {
  const hasExternalUrl = !!story.url;
  const domain = extractDomain(story.url);
  const commentCount = story.descendants ?? 0;
  const points = story.score ?? 0;
  const age = story.time ? formatTimeAgo(story.time) : '';

  const title = story.title ?? '[untitled]';
  const domainLabel = hasExternalUrl ? domain : 'self post';

  const handleDismiss = useCallback(() => {
    onHide?.(story.id);
  }, [onHide, story.id]);

  const { dragging, isDismissing, style, handlers } = useSwipeToDismiss({
    onDismiss: handleDismiss,
    enabled: !!onHide,
  });

  const titleInner = (
    <>
      <span className="story-row__title-text">{title}</span>
      {domainLabel ? (
        <span className="story-row__domain">{domainLabel}</span>
      ) : null}
    </>
  );

  const rowClass =
    'story-row' +
    (dragging ? ' story-row--dragging' : '') +
    (isDismissing ? ' story-row--dismissing' : '');

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
          >
            {titleInner}
          </a>
        ) : (
          <Link
            className="story-row__title"
            data-testid="story-title"
            to={`/item/${story.id}`}
          >
            {titleInner}
          </Link>
        )}

        <div className="story-row__meta-row">
          <span className="story-row__meta" data-testid="story-meta">
            {points} {pluralize(points, 'point')} · {age}
          </span>
          <Link
            to={`/item/${story.id}`}
            className="comments-btn"
            data-testid="comments-btn"
            onClick={(e) => e.stopPropagation()}
            aria-label={`${commentCount} ${pluralize(commentCount, 'comment')}`}
          >
            {commentCount} {pluralize(commentCount, 'comment')}
          </Link>
        </div>
      </div>
    </article>
  );
}
