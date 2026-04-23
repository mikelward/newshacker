import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useCommentItem } from '../hooks/useItemTree';
import { useInternalLinkClick } from '../hooks/useInternalLinkClick';
import { prefetchCommentBatch } from '../lib/commentPrefetch';
import { formatTimeAgo, pluralize } from '../lib/format';
import { getItems } from '../lib/hn';
import { sanitizeCommentHtml } from '../lib/sanitize';
import './Comment.css';

interface Props {
  id: number;
  /**
   * True when this comment was posted after the reader's last visit
   * to the thread. Used to add a small "new" marker next to the
   * author, so new comments are easy to spot whether or not the
   * "New" filter is active. Only passed for top-level comments today
   * — nested replies aren't classified in v1 (see TODO.md).
   */
  isNew?: boolean;
}

export function Comment({ id, isNew = false }: Props) {
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
      className={
        'comment' +
        (isExpanded ? ' is-expanded' : '') +
        (isNew ? ' comment--new' : '')
      }
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
        {isNew ? (
          <span className="comment__new-badge" data-testid="comment-new-badge">
            new
          </span>
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
        {isExpanded ? (
          <a
            className="comment__action"
            href={`https://news.ycombinator.com/reply?id=${id}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Reply on HN ↗
          </a>
        ) : null}
      </div>
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
