import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useCommentItem } from '../hooks/useItemTree';
import { useInternalLinkClick } from '../hooks/useInternalLinkClick';
import { useVote } from '../hooks/useVote';
import { prefetchCommentBatch } from '../lib/commentPrefetch';
import { formatTimeAgo, pluralize } from '../lib/format';
import { getItems } from '../lib/hn';
import { sanitizeCommentHtml } from '../lib/sanitize';
import { TooltipButton } from './TooltipButton';
import './Comment.css';

const MS_VIEWBOX = '0 -960 960 960';

function ToolbarUpArrowIcon() {
  return (
    <svg
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="22"
      height="22"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M480-720 220-320h520L480-720Z" />
    </svg>
  );
}

function ToolbarDownArrowIcon() {
  return (
    <svg
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="22"
      height="22"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M480-240 220-640h520L480-240Z" />
    </svg>
  );
}

function ToolbarReplyIcon() {
  return (
    <svg
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="22"
      height="22"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M760-200v-160q0-50-35-85t-85-35H273l144 144-57 57-241-241 241-241 57 57-144 144h367q83 0 141.5 58.5T840-360v160h-80Z" />
    </svg>
  );
}

function ToolbarCollapseIcon() {
  return (
    <svg
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="22"
      height="22"
      aria-hidden="true"
      focusable="false"
    >
      {/* Material Symbols `expand_circle_up` — Apache 2.0, Google. */}
      <path d="m357-384 123-123 123 123 57-56-180-180-180 180 57 56ZM480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z" />
    </svg>
  );
}

interface Props {
  id: number;
}

export function Comment({ id }: Props) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { data: item, isLoading } = useCommentItem(id);
  const handleLinkClick = useInternalLinkClick();
  const queryClient = useQueryClient();
  const { isVoted, isDownvoted, toggleVote, toggleDownvote } = useVote();
  const voted = isVoted(id);
  const downvoted = isDownvoted(id);

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

  return (
    <div
      className={`comment${isExpanded ? ' is-expanded' : ''}`}
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
        {isExpanded ? (
          // When expanded, the explicit collapse control is the
          // trailing button in `.comment__toolbar` (bottom-right of
          // the expanded card), so the meta row here is plain text.
          // Tapping anywhere else on the card still collapses via
          // the row's onClick handler.
          <span className="comment__meta">{metaSuffix}</span>
        ) : (
          <button
            type="button"
            className="comment__toggle"
            aria-expanded={false}
            aria-label="Expand comment"
            onClick={toggle}
          >
            <span className="comment__toggle-text">{metaSuffix}</span>
            {/* Expand affordance pinned to the card's bottom-right
                corner (via margin-left: auto in Comment.css).
                Material Symbols `expand_circle_down` — the circled
                chevron reads as "expand this" unambiguously, and
                the card-corner placement keeps it out of the meta
                text. On expand, the matching collapse chevron is
                the last button in the toolbar strip below. */}
            <span
              className="comment__toggle-icon"
              data-expanded="false"
              aria-hidden="true"
            >
              <svg
                viewBox="0 -960 960 960"
                fill="currentColor"
                width="22"
                height="22"
                focusable="false"
              >
                <path d="m480-340 180-180-57-56-123 123-123-123-57 56 180 180Zm0 260q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z" />
              </svg>
            </span>
          </button>
        )}
      </div>
      {isExpanded ? (
        <div
          className="comment__toolbar"
          onClick={(e) => {
            // Keeps a tap on the strip's dead space between buttons
            // from reaching the row's toggle handler and collapsing
            // the comment. Button/link taps already bail out via the
            // row's closest('a, button') guard.
            e.stopPropagation();
          }}
        >
          <TooltipButton
            type="button"
            className={
              'comment__toolbar-button' +
              (voted ? ' comment__toolbar-button--active' : '')
            }
            tooltip={voted ? 'Unvote' : 'Upvote'}
            aria-label={voted ? 'Unvote' : 'Upvote'}
            aria-pressed={voted}
            data-testid="comment-upvote"
            onClick={() => toggleVote(id)}
          >
            <ToolbarUpArrowIcon />
          </TooltipButton>
          {/* Downvote — HN gates the `how=down` anchor behind ~500
              karma and some per-item rules (own posts, etc). For
              low-karma viewers the scrape step in /api/vote returns
              502 and useVote surfaces a toast. We don't pre-check
              that; it would cost an extra item-page fetch per
              render for a minority case. */}
          <TooltipButton
            type="button"
            className={
              'comment__toolbar-button' +
              (downvoted ? ' comment__toolbar-button--active' : '')
            }
            tooltip={downvoted ? 'Undownvote' : 'Downvote'}
            aria-label={downvoted ? 'Undownvote' : 'Downvote'}
            aria-pressed={downvoted}
            data-testid="comment-downvote"
            onClick={() => toggleDownvote(id)}
          >
            <ToolbarDownArrowIcon />
          </TooltipButton>
          <a
            className="comment__toolbar-button"
            href={`https://news.ycombinator.com/reply?id=${id}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Reply on HN"
            title="Reply on HN"
            data-testid="comment-reply"
          >
            <ToolbarReplyIcon />
          </a>
          {/* Collapse chevron pinned to the toolbar's right edge via
              `margin-left: auto`. Mirrors the collapsed-state chevron
              at the card's bottom-right corner so "bottom-right =
              (un)collapse" is the same rule in both states. */}
          <TooltipButton
            type="button"
            className="comment__toolbar-button comment__toolbar-button--collapse"
            tooltip="Collapse comment"
            aria-label="Collapse comment"
            aria-expanded={true}
            data-testid="comment-collapse"
            onClick={toggle}
          >
            <ToolbarCollapseIcon />
          </TooltipButton>
        </div>
      ) : null}
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
