import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../hooks/useAuth';
import { useCommentItem } from '../hooks/useItemTree';
import { useInternalLinkClick } from '../hooks/useInternalLinkClick';
import { useVote } from '../hooks/useVote';
import { prefetchCommentBatch } from '../lib/commentPrefetch';
import { formatTimeAgo, pluralize } from '../lib/format';
import { getItems } from '../lib/hn';
import { sanitizeCommentHtml } from '../lib/sanitize';
import { TooltipButton } from './TooltipButton';
import './Comment.css';

function UpArrowIcon() {
  return (
    <svg
      className="comment__action-icon"
      viewBox="0 -960 960 960"
      fill="currentColor"
      width="24"
      height="24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M480-720 220-320h520L480-720Z" />
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
  const { isAuthenticated } = useAuth();
  const { isVoted, toggleVote } = useVote();
  const voted = isVoted(id);
  const handleToggleVote = useCallback(() => {
    toggleVote(id);
  }, [id, toggleVote]);

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
          {metaSuffix}
        </button>
      </div>
      {isExpanded ? (
        <div className="comment__actions" data-testid="comment-actions">
          {isAuthenticated ? (
            <TooltipButton
              type="button"
              className={
                'comment__action-button' +
                (voted ? ' comment__action-button--active' : '')
              }
              data-testid="comment-vote"
              aria-pressed={voted}
              aria-label={voted ? 'Undo upvote' : 'Upvote comment'}
              tooltip={voted ? 'Undo upvote' : 'Upvote'}
              onClick={handleToggleVote}
            >
              <UpArrowIcon />
              <span className="comment__action-label">
                {voted ? 'Upvoted' : 'Upvote'}
              </span>
            </TooltipButton>
          ) : null}
          <a
            className="comment__action-button"
            data-testid="comment-reply"
            href={`https://news.ycombinator.com/reply?id=${id}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="comment__action-label">Reply on HN ↗</span>
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
