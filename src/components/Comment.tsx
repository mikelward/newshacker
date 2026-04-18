import { useState } from 'react';
import { Link } from 'react-router-dom';
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
  const [repliesCollapsed, setRepliesCollapsed] = useState(true);
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
          <div className="comment__meta">
            <span className="comment__author">…</span>
          </div>
        </div>
      </div>
    );
  }

  const isDead = item.deleted || item.dead;
  const age = item.time ? formatTimeAgo(item.time) : '';
  const kids = item.kids ?? [];
  const hasReplies = kids.length > 0;

  return (
    <div
      className={`comment${repliesCollapsed ? ' is-collapsed' : ''}`}
      data-depth={indent}
      style={indentStyle}
    >
      <div className="comment__header">
        {hasReplies ? (
          <button
            type="button"
            className="comment__toggle"
            aria-expanded={!repliesCollapsed}
            aria-label={
              repliesCollapsed
                ? `Show ${kids.length} ${pluralize(kids.length, 'reply', 'replies')}`
                : `Hide ${kids.length} ${pluralize(kids.length, 'reply', 'replies')}`
            }
            onClick={() => setRepliesCollapsed((c) => !c)}
          >
            {repliesCollapsed ? '+' : '−'}
          </button>
        ) : null}
        <div className="comment__meta">
          {item.by && !isDead ? (
            <Link to={`/user/${item.by}`} className="comment__author">
              {item.by}
            </Link>
          ) : (
            <span className="comment__author">
              {item.deleted ? '[deleted]' : item.dead ? '[dead]' : ''}
            </span>
          )}
          {age ? <span className="comment__age"> · {age}</span> : null}
          {hasReplies && repliesCollapsed ? (
            <span className="comment__count">
              {' '}
              · {kids.length} {pluralize(kids.length, 'reply', 'replies')}
            </span>
          ) : null}
        </div>
      </div>
      {!isDead && item.text ? (
        <div
          className="comment__body"
          dangerouslySetInnerHTML={{ __html: sanitizeCommentHtml(item.text) }}
        />
      ) : null}
      {hasReplies && !repliesCollapsed ? (
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
