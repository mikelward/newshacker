import { useCallback, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../hooks/useAuth';
import { useCommentItem } from '../hooks/useItemTree';
import { useInternalLinkClick } from '../hooks/useInternalLinkClick';
import { usePointerDevice } from '../hooks/usePointerDevice';
import { useSwipeToDismiss } from '../hooks/useSwipeToDismiss';
import { useVote } from '../hooks/useVote';
import { prefetchCommentBatch } from '../lib/commentPrefetch';
import { formatTimeAgo, pluralize } from '../lib/format';
import { getItems } from '../lib/hn';
import { sanitizeCommentHtml } from '../lib/sanitize';
import { StoryRowMenu, type StoryRowMenuItem } from './StoryRowMenu';
import { TooltipButton } from './TooltipButton';
import './Comment.css';

interface Props {
  id: number;
}

export function Comment({ id }: Props) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { data: item, isLoading } = useCommentItem(id);
  const handleLinkClick = useInternalLinkClick();
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuth();
  const { isVoted, isDownvoted, toggleVote, toggleDownvote } = useVote();
  const upvoted = isVoted(id);
  const downvoted = isDownvoted(id);

  const articleRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // openMenu is unconditional — used by the long-press and right-
  // click paths where the viewer is asking the menu to appear and
  // wouldn't expect a second gesture to dismiss it. toggleMenu is
  // the ⋮ button's onClick: StoryRowMenu's click-outside handler
  // deliberately ignores anchor clicks (so the anchor can act as a
  // toggle), so without a toggling onClick here tapping the ⋮
  // again would be a no-op instead of closing.
  const openMenu = useCallback(() => setMenuOpen(true), []);
  const toggleMenu = useCallback(() => setMenuOpen((open) => !open), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const pointerDevice = usePointerDevice();

  // Long-press anywhere on the comment row opens the same overflow
  // menu the ⋮ button does — parallels StoryListItem and gives a
  // second affordance besides the explicit icon. We pass no swipe
  // handlers here because the comment row already owns the click =
  // expand/collapse gesture; layering swipe-to-dismiss on top would
  // contend with vertical scroll and confuse the toggle.
  const { handlers } = useSwipeToDismiss({ onLongPress: openMenu });
  const swipeOnContextMenu = handlers.onContextMenu;

  // Right-click opens the menu on pointer devices (the desktop
  // equivalent of long-press). The menu uses the ⋮ button as its
  // anchor when that ref is mounted; in the unlikely case it isn't,
  // StoryRowMenu receives a null anchorEl and falls back to its
  // bottom-sheet variant. We also forward the event to
  // useSwipeToDismiss's own onContextMenu — the hook suppresses the
  // OS context menu in the moment after a touch-triggered long-press,
  // and overwriting handlers.onContextMenu here would silently drop
  // that suppression and let both our in-app menu and the OS menu
  // show at once on touch devices.
  const handleContextMenu = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      swipeOnContextMenu?.(e);
      if (!pointerDevice) return;
      e.preventDefault();
      openMenu();
    },
    [swipeOnContextMenu, pointerDevice, openMenu],
  );

  const menuItems = useMemo<StoryRowMenuItem[]>(() => {
    const items: StoryRowMenuItem[] = [];
    if (isAuthenticated) {
      // `--active` highlights the Unvote / Undownvote item in
      // --nh-orange when the viewer has already voted that direction,
      // so the menu itself is a second "which way did I vote?" signal
      // alongside the row's left-edge accent.
      items.push({
        key: 'upvote',
        label: upvoted ? 'Unvote' : 'Upvote',
        onSelect: () => toggleVote(id),
        className: upvoted ? 'story-menu__item--active' : undefined,
      });
      // Always offered when signed in; if the viewer lacks the karma
      // HN requires for that item, the API surfaces a 502 and the
      // hook toasts. Pre-checking would cost an extra item-page fetch
      // per menu open, which isn't worth the rare-case win.
      items.push({
        key: 'downvote',
        label: downvoted ? 'Undownvote' : 'Downvote',
        onSelect: () => toggleDownvote(id),
        className: downvoted ? 'story-menu__item--active' : undefined,
      });
    }
    items.push({
      key: 'reply-on-hn',
      label: 'Reply on HN ↗',
      onSelect: () => {
        window.open(
          `https://news.ycombinator.com/reply?id=${id}`,
          '_blank',
          'noopener,noreferrer',
        );
      },
    });
    return items;
  }, [
    id,
    isAuthenticated,
    upvoted,
    downvoted,
    toggleVote,
    toggleDownvote,
  ]);

  if (isLoading || !item) {
    return (
      <div
        className="comment comment--loading"
        aria-busy="true"
      >
        <div className="comment__header">
          <span className="comment__author">…</span>
        </div>
      </div>
    );
  }

  if (item.deleted || item.dead || !item.text) {
    return null;
  }

  const age = item.time ? formatTimeAgo(item.time) : '';
  const kids = item.kids ?? [];
  const hasReplies = kids.length > 0;
  // On expand, warm this comment's children in one /api/items batch
  // before rendering them, so the recursive <Comment> observers find
  // cache hits instead of each firing their own Firebase fetch. Ids
  // already cached (e.g. re-expand) skip the network entirely.
  const toggle = () => {
    if (isExpanded) {
      setIsExpanded(false);
      return;
    }
    if (kids.length === 0) {
      setIsExpanded(true);
      return;
    }
    const uncached = kids.filter(
      (kid) => !queryClient.getQueryData(['comment', kid]),
    );
    if (uncached.length === 0) {
      setIsExpanded(true);
      return;
    }
    prefetchCommentBatch(queryClient, uncached, getItems).finally(() => {
      setIsExpanded(true);
    });
  };

  const metaParts: string[] = [];
  if (age) metaParts.push(age);
  if (hasReplies) {
    metaParts.push(
      `${kids.length} ${pluralize(kids.length, 'reply', 'replies')}`,
    );
  }
  const metaSuffix = metaParts.length ? ` · ${metaParts.join(' · ')}` : '';

  // The voted-state class on the row provides a faint orange/red
  // border accent so the reader can see at a glance which comments
  // they've acted on, without needing to expand each one.
  const voteStateClass = upvoted
    ? ' comment--upvoted'
    : downvoted
      ? ' comment--downvoted'
      : '';

  return (
    <div
      ref={articleRef}
      className={`comment${isExpanded ? ' is-expanded' : ''}${voteStateClass}`}
      {...handlers}
      onContextMenu={handleContextMenu}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest('a, button')) return;
        e.stopPropagation();
        toggle();
      }}
    >
      <div
        className={`comment__body${isExpanded ? '' : ' comment__body--clamped'}`}
        onClick={handleLinkClick}
        dangerouslySetInnerHTML={{ __html: sanitizeCommentHtml(item.text) }}
      />
      <div className="comment__header">
        {item.by ? (
          <Link to={`/user/${item.by}`} className="comment__author">
            {item.by}
          </Link>
        ) : null}
        <button
          type="button"
          className="comment__toggle"
          aria-expanded={isExpanded}
          aria-label={isExpanded ? 'Collapse comment' : 'Expand comment'}
          onClick={toggle}
        >
          <span className="comment__toggle-text">{metaSuffix}</span>
          {/* Expand/collapse affordance at the end of the meta line.
              Material Symbols `add`/`remove` so collapsed → "+" and
              expanded → "−"; visible on every device so the control
              is obvious regardless of whether the reader tries to
              tap the card body or aim for the icon. */}
          <span
            className="comment__toggle-icon"
            data-expanded={isExpanded ? 'true' : 'false'}
            aria-hidden="true"
          >
            <svg
              viewBox="0 -960 960 960"
              fill="currentColor"
              width="18"
              height="18"
              focusable="false"
            >
              {isExpanded ? (
                <path d="M200-440v-80h560v80H200Z" />
              ) : (
                <path d="M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z" />
              )}
            </svg>
          </span>
        </button>
        <TooltipButton
          ref={menuBtnRef}
          type="button"
          className="comment__menu-btn"
          data-testid={`comment-menu-${id}`}
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          tooltip="More actions"
          onClick={toggleMenu}
        >
          <svg
            className="comment__menu-icon"
            viewBox="0 -960 960 960"
            fill="currentColor"
            width="18"
            height="18"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M480-160q-33 0-56.5-23.5T400-240q0-33 23.5-56.5T480-320q33 0 56.5 23.5T560-240q0 33-23.5 56.5T480-160Zm0-240q-33 0-56.5-23.5T400-480q0-33 23.5-56.5T480-560q33 0 56.5 23.5T560-480q0 33-23.5 56.5T480-400Zm0-240q-33 0-56.5-23.5T400-720q0-33 23.5-56.5T480-800q33 0 56.5 23.5T560-720q0 33-23.5 56.5T480-640Z" />
          </svg>
        </TooltipButton>
      </div>
      <StoryRowMenu
        open={menuOpen}
        title="Comment actions"
        items={menuItems}
        anchorEl={menuBtnRef.current}
        onClose={closeMenu}
      />
      {hasReplies && isExpanded ? (
        <ol className="comment__children">
          {kids.map((kidId) => (
            <li key={kidId}>
              <Comment id={kidId} />
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
