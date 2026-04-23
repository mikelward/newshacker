import { useCallback, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import type { HNItem } from '../lib/hn';
import {
  formatDisplayDomain,
  formatStoryMetaTail,
  isHotStory,
} from '../lib/format';
import { usePointerDevice } from '../hooks/usePointerDevice';
import { useSwipeToDismiss } from '../hooks/useSwipeToDismiss';
import { StoryRowMenu, type StoryRowMenuItem } from './StoryRowMenu';
import { TooltipButton } from './TooltipButton';
import './StoryListItem.css';

interface Props {
  story: HNItem;
  rank?: number;
  articleOpened?: boolean;
  commentsOpened?: boolean;
  /**
   * Total comment count at the moment the reader last opened the
   * thread. When provided, the row's meta shows a ` · N new` segment
   * for any extra comments posted since.
   */
  seenCommentCount?: number;
  pinned?: boolean;
  hidden?: boolean;
  onHide?: (id: number) => void;
  onPin?: (id: number) => void;
  onUnpin?: (id: number) => void;
  onShare?: (story: HNItem) => void;
  onOpenThread?: (id: number) => void;
}

export function StoryListItem({
  story,
  articleOpened = false,
  commentsOpened = false,
  seenCommentCount,
  pinned = false,
  hidden = false,
  onHide,
  onPin,
  onUnpin,
  onShare,
  onOpenThread,
}: Props) {
  const hasExternalUrl = !!story.url;
  const domain = formatDisplayDomain(story.url);

  const title = story.title ?? '[untitled]';
  const domainLabel = hasExternalUrl ? domain : 'self post';

  const newCommentCount =
    seenCommentCount !== undefined
      ? Math.max(0, (story.descendants ?? 0) - seenCommentCount)
      : 0;

  const hot = isHotStory(story);

  const [menuOpen, setMenuOpen] = useState(false);
  const articleRef = useRef<HTMLElement>(null);
  const pointerDevice = usePointerDevice();

  const handleHide = useCallback(() => {
    onHide?.(story.id);
  }, [onHide, story.id]);

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
    onSwipeRight: onHide ? handleHide : undefined,
    onSwipeLeft: onPin ? handlePin : undefined,
    onLongPress: openMenu,
  });

  // Right-click opens the same menu on pointer devices — the desktop
  // equivalent of touch long-press. The swipe-to-dismiss hook's own
  // onContextMenu already calls preventDefault when a long-press
  // handler is wired; we compose on top of it and only act when the
  // media query reports a hover-capable pointer, so we don't
  // double-fire on mobile where long-press also opens the menu and
  // the OS may fire a synthetic contextmenu.
  const swipeOnContextMenu = handlers.onContextMenu;
  const hasAnyMenuItem = !!(onHide || onPin || onUnpin || onShare);
  const handleContextMenu = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      swipeOnContextMenu?.(e);
      if (!pointerDevice || !hasAnyMenuItem) return;
      e.preventDefault();
      setMenuOpen(true);
    },
    [swipeOnContextMenu, pointerDevice, hasAnyMenuItem],
  );

  const rowOpened = articleOpened || commentsOpened;

  const rowClass =
    'story-row' +
    (dragging ? ' story-row--dragging' : '') +
    (isDismissing ? ' story-row--dismissing' : '') +
    (rowOpened ? ' story-row--opened' : '') +
    (hidden ? ' story-row--hidden' : '');

  const menuItems = useMemo<StoryRowMenuItem[]>(() => {
    const items: StoryRowMenuItem[] = [];
    if (pinned && onUnpin) {
      items.push({ key: 'unpin', label: 'Unpin', onSelect: handleUnpin });
    } else if (!pinned && onPin) {
      items.push({ key: 'pin', label: 'Pin', onSelect: handlePin });
    }
    if (onHide) {
      items.push({ key: 'hide', label: 'Hide', onSelect: handleHide });
    }
    if (onShare) {
      items.push({ key: 'share', label: 'Share', onSelect: handleShare });
    }
    return items;
  }, [
    pinned,
    onPin,
    onUnpin,
    onHide,
    onShare,
    handlePin,
    handleUnpin,
    handleHide,
    handleShare,
  ]);

  const pinLabel = pinned ? `Unpin ${title}` : `Pin ${title}`;

  return (
    <article
      ref={articleRef}
      className={rowClass}
      data-testid="story-row"
      style={style}
      {...handlers}
      onContextMenu={handleContextMenu}
    >
      <Link
        to={`/item/${story.id}`}
        className="story-row__body story-row__body--stretched"
        data-testid="story-title"
        onClick={handleOpenThread}
      >
        <span className="story-row__title-text">{title}</span>
        <span className="story-row__meta" data-testid="story-meta">
          {domainLabel ? `${domainLabel} · ` : ''}
          {formatStoryMetaTail({ ...story, newCommentCount })}
          {hot ? (
            <>
              {' · '}
              <span className="story-row__hot" data-testid="story-hot">
                hot
              </span>
            </>
          ) : null}
        </span>
      </Link>

      <TooltipButton
        type="button"
        className={'pin-btn' + (pinned ? ' pin-btn--active' : '')}
        data-testid="pin-btn"
        aria-pressed={pinned}
        aria-label={pinLabel}
        tooltip={pinned ? 'Unpin' : 'Pin'}
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
      </TooltipButton>

      {menuItems.length > 0 ? (
        <StoryRowMenu
          open={menuOpen}
          title={title}
          items={menuItems}
          anchorEl={articleRef.current}
          onClose={closeMenu}
        />
      ) : null}
    </article>
  );
}
