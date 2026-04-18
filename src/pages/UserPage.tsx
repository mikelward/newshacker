import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getUser } from '../lib/hn';
import { formatTimeAgo } from '../lib/format';
import { sanitizeCommentHtml } from '../lib/sanitize';
import './UserPage.css';

export function UserPage() {
  const { id } = useParams();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['user', id],
    queryFn: ({ signal }) => getUser(id ?? '', signal),
    enabled: !!id,
  });

  if (!id) {
    return <div className="page-message">Missing user id.</div>;
  }
  if (isLoading) {
    return <div className="page-message">Loading user…</div>;
  }
  if (isError) {
    return (
      <div className="page-message" role="alert">
        Failed to load user.{' '}
        <button type="button" onClick={() => refetch()} className="retry-btn">
          Retry
        </button>
      </div>
    );
  }
  if (!data) {
    return <div className="page-message">User not found.</div>;
  }

  return (
    <article className="user-page">
      <h1 className="user-page__id">{data.id}</h1>
      <dl className="user-page__stats">
        <div>
          <dt>Karma</dt>
          <dd>{data.karma.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatTimeAgo(data.created)} ago</dd>
        </div>
      </dl>
      {data.about ? (
        <div
          className="user-page__about"
          dangerouslySetInnerHTML={{ __html: sanitizeCommentHtml(data.about) }}
        />
      ) : null}
      <p className="user-page__back">
        <Link to="/top">← Back to Top</Link>
      </p>
    </article>
  );
}
