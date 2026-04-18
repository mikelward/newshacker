import { useState } from 'react';
import type { Feed } from '../lib/feeds';
import { PAGE_SIZE, useStoryPage } from '../hooks/useStoryList';
import { StoryListItem } from './StoryListItem';
import './StoryList.css';

interface Props {
  feed: Feed;
}

export function StoryList({ feed }: Props) {
  const [page, setPage] = useState(0);
  const { ids, items, slice, totalIds } = useStoryPage(feed, page);

  if (ids.isLoading || (items.isLoading && slice.length > 0)) {
    return (
      <ol className="story-list" aria-busy="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <li key={i} className="story-list__skeleton" aria-hidden="true" />
        ))}
      </ol>
    );
  }

  if (ids.isError || items.isError) {
    return (
      <div className="page-message" role="alert">
        <p>Could not load stories.</p>
        <button
          type="button"
          className="retry-btn"
          onClick={() => {
            ids.refetch();
            items.refetch();
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  const stories = (items.data ?? []).filter(
    (it): it is NonNullable<typeof it> => it != null && !it.deleted && !it.dead,
  );

  if (stories.length === 0) {
    return <div className="page-message">No stories.</div>;
  }

  const canLoadMore = slice.length < totalIds;

  return (
    <>
      <ol className="story-list">
        {stories.map((story, idx) => (
          <li key={story.id} className="story-list__item">
            <StoryListItem story={story} rank={idx + 1} />
          </li>
        ))}
      </ol>
      {canLoadMore ? (
        <div className="story-list__more">
          <button
            type="button"
            className="load-more-btn"
            onClick={() => setPage((p) => p + 1)}
          >
            Load more
          </button>
        </div>
      ) : null}
    </>
  );
}

export { PAGE_SIZE };
