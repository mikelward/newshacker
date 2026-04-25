import { useMemo } from 'react';
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
// Hard cap on parent-walk levels. HN nesting rarely exceeds ~5 in
// practice; the cap guards against a malformed parent chain looping
// forever. Each level is one /api/items batch, dedup'd across
// comments and skipped when the next-ancestor id is already in the
// local cache.
const MAX_PARENT_WALK_LEVELS = 10;

function snippetText(html: string): string {
  if (typeof DOMParser === 'undefined') {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

// Walk each comment up its parent chain to find the root story it
// lives under. Fetches one /api/items batch per level so all comments
// at the same depth share a single round trip; items already resolved
// (the comments themselves, or a cousin's parent) are skipped. A
// comment whose walk hits a missing item or the depth cap resolves to
// null; the caller groups those separately rather than dropping them.
async function findRootStories(
  comments: HNItem[],
  signal?: AbortSignal,
): Promise<Record<number, HNItem | null>> {
  const itemCache = new Map<number, HNItem>();
  for (const c of comments) itemCache.set(c.id, c);

  type Frontier = { commentId: number; nextId: number | undefined };
  let frontier: Frontier[] = comments.map((c) => ({
    commentId: c.id,
    nextId: c.parent,
  }));

  const rootByCommentId: Record<number, HNItem | null> = {};

  for (
    let level = 0;
    level < MAX_PARENT_WALK_LEVELS && frontier.length > 0;
    level++
  ) {
    const idsToFetch = Array.from(
      new Set(
        frontier
          .filter((f) => f.nextId !== undefined && !itemCache.has(f.nextId))
          .map((f) => f.nextId as number),
      ),
    );
    if (idsToFetch.length > 0) {
      // `fields: 'full'` keeps `parent` on each fetched ancestor so
      // the next level's frontier can keep walking. Without it the
      // /api/items proxy thins the response and we'd never find the
      // root story — every comment would resolve to a null root.
      const fetched = await getItems(idsToFetch, signal, { fields: 'full' });
      idsToFetch.forEach((fetchedId, i) => {
        const it = fetched[i];
        if (it) itemCache.set(fetchedId, it);
      });
    }
    const next: Frontier[] = [];
    for (const f of frontier) {
      if (f.nextId === undefined) {
        rootByCommentId[f.commentId] = null;
        continue;
      }
      const it = itemCache.get(f.nextId);
      if (!it) {
        rootByCommentId[f.commentId] = null;
        continue;
      }
      if (it.type === 'story') {
        rootByCommentId[f.commentId] = it;
        continue;
      }
      next.push({ commentId: f.commentId, nextId: it.parent });
    }
    frontier = next;
  }
  for (const f of frontier) {
    if (!(f.commentId in rootByCommentId)) {
      rootByCommentId[f.commentId] = null;
    }
  }
  return rootByCommentId;
}

interface CommentGroup {
  story: HNItem | null;
  comments: HNItem[];
}

// Groups the comments by their resolved root story, preserving the
// input order both for the groups (first comment for each story sets
// that story's position) and for the comments within a group.
// Comments whose root couldn't be resolved share a single null-story
// group rendered without a heading.
function groupByStory(
  comments: HNItem[],
  rootByCommentId: Record<number, HNItem | null>,
): CommentGroup[] {
  const groups = new Map<string, CommentGroup>();
  for (const c of comments) {
    const story = rootByCommentId[c.id] ?? null;
    const key = story ? `s:${story.id}` : 'unknown';
    let group = groups.get(key);
    if (!group) {
      group = { story, comments: [] };
      groups.set(key, group);
    }
    group.comments.push(c);
  }
  return Array.from(groups.values());
}

export function UserPage() {
  const { id } = useParams();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['user', id],
    queryFn: ({ signal }) => getUser(id ?? '', signal),
    enabled: !!id,
  });

  const submittedHead = useMemo(
    () => data?.submitted?.slice(0, RECENT_FETCH_LIMIT) ?? [],
    [data?.submitted],
  );

  const {
    data: recentItems,
    isLoading: isRecentLoading,
    isError: isRecentError,
    refetch: refetchRecent,
  } = useQuery({
    queryKey: ['user', id, 'recent', submittedHead.join(',')],
    // `fields: 'full'` keeps `parent` (and `kids`) on the response.
    // The default `/api/items` thinning strips both, which would leave
    // every comment with `parent === undefined` and make the parent-
    // chain walk below resolve every comment to a null root — the
    // grouping would collapse into one unheaded fallback group.
    queryFn: ({ signal }) => getItems(submittedHead, signal, { fields: 'full' }),
    enabled: submittedHead.length > 0,
  });

  const recentComments: HNItem[] = useMemo(
    () =>
      (recentItems ?? [])
        .filter(
          (item): item is HNItem =>
            !!item &&
            item.type === 'comment' &&
            !item.deleted &&
            !item.dead &&
            !!item.text,
        )
        .slice(0, RECENT_COMMENT_COUNT),
    [recentItems],
  );

  const recentCommentKey = recentComments.map((c) => c.id).join(',');

  const {
    data: walkData,
    isLoading: isWalkLoading,
    isError: isWalkError,
  } = useQuery({
    queryKey: ['user', id, 'recent-roots', recentCommentKey],
    queryFn: ({ signal }) => findRootStories(recentComments, signal),
    enabled: recentComments.length > 0,
  });

  // If the walk fails (network/proxy error, hit rate limit, etc.) we
  // still have the comments themselves in hand — the walk is only
  // about resolving article context. Degrade gracefully: synthesize a
  // map where every comment resolves to a null root, so groupByStory
  // produces one unheaded fallback group containing the whole list.
  // The reader sees the snippets without article headings, which is
  // strictly better than the previous behavior (the section flashed
  // "No recent comments." even though the comment fetch had succeeded).
  const rootByCommentId: Record<number, HNItem | null> | undefined = walkData
    ?? (isWalkError
      ? Object.fromEntries(recentComments.map((c) => [c.id, null]))
      : undefined);

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

  const hasSubmitted = submittedHead.length > 0;
  const sectionLoading =
    isRecentLoading || (recentComments.length > 0 && isWalkLoading);
  const groups = rootByCommentId
    ? groupByStory(recentComments, rootByCommentId)
    : [];

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
      {hasSubmitted ? (
        <section className="user-page__recent" aria-label="Recent comments">
          <h2 className="user-page__recent-heading">Recent comments</h2>
          {sectionLoading ? (
            <p className="user-page__recent-status">Loading recent comments…</p>
          ) : isRecentError ? (
            <ErrorState
              message="Could not load recent comments."
              onRetry={() => refetchRecent()}
            />
          ) : groups.length > 0 ? (
            <ol className="user-page__recent-groups">
              {groups.map((g) => (
                <li
                  key={g.story?.id ?? 'unknown'}
                  className="user-page__recent-group"
                >
                  {g.story ? (
                    <h3 className="user-page__recent-group-title">
                      <Link to={`/item/${g.story.id}`}>
                        {g.story.title ?? '[untitled]'}
                      </Link>
                    </h3>
                  ) : null}
                  <ol className="user-page__recent-list">
                    {g.comments.map((c) => (
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
