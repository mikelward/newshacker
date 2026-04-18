import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { HNItem } from '../lib/hn';
import type { OpenedKind } from '../lib/openedStories';
import { extractDomain, formatTimeAgo, pluralize } from '../lib/format';
import { useSwipeToDismiss } from '../hooks/useSwipeToDismiss';
import { StoryRowMenu, type StoryRowMenuItem } from './StoryRowMenu';
import './StoryListItem.css';

interface Props {
  story: HNItem;
  rank?: number;
  isLoggedIn?: boolean;
  articleOpened?: boolean;
  commentsOpened?: boolean;
  saved?: boolean;
  onDismiss?: (id: number) => void;
  onSave?: (id: number) => void;
  onUnsave?: (id: number) => void;
  onShare?: (story: HNItem) => void;
  onMarkOpened?: (id: number, kind: OpenedKind) => void;
}

export function StoryListItem({
  story,
  isLoggedIn = false,
  articleOpened = false,
  commentsOpened = false,
  saved = false,
  onDismiss,
  onSave,
  onUnsave,
  onShare,
  onMarkOpened,
}: Props) {
  const hasExternalUrl = !!story.url;
  const domain = extractDomain(story.url);
  const commentCount = story.descendants ?? 0;
  const points = story.score ?? 0;
  const age = story.time ? formatTimeAgo(story.time) : '';

  const title = story.title ?? '[untitled]';
  const domainLabel = hasExternalUrl ? domain : 'self post';

  const [menuOpen, setMenuOpen] = useState(false);

  const handleDismiss = useCallback(() => {
    onDismiss?.(story.id);
  }, [onDismiss, story.id]);

  const handleSave = useCallback(() => {
    onSave?.(story.id);
  }, [onSave, story.id]);

  const handleUnsave = useCallback(() => {
    onUnsave?.(story.id);
  }, [onUnsave, story.id]);

  const handleShare = useCallback(() => {
    onShare?.(story);
  }, [onShare, story]);

  const openMenu = useCallback(() => setMenuOpen(true), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

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
    onSwipeRight: onDismiss ? handleDismiss : undefined,
    onSwipeLeft: onSave ? handleSave : undefined,
    onLongPress: openMenu,
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

  const menuItems = useMemo<StoryRowMenuItem[]>(() => {
    const items: StoryRowMenuItem[] = [];
    if (saved && onUnsave) {
      items.push({ key: 'unsave', label: 'Unsave', onSelect: handleUnsave });
    } else if (!saved && onSave) {
      items.push({ key: 'save', label: 'Save', onSelect: handleSave });
    }
    if (onDismiss) {
      items.push({ key: 'ignore', label: 'Ignore', onSelect: handleDismiss });
    }
    if (onShare) {
      items.push({ key: 'share', label: 'Share', onSelect: handleShare });
    }
    return items;
  }, [
    saved,
    onSave,
    onUnsave,
    onDismiss,
    onShare,
    handleSave,
    handleUnsave,
    handleDismiss,
    handleShare,
  ]);

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
            className="story-row__title story-row__title--stretched"
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
            className="story-row__title story-row__title--stretched"
            data-testid="story-title"
            to={`/item/${story.id}`}
            onClick={handleOpenTitle}
          >
            {titleInner}
          </Link>
        )}

        <span className="story-row__meta" data-testid="story-meta">
          {saved ? (
            <>
              <span
                className="story-row__saved-badge"
                data-testid="saved-badge"
                aria-label="Saved"
                title="Saved"
              >
                <span aria-hidden="true">★</span> Saved
              </span>
              {' · '}
            </>
          ) : null}
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

      {menuItems.length > 0 ? (
        <StoryRowMenu
          open={menuOpen}
          title={title}
          items={menuItems}
          onClose={closeMenu}
        />
      ) : null}
    </article>
  );
}
