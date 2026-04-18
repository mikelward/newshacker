import { Link } from 'react-router-dom';
import type { HNItem } from '../lib/hn';
import { extractDomain, formatTimeAgo, pluralize } from '../lib/format';
import './StoryListItem.css';

interface Props {
  story: HNItem;
  rank?: number;
  isLoggedIn?: boolean;
}

export function StoryListItem({ story, isLoggedIn = false }: Props) {
  const hasExternalUrl = !!story.url;
  const domain = extractDomain(story.url);
  const commentCount = story.descendants ?? 0;
  const points = story.score ?? 0;
  const age = story.time ? formatTimeAgo(story.time) : '';

  const title = story.title ?? '[untitled]';

  const titleInner = (
    <>
      <span className="story-row__title-text">{title}</span>
      {domain ? <span className="story-row__domain">{domain}</span> : null}
    </>
  );

  return (
    <article className="story-row" data-testid="story-row">
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
