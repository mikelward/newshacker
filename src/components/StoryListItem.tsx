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
  pinned?: boolean;
  dismissed?: boolean;
  onDismiss?: (id: number) => void;
  onPin?: (id: number) => void;
  onUnpin?: (id: number) => void;
  onShare?: (story: HNItem) => void;
  onOpenThread?: (id: number) => void;
}

export function StoryListItem({
  story,
  isLoggedIn = false,
  articleOpened = false,
  commentsOpened = false,
  pinned = false,
  dismissed = false,
  onDismiss,
  onPin,
  onUnpin,
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

  const handlePin = useCallback(() => {
    onPin?.(story.id);
  }, [onPin, story.id]);

  const handleUnpin = useCallback(() => {
    onUnpin?.(story.id);
  }, [onUnpin, story.id]);

  const handleShare = useCallback(() => {
    onShare?.(story);
  }, [onShare, story]);

  const openMenu = useCallback(() => setMenuOpen(true), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  const handleOpenThread = useCallback(() => {
    onOpenThread?.(story.id);
  }, [onOpenThread, story.id]);

  const handleTogglePin = useCallback(() => {
    if (pinned) onUnpin?.(story.id);
    else onPin?.(story.id);
  }, [pinned, onPin, onUnpin, story.id]);

  const { dragging, isDismissing, style, handlers } = useSwipeToDismiss({
    onSwipeRight: onDismiss ? handleDismiss : undefined,
    onSwipeLeft: onPin ? handlePin : undefined,
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
    if (pinned && onUnpin) {
      items.push({ key: 'unpin', label: 'Unpin', onSelect: handleUnpin });
    } else if (!pinned && onPin) {
      items.push({ key: 'pin', label: 'Pin', onSelect: handlePin });
    }
    if (onDismiss) {
      items.push({ key: 'ignore', label: 'Ignore', onSelect: handleDismiss });
    }
    if (onShare) {
      items.push({ key: 'share', label: 'Share', onSelect: handleShare });
    }
    return items;
  }, [
    pinned,
    onPin,
    onUnpin,
    onDismiss,
    onShare,
    handlePin,
    handleUnpin,
    handleDismiss,
    handleShare,
  ]);

  const pinLabel = pinned ? `Unpin ${title}` : `Pin ${title}`;

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
        className={'pin-btn' + (pinned ? ' pin-btn--active' : '')}
        data-testid="pin-btn"
        aria-pressed={pinned}
        aria-label={pinLabel}
        title={pinned ? 'Unpin' : 'Pin'}
        onClick={handleTogglePin}
      >
        <svg
          className="pin-btn__icon"
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="currentColor"
          aria-hidden="true"
          focusable="false"
        >
          {/* Material Icons push_pin — Apache 2.0, Google. */}
          {pinned ? (
            <path d="M16 9V4l1 0c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1l1 0v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z" />
          ) : (
            <path d="M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7c-.55 0-1 .45-1 1s.45 1 1 1l1 0v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4l1 0c.55 0 1-.45 1-1s-.45-1-1-1z" />
          )}
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
