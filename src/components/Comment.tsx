import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CommentNode } from '../hooks/useItemTree';
import { formatTimeAgo } from '../lib/format';
import { sanitizeCommentHtml } from '../lib/sanitize';
import './Comment.css';

interface Props {
  node: CommentNode;
  depth: number;
}

const MAX_INDENT = 6;

export function Comment({ node, depth }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const { item, children } = node;

  const isDead = item.deleted || item.dead;
  const age = item.time ? formatTimeAgo(item.time) : '';
  const indent = Math.min(depth, MAX_INDENT);

  return (
    <div
      className={`comment${collapsed ? ' is-collapsed' : ''}`}
      data-depth={indent}
      style={{ marginLeft: `${indent * 12}px` }}
    >
      <div className="comment__header">
        <button
          type="button"
          className="comment__toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand comment' : 'Collapse comment'}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? '+' : '−'}
        </button>
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
          {collapsed && children.length > 0 ? (
            <span className="comment__count">
              {' '}
              [{countDescendants(node)}]
            </span>
          ) : null}
        </div>
      </div>
      {!collapsed && !isDead && item.text ? (
        <div
          className="comment__body"
          dangerouslySetInnerHTML={{ __html: sanitizeCommentHtml(item.text) }}
        />
      ) : null}
      {!collapsed && children.length > 0 ? (
        <ol className="comment__children">
          {children.map((c) => (
            <li key={c.item.id}>
              <Comment node={c} depth={depth + 1} />
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function countDescendants(node: CommentNode): number {
  let n = node.children.length;
  for (const c of node.children) {
    n += countDescendants(c);
  }
  return n;
}
