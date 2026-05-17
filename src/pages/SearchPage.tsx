import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { StoryListItem } from '../components/StoryListItem';
import { StoryRowSkeleton } from '../components/Skeletons';
import { EmptyState, ErrorState } from '../components/States';
import { useHiddenStories } from '../hooks/useHiddenStories';
import { useOpenedStories } from '../hooks/useOpenedStories';
import { usePinnedStories } from '../hooks/usePinnedStories';
import { useSearchResults } from '../hooks/useSearchResults';
import { useShareStory } from '../hooks/useShareStory';
import type { SearchSort } from '../lib/algolia';
import { markCommentsOpenedId } from '../lib/openedStories';
import './SearchPage.css';

function parseSort(raw: string | null): SearchSort {
  return raw === 'date' ? 'date' : 'relevance';
}

const DEBOUNCE_MS = 250;

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const urlQuery = params.get('q') ?? '';
  const sort = parseSort(params.get('sort'));

  // Local input state so typing stays smooth — committed to the URL
  // (which drives the actual query) after a short debounce.
  const [input, setInput] = useState(urlQuery);
  const [lastUrlQuery, setLastUrlQuery] = useState(urlQuery);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reflect external URL changes back into the input (e.g. browser
  // back/forward, or a shared link landing on /search?q=…). React
  // synchronously re-renders without an extra commit when state is
  // set during render this way — see "Adjusting state when a prop
  // changes" in the React docs.
  if (urlQuery !== lastUrlQuery) {
    setLastUrlQuery(urlQuery);
    setInput(urlQuery);
  }

  // Debounce the input into the URL so each keystroke doesn't spawn
  // a fresh history entry or fetch. `replace: true` keeps the back
  // button pointing at wherever the reader entered search from.
  useEffect(() => {
    if (input === urlQuery) return;
    const handle = window.setTimeout(() => {
      const next = new URLSearchParams(params);
      const trimmed = input.trim();
      if (trimmed) next.set('q', input);
      else next.delete('q');
      setParams(next, { replace: true });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [input, urlQuery, params, setParams]);

  const setSort = useCallback(
    (nextSort: SearchSort) => {
      const next = new URLSearchParams(params);
      next.set('sort', nextSort);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const onSubmit = useCallback((e: FormEvent<HTMLFormElement>) => {
    // Enter key dismisses the keyboard on mobile and forces an
    // immediate URL flush by triggering the controlled-input change
    // cycle one more time. Don't actually navigate anywhere.
    e.preventDefault();
    inputRef.current?.blur();
  }, []);

  const { hits, isLoading, isError, isFetchingMore, hasMore, loadMore, refetch } =
    useSearchResults(urlQuery, sort);

  const shareStory = useShareStory();
  const { hide, hiddenIds } = useHiddenStories();
  const { articleOpenedIds, commentsOpenedIds, seenCommentCounts, unopen } =
    useOpenedStories();
  const { pinnedIds, pin, unpin } = usePinnedStories();

  // Match feed behavior (StoryList): hidden rows are filtered out of
  // the visible list, not just dimmed. Without this, swipe-to-hide a
  // result appears to do nothing — the row plays its dismiss
  // animation and then snaps back, because we still render it.
  // Recovery happens on /hidden, same as for feed pages.
  const visibleHits = useMemo(
    () => hits.filter((story) => !hiddenIds.has(story.id)),
    [hits, hiddenIds],
  );

  const handleOpenThread = useCallback(
    (id: number) => {
      const story = visibleHits.find((s) => s.id === id);
      markCommentsOpenedId(id, Date.now(), story?.descendants ?? 0);
    },
    [visibleHits],
  );

  const hasQuery = urlQuery.trim().length > 0;

  const body = useMemo(() => {
    if (!hasQuery) {
      return (
        <EmptyState message="Type a query above to search Hacker News stories." />
      );
    }
    if (isLoading && visibleHits.length === 0) {
      return (
        <ol
          className="story-list"
          aria-busy="true"
          aria-label="Searching"
          data-testid="search-loading"
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <li key={i} className="story-list__item">
              <StoryRowSkeleton />
            </li>
          ))}
        </ol>
      );
    }
    if (isError && visibleHits.length === 0) {
      return (
        <ErrorState message="Search is unavailable." onRetry={() => refetch()} />
      );
    }
    if (visibleHits.length === 0) {
      return <EmptyState message={`No results for "${urlQuery}".`} />;
    }
    return (
      <ol className="story-list">
        {visibleHits.map((story, idx) => (
          <li key={story.id} className="story-list__item">
            <StoryListItem
              story={story}
              rank={idx + 1}
              flag={null}
              articleOpened={articleOpenedIds.has(story.id)}
              commentsOpened={commentsOpenedIds.has(story.id)}
              seenCommentCount={seenCommentCounts.get(story.id)}
              pinned={pinnedIds.has(story.id)}
              onHide={hide}
              onPin={pin}
              onUnpin={unpin}
              onShare={shareStory}
              onMarkUnread={unopen}
              onOpenThread={handleOpenThread}
            />
          </li>
        ))}
      </ol>
    );
  }, [
    hasQuery,
    isLoading,
    isError,
    visibleHits,
    urlQuery,
    articleOpenedIds,
    commentsOpenedIds,
    seenCommentCounts,
    pinnedIds,
    hide,
    pin,
    unpin,
    shareStory,
    unopen,
    handleOpenThread,
    refetch,
  ]);

  return (
    <div className="search-page">
      <form
        className="search-page__form"
        role="search"
        onSubmit={onSubmit}
      >
        <label htmlFor="search-input" className="visually-hidden">
          Search Hacker News
        </label>
        <input
          id="search-input"
          ref={inputRef}
          className="search-page__input"
          data-testid="search-input"
          type="search"
          autoFocus
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          placeholder="Search Hacker News stories"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <div
          className="search-page__sort"
          role="group"
          aria-label="Sort results"
        >
          <button
            type="button"
            className={
              'search-page__sort-btn' +
              (sort === 'relevance' ? ' search-page__sort-btn--active' : '')
            }
            data-testid="sort-relevance"
            aria-pressed={sort === 'relevance'}
            onClick={() => setSort('relevance')}
          >
            Relevance
          </button>
          <button
            type="button"
            className={
              'search-page__sort-btn' +
              (sort === 'date' ? ' search-page__sort-btn--active' : '')
            }
            data-testid="sort-date"
            aria-pressed={sort === 'date'}
            onClick={() => setSort('date')}
          >
            Date
          </button>
        </div>
      </form>
      {body}
      {hasMore && hits.length > 0 ? (
        <div className="search-page__more">
          <button
            type="button"
            className="search-page__more-btn"
            data-testid="search-more"
            disabled={isFetchingMore}
            onClick={loadMore}
          >
            {isFetchingMore ? 'Loading…' : 'More'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
