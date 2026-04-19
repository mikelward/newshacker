import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { HNItem } from '../lib/hn';
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
  dismissed?: boolean;
  onDismiss?: (id: number) => void;
  onSave?: (id: number) => void;
  onUnsave?: (id: number) => void;
  onShare?: (story: HNItem) => void;
  onOpenThread?: (id: number) => void;
}

export function StoryListItem({
  story,
  isLoggedIn = false,
  articleOpened = false,
  commentsOpened = false,
  saved = false,
  dismissed = false,
  onDismiss,
  onSave,
  onUnsave,
  onShare,
  onOpenThread,
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

  const handleOpenThread = useCallback(() => {
    onOpenThread?.(story.id);
  }, [onOpenThread, story.id]);

  const handleToggleStar = useCallback(() => {
    if (saved) onUnsave?.(story.id);
    else onSave?.(story.id);
  }, [saved, onSave, onUnsave, story.id]);

  const { dragging, isDismissing, style, handlers } = useSwipeToDismiss({
    onSwipeRight: onDismiss ? handleDismiss : undefined,
    onSwipeLeft: onSave ? handleSave : undefined,
    onLongPress: openMenu,
  });

  const rowOpened = articleOpened || commentsOpened;

  const rowClass =
    'story-row' +
    (dragging ? ' story-row--dragging' : '') +
    (isDismissing ? ' story-row--dismissing' : '') +
    (rowOpened ? ' story-row--opened' : '') +
    (dismissed ? ' story-row--dismissed' : '');

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

  const starLabel = saved ? `Unsave ${title}` : `Save ${title}`;

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

      <Link
        to={`/item/${story.id}`}
        className="story-row__body story-row__body--stretched"
        data-testid="story-title"
        onClick={handleOpenThread}
      >
        <span className="story-row__title-text">{title}</span>
        <span className="story-row__meta" data-testid="story-meta">
          {domainLabel ? `${domainLabel} · ` : ''}
          {points} {pluralize(points, 'point')} · {commentCount}{' '}
          {pluralize(commentCount, 'comment')} · {age}
        </span>
      </Link>

      <button
        type="button"
        className={'star-btn' + (saved ? ' star-btn--active' : '')}
        data-testid="star-btn"
        aria-pressed={saved}
        aria-label={starLabel}
        title={saved ? 'Saved' : 'Save'}
        onClick={handleToggleStar}
      >
        <svg
          className="star-btn__icon"
          viewBox="0 0 24 24"
          width="22"
          height="22"
          aria-hidden="true"
          focusable="false"
        >
          <path
            fill={saved ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
            d="M12 3.6l2.6 5.3 5.9.9-4.3 4.2 1 5.8L12 17l-5.2 2.8 1-5.8L3.5 9.8l5.9-.9z"
          />
        </svg>
      </button>

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
