import { Link } from 'react-router-dom';
import { useItemTree } from '../hooks/useItemTree';
import { extractDomain, formatTimeAgo, pluralize } from '../lib/format';
import { sanitizeCommentHtml } from '../lib/sanitize';
import { Comment } from './Comment';
import './Thread.css';

interface Props {
  id: number;
}

export function Thread({ id }: Props) {
  const { data, isLoading, isError, refetch } = useItemTree(id);

  if (isLoading) {
    return (
      <div className="thread" aria-busy="true">
        <div className="thread__skeleton" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="page-message" role="alert">
        <p>Could not load thread.</p>
        <button type="button" className="retry-btn" onClick={() => refetch()}>
          Retry
        </button>
      </div>
    );
  }
  if (!data) {
    return <div className="page-message">Item not found.</div>;
  }

  const { item, children } = data;

  if (item.deleted || item.dead) {
    return (
      <div className="thread">
        <header className="thread__header">
          <h1 className="thread__title">
            {item.deleted ? '[deleted]' : '[dead]'}
          </h1>
        </header>
      </div>
    );
  }

  const domain = extractDomain(item.url);
  const age = item.time ? formatTimeAgo(item.time) : '';
  const points = item.score ?? 0;
  const commentCount = item.descendants ?? 0;

  return (
    <article className="thread">
      <header className="thread__header">
        <h1 className="thread__title">{item.title ?? '[untitled]'}</h1>
        {item.url ? (
          <a
            className="thread__read-article"
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Read article{domain ? ` · ${domain}` : ''}
          </a>
        ) : null}
        <div className="thread__meta">
          <span>
            {points} {pluralize(points, 'point')}
          </span>
          {item.by ? (
            <>
              <span aria-hidden="true"> · </span>
              <Link to={`/user/${item.by}`} className="thread__author">
                {item.by}
              </Link>
            </>
          ) : null}
          {age ? (
            <>
              <span aria-hidden="true"> · </span>
              <span>{age}</span>
            </>
          ) : null}
        </div>
        {item.text ? (
          <div
            className="thread__text"
            dangerouslySetInnerHTML={{ __html: sanitizeCommentHtml(item.text) }}
          />
        ) : null}
        <div className="thread__comment-count">
          {commentCount} {pluralize(commentCount, 'comment')}
        </div>
      </header>
      <ol className="thread__comments">
        {children.map((c) => (
          <li key={c.item.id}>
            <Comment node={c} depth={0} />
          </li>
        ))}
      </ol>
    </article>
  );
}
