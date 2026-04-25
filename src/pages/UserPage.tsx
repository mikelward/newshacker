import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getUser, getItems, type HNItem } from '../lib/hn';
import { formatTimeAgo } from '../lib/format';
import { sanitizeCommentHtml } from '../lib/sanitize';
import { UserSkeleton } from '../components/Skeletons';
import { ErrorState, EmptyState } from '../components/States';
import './UserPage.css';

const RECENT_COMMENT_COUNT = 5;
// Over-fetch so a head full of stories or dead/deleted items still
// yields RECENT_COMMENT_COUNT comments in a single batch. One batch
// stays inside ITEMS_BATCH_SIZE = 30 and reuses the edge cache.
const RECENT_FETCH_LIMIT = 15;

function snippetText(html: string): string {
  if (typeof DOMParser === 'undefined') {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function UserPage() {
  const { id } = useParams();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['user', id],
    queryFn: ({ signal }) => getUser(id ?? '', signal),
    enabled: !!id,
  });

  const submittedHead = data?.submitted?.slice(0, RECENT_FETCH_LIMIT) ?? [];

  const { data: recentItems, isLoading: isRecentLoading } = useQuery({
    queryKey: ['user', id, 'recent', submittedHead.join(',')],
    queryFn: ({ signal }) => getItems(submittedHead, signal),
    enabled: submittedHead.length > 0,
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

  const recentComments: HNItem[] = (recentItems ?? [])
    .filter(
      (item): item is HNItem =>
        !!item &&
        item.type === 'comment' &&
        !item.deleted &&
        !item.dead &&
        !!item.text,
    )
    .slice(0, RECENT_COMMENT_COUNT);

  const hasSubmitted = submittedHead.length > 0;

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
      {/*
        TODO: future enhancements once the focused-comment view feels
        right in production. Considered and deferred as a follow-up:
          - Group recent comments by the article they were posted on,
            with the story title (linking to /item/<storyId>) as a
            heading above each group. Requires a per-comment parent
            walk to find the root story, batched per level.
          - Show the parent comment a reply was made to (one level up)
            inline above the snippet, so the reader can see what the
            user was responding to without leaving the page.
          - Render the comment cards with the same expand-in-place
            affordance the thread view uses (toggleable +/- icon),
            instead of always navigating to the focused view.
      */}
      {hasSubmitted ? (
        <section className="user-page__recent" aria-label="Recent comments">
          <h2 className="user-page__recent-heading">Recent comments</h2>
          {isRecentLoading ? (
            <p className="user-page__recent-status">Loading recent comments…</p>
          ) : recentComments.length > 0 ? (
            <ol className="user-page__recent-list">
              {recentComments.map((c) => (
                <li key={c.id}>
                  <Link
                    to={`/item/${c.id}`}
                    className="user-page__recent-item"
                  >
                    <div className="user-page__recent-body">
                      {snippetText(c.text ?? '')}
                    </div>
                    <div className="user-page__recent-meta">
                      {c.time ? `${formatTimeAgo(c.time)} ago` : ''}
                    </div>
                  </Link>
                </li>
              ))}
            </ol>
          ) : (
            <p className="user-page__recent-status">No recent comments.</p>
          )}
          <p className="user-page__recent-more">
            <a
              href={`https://news.ycombinator.com/threads?id=${encodeURIComponent(data.id)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              View all comments on Hacker News →
            </a>
          </p>
        </section>
      ) : null}
      <p className="user-page__back">
        <Link to="/top">← Back to Top</Link>
      </p>
    </article>
  );
}
