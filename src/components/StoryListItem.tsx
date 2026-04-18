import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import type { HNItem } from '../lib/hn';
import type { OpenedKind } from '../lib/openedStories';
import { extractDomain, formatTimeAgo, pluralize } from '../lib/format';
import { useSwipeToDismiss } from '../hooks/useSwipeToDismiss';
import './StoryListItem.css';

interface Props {
  story: HNItem;
  rank?: number;
  isLoggedIn?: boolean;
  articleOpened?: boolean;
  commentsOpened?: boolean;
  onDismiss?: (id: number) => void;
  onMarkOpened?: (id: number, kind: OpenedKind) => void;
}

export function StoryListItem({
  story,
  isLoggedIn = false,
  articleOpened = false,
  commentsOpened = false,
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

  // For URL stories the title opens the article; for self-posts it opens
  // the thread, so a title tap is really a comments tap in that case.
  const titleKind: OpenedKind = hasExternalUrl ? 'article' : 'comments';

  const handleOpenTitle = useCallback(() => {
    onMarkOpened?.(story.id, titleKind);
  }, [onMarkOpened, story.id, titleKind]);

  const handleOpenComments = useCallback(() => {
    onMarkOpened?.(story.id, 'comments');
  }, [onMarkOpened, story.id]);

  const { dragging, isDismissing, style, handlers } = useSwipeToDismiss({
    onDismiss: handleDismiss,
    enabled: !!onDismiss,
  });

  const titleInner = <span className="story-row__title-text">{title}</span>;

  const titleLooksOpened =
    titleKind === 'article' ? articleOpened : commentsOpened;

  const rowClass =
    'story-row' +
    (dragging ? ' story-row--dragging' : '') +
    (isDismissing ? ' story-row--dismissing' : '') +
    (titleLooksOpened ? ' story-row--title-opened' : '') +
    (commentsOpened ? ' story-row--comments-opened' : '');

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
            onClick={handleOpenTitle}
          >
            {titleInner}
          </a>
        ) : (
          <Link
            className="story-row__title"
            data-testid="story-title"
            to={`/item/${story.id}`}
            onClick={handleOpenTitle}
          >
            {titleInner}
          </Link>
        )}

        <span className="story-row__meta" data-testid="story-meta">
          {domainLabel ? `${domainLabel} · ` : ''}
          {points} {pluralize(points, 'point')} · {age}
        </span>
      </div>

      <Link
        to={`/item/${story.id}`}
        className="comments-btn"
        data-testid="comments-btn"
        onClick={(e) => {
          e.stopPropagation();
          handleOpenComments();
        }}
        aria-label={`${commentCount} ${pluralize(commentCount, 'comment')}`}
      >
        <span className="comments-btn__count">{commentCount}</span>
        <svg
          className="comments-btn__icon"
          viewBox="0 0 24 24"
          width="16"
          height="16"
          aria-hidden="true"
          focusable="false"
        >
          <path
            fill="currentColor"
            d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2z"
          />
        </svg>
      </Link>
    </article>
  );
}
