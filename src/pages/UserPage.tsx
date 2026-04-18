import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getUser } from '../lib/hn';
import { formatTimeAgo } from '../lib/format';
import { sanitizeCommentHtml } from '../lib/sanitize';
import { UserSkeleton } from '../components/Skeletons';
import { ErrorState, EmptyState } from '../components/States';
import './UserPage.css';

export function UserPage() {
  const { id } = useParams();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['user', id],
    queryFn: ({ signal }) => getUser(id ?? '', signal),
    enabled: !!id,
  });

  if (!id) {
    return <EmptyState message="Missing user id." />;
  }
  if (isLoading) {
    return (
      <div aria-busy="true" aria-label="Loading user">
        <UserSkeleton />
      </div>
    );
  }
  if (isError) {
    return <ErrorState message="Could not load user." onRetry={() => refetch()} />;
  }
  if (!data) {
    return <EmptyState message="User not found." />;
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
