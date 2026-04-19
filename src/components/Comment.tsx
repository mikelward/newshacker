import { useState } from 'react';
import { useCommentItem } from '../hooks/useItemTree';
import { formatTimeAgo, pluralize } from '../lib/format';
import { sanitizeCommentHtml } from '../lib/sanitize';
import './Comment.css';

interface Props {
  id: number;
  depth: number;
}

const MAX_INDENT = 6;

export function Comment({ id, depth }: Props) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { data: item, isLoading } = useCommentItem(id);

  const indent = Math.min(depth, MAX_INDENT);
  const indentStyle = { marginLeft: `${indent * 12}px` };

  if (isLoading || !item) {
    return (
      <div
        className="comment comment--loading"
        data-depth={indent}
        style={indentStyle}
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
  const toggle = () => setIsExpanded((v) => !v);

  const metaParts: string[] = [];
  if (age) metaParts.push(age);
  if (hasReplies) {
    metaParts.push(
      `${kids.length} ${pluralize(kids.length, 'reply', 'replies')}`,
    );
  }
  const metaText = metaParts.join(' · ');

  return (
    <div
      className={`comment${isExpanded ? ' is-expanded' : ''}`}
      data-depth={indent}
      style={indentStyle}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest('a, button')) return;
        e.stopPropagation();
        toggle();
      }}
    >
      <div
        className={`comment__body${isExpanded ? '' : ' comment__body--clamped'}`}
        dangerouslySetInnerHTML={{ __html: sanitizeCommentHtml(item.text) }}
      />
      <div className="comment__header">
        <button
          type="button"
          className="comment__toggle"
          aria-expanded={isExpanded}
          aria-label={isExpanded ? 'Collapse comment' : 'Expand comment'}
          onClick={toggle}
        >
          {metaText}
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
              <Comment id={kidId} depth={depth + 1} />
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
