import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useCommentItem } from '../hooks/useItemTree';
import { useInternalLinkClick } from '../hooks/useInternalLinkClick';
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

interface Props {
  id: number;
}

export function Comment({ id }: Props) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { data: item, isLoading } = useCommentItem(id);
  const handleLinkClick = useInternalLinkClick();
  const queryClient = useQueryClient();

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
            className="comment__toolbar-button"
            tooltip="Upvote"
            aria-label="Upvote"
            aria-pressed={false}
            data-testid="comment-upvote"
            onClick={() => {
              // Placeholder — comment voting isn't wired up yet. The
              // button is here so the layout/feel of the toolbar is
              // visible in the UI.
            }}
          >
            <ToolbarUpArrowIcon />
          </TooltipButton>
          <TooltipButton
            type="button"
            className="comment__toolbar-button"
            tooltip="Downvote"
            aria-label="Downvote"
            aria-pressed={false}
            data-testid="comment-downvote"
            onClick={() => {
              // Placeholder — see Upvote above.
            }}
          >
            <ToolbarDownArrowIcon />
          </TooltipButton>
          <a
            className="comment__toolbar-button comment__toolbar-button--link"
            href={`https://news.ycombinator.com/reply?id=${id}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Reply on HN"
            title="Reply on HN"
            data-testid="comment-reply"
          >
            <ToolbarReplyIcon />
          </a>
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
