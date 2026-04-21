import { useCallback, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useItemTree } from '../hooks/useItemTree';
import { useInfiniteScroll } from '../hooks/useInfiniteScroll';
import { useFavorites } from '../hooks/useFavorites';
import { useInternalLinkClick } from '../hooks/useInternalLinkClick';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { usePinnedStories } from '../hooks/usePinnedStories';
import { useShareStory } from '../hooks/useShareStory';
import { SummaryError, useSummary } from '../hooks/useSummary';
import { useCommentsSummary } from '../hooks/useCommentsSummary';
import { useContentWidth } from '../hooks/useContentWidth';
import { extractDomain, formatStoryMetaTail } from '../lib/format';
import { markArticleOpenedId } from '../lib/openedStories';
import { prefetchCommentBatch } from '../lib/commentPrefetch';
import { prefetchPinnedStory } from '../lib/pinnedStoryPrefetch';
import { prefetchFavoriteStory } from '../lib/favoriteStoryPrefetch';
import { getItems } from '../lib/hn';
import { sanitizeCommentHtml } from '../lib/sanitize';
import { estimateWrappedLines } from '../lib/skeletonSize';
import { Comment } from './Comment';
import { ThreadSkeleton } from './Skeletons';
import { ErrorState, EmptyState } from './States';
import { StoryRowMenu, type StoryRowMenuItem } from './StoryRowMenu';
import { TooltipButton } from './TooltipButton';
import './Thread.css';

interface Props {
  id: number;
}

export const TOP_LEVEL_PAGE_SIZE = 20;

// Material Symbols Outlined — Apache 2.0, Google. viewBox 0 -960 960 960,
// fill-based paths that take `color` via currentColor.
const MS_VIEWBOX = '0 -960 960 960';

function OpenInNewIcon() {
  return (
    <svg
      className="thread__action-icon"
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="28"
      height="28"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h280v80H200v560h560v-280h80v280q0 33-23.5 56.5T760-120H200Zm188-212-56-56 372-372H560v-80h280v280h-80v-144L388-332Z" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg
      className="thread__action-icon"
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="28"
      height="28"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m634-448 86 77v60H510v241l-30 30-30-30v-241H240v-60l80-77v-332h-50v-60h414v60h-50v332Zm-313 77h312l-59-55v-354H380v354l-59 55Zm156 0Z" />
    </svg>
  );
}

function PinFilledIcon() {
  return (
    <svg
      className="thread__action-icon"
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="28"
      height="28"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m634-448 86 77v60H510v241l-30 30-30-30v-241H240v-60l80-77v-333h-50v-60h414v60h-50v333Z" />
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg
      className="thread__action-icon"
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="28"
      height="28"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m480-121-41-37q-105.77-97.12-174.88-167.56Q195-396 154-451.5T96.5-552Q80-597 80-643q0-90.15 60.5-150.58Q201-854 290-854q57 0 105.5 27t84.5 78q42-54 89-79.5T670-854q89 0 149.5 60.42Q880-733.15 880-643q0 46-16.5 91T806-451.5Q765-396 695.88-325.56 626.77-255.12 521-158l-41 37Zm0-79q101.24-93 166.62-159.5Q712-426 750.5-476t54-89.14q15.5-39.13 15.5-77.72 0-66.14-42-108.64T670.22-794q-51.52 0-95.37 31.5T504-674h-49q-26-56-69.85-88-43.85-32-95.37-32Q224-794 182-751.5t-42 108.82q0 38.68 15.5 78.18 15.5 39.5 54 90T314-358q66 66 166 158Zm0-297Z" />
    </svg>
  );
}

function MoreVertIcon() {
  return (
    <svg
      className="thread__action-icon"
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="28"
      height="28"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M480-160q-33 0-56.5-23.5T400-240q0-33 23.5-56.5T480-320q33 0 56.5 23.5T560-240q0 33-23.5 56.5T480-160Zm0-240q-33 0-56.5-23.5T400-480q0-33 23.5-56.5T480-560q33 0 56.5 23.5T560-480q0 33-23.5 56.5T480-400Zm0-240q-33 0-56.5-23.5T400-720q0-33 23.5-56.5T480-800q33 0 56.5 23.5T560-720q0 33-23.5 56.5T480-640Z" />
    </svg>
  );
}

function HeartFilledIcon() {
  return (
    <svg
      className="thread__action-icon"
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width="28"
      height="28"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m480-121-41-37q-106-97-175-167.5t-110-126Q113-507 96.5-552T80-643q0-90 60.5-150.5T290-854q57 0 105.5 27t84.5 78q42-54 89-79.5T670-854q89 0 149.5 60.5T880-643q0 46-16.5 91T806-451.5q-41 55.5-110 126T521-158l-41 37Z" />
    </svg>
  );
}

function summaryErrorDetail(error: unknown): string {
  if (error instanceof SummaryError) {
    switch (error.reason) {
      case 'source_timeout':
        return "The article site didn't respond in time — it may be overloaded. Try opening the link directly.";
      case 'source_unreachable':
        return "We couldn't reach the article site. It may be down or blocking automated readers. Try opening the link directly.";
      case 'summarization_failed':
        return 'Something went wrong summarizing the article. Try again in a moment.';
      case 'not_configured':
        return "Summaries aren't available right now.";
    }
  }
  if (error instanceof Error && error.message) {
    return `${error.message}.`;
  }
  return '';
}

// Canvas font shorthand for the summary body text — kept in sync with
// .thread__summary-body / .thread__summary-list in Thread.css. Used only to
// estimate wrapped-line counts for the loading skeletons; a small drift
// from the real computed font is fine because the goal is a ballpark
// reservation, not pixel-perfect matching. overflow-anchor: none on the
// card absorbs the residual shift when real content replaces the skeleton.
const SUMMARY_FONT =
  "400 15px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

// Typical article summary is "a single, concise sentence" per the Gemini
// prompt. Measured on device (Pixel 10, Lenovo tablet): summaries cluster
// around 100–210 chars with occasional excursions to ~240. Reserving for
// 230 chars covers the long-tail case on narrow mobile widths without
// growing on arrival; on tablets it still resolves to 3 lines for typical
// output.
const ARTICLE_SUMMARY_EXPECTED_CHARS = 230;

// The prompt caps each insight at 13 words. Measured Flash-Lite output
// under that cap maxed at 71 chars in a 10-story benchmark; 75 gives a
// small cushion for between-run variance while still rounding down to
// one line per insight on tablet (≥640px card width) — the 85-char
// bound it replaces was right at the round-up edge on some browsers,
// leaving ~3 rows of empty space at the bottom of the card. Phone
// (≤~400px card width) still resolves to two lines, unchanged.
const INSIGHT_EXPECTED_CHARS = 75;

// The prompt asks for up to 5 insights (fewer if the discussion is
// thin). Reserve for the max so rich threads render with zero
// whitespace; on thin threads the card keeps its loading-state height
// and leaves blank space at the bottom instead of reflowing.
const EXPECTED_INSIGHT_COUNT = 5;

// The insight <ul> has padding-left for bullet indentation — subtract so
// the skeleton lines align with where the real insight text will render.
const INSIGHT_LIST_INDENT_PX = 20;

// Pixel dimensions of the skeleton state, used to compute a min-height for
// the card so a shorter real summary never causes the card to shrink on
// load. Kept in TS (not CSS) because the line count is runtime-computed.
const SKELETON_LINE_HEIGHT_PX = 14;
const SKELETON_LINE_GAP_PX = 8;
const SKELETON_PADDING_Y_PX = 6; // 3px top + 3px bottom on .thread__summary-skeleton
const SUMMARY_LABEL_HEIGHT_PX = 24; // "Summarizing…" font-size 13 + 8px margin-bottom, rounded up
const INSIGHT_BLOCK_GAP_PX = 12;
const INSIGHT_LINE_GAP_PX = 6;

function skeletonBlockHeightPx(lines: number): number {
  if (lines <= 0) return 0;
  return (
    lines * SKELETON_LINE_HEIGHT_PX +
    Math.max(0, lines - 1) * SKELETON_LINE_GAP_PX
  );
}

function SummaryCard({ storyId }: { storyId: number }) {
  const { data, isFetching, isError, error, refetch } = useSummary(storyId, true);
  const online = useOnlineStatus();
  const loading = isFetching && !data;
  const offlineWithoutCache = !online && !data && !loading;
  const cardRef = useRef<HTMLDivElement>(null);
  const width = useContentWidth(cardRef);
  const lines = estimateWrappedLines(
    ARTICLE_SUMMARY_EXPECTED_CHARS,
    width,
    SUMMARY_FONT,
  );
  // Pin the card to at least its loading-state height so a shorter real
  // summary doesn't shrink it on arrival. Only applied once the width has
  // been measured — otherwise the initial 0-width render reserves 1 line
  // of space and locks the card too small.
  const cardMinHeight =
    width > 0
      ? SUMMARY_LABEL_HEIGHT_PX +
        SKELETON_PADDING_Y_PX +
        skeletonBlockHeightPx(lines)
      : undefined;

  return (
    <div
      ref={cardRef}
      className="thread__summary-card"
      data-testid="thread-summary-card"
      role="region"
      aria-label="AI summary"
      aria-live="polite"
      aria-busy={loading}
      style={cardMinHeight !== undefined ? { minHeight: cardMinHeight } : undefined}
    >
      {loading ? (
        <span className="thread__summary-loading">Summarizing…</span>
      ) : null}
      {loading ? (
        <div
          className="thread__summary-skeleton"
          data-testid="thread-summary-skeleton"
          aria-hidden="true"
        >
          {Array.from({ length: lines }, (_, i) => (
            <span
              key={i}
              className={
                'thread__summary-skeleton-line' +
                (i === lines - 1
                  ? ' thread__summary-skeleton-line--short'
                  : '')
              }
            />
          ))}
        </div>
      ) : null}
      {data ? <p className="thread__summary-body">{data.summary}</p> : null}
      {offlineWithoutCache ? (
        <div className="thread__summary-error" data-testid="summary-offline">
          <p>Summary not available offline. Pin this story while online to keep a copy.</p>
        </div>
      ) : null}
      {isError && !isFetching && !offlineWithoutCache ? (
        <div className="thread__summary-error">
          <p>
            Could not summarize.
            {(() => {
              const detail = summaryErrorDetail(error);
              return detail ? ` ${detail}` : '';
            })()}
          </p>
          <button
            type="button"
            className="thread__summary-retry"
            onClick={() => refetch()}
          >
            Retry
          </button>
        </div>
      ) : null}
      {data ? (
        <div className="thread__summary-footer">
          Article summary generated by Gemini
        </div>
      ) : null}
    </div>
  );
}

function CommentsSummaryCard({ storyId }: { storyId: number }) {
  const { data, isFetching, isError, error, refetch } = useCommentsSummary(
    storyId,
    true,
  );
  const online = useOnlineStatus();
  const loading = isFetching && !data;
  const offlineWithoutCache = !online && !data && !loading;
  const cardRef = useRef<HTMLDivElement>(null);
  const width = useContentWidth(cardRef);
  const insightTextWidth = Math.max(0, width - INSIGHT_LIST_INDENT_PX);
  const linesPerInsight = estimateWrappedLines(
    INSIGHT_EXPECTED_CHARS,
    insightTextWidth,
    SUMMARY_FONT,
  );
  // Lock the card to its loading-state height so a comments summary with
  // only 3 insights (vs. the 4 we reserve) doesn't shrink on arrival.
  const perInsightPx =
    linesPerInsight * SKELETON_LINE_HEIGHT_PX +
    Math.max(0, linesPerInsight - 1) * INSIGHT_LINE_GAP_PX;
  const insightsBlockPx =
    EXPECTED_INSIGHT_COUNT * perInsightPx +
    Math.max(0, EXPECTED_INSIGHT_COUNT - 1) * INSIGHT_BLOCK_GAP_PX;
  const cardMinHeight =
    width > 0
      ? SUMMARY_LABEL_HEIGHT_PX + SKELETON_PADDING_Y_PX + insightsBlockPx
      : undefined;

  return (
    <div
      ref={cardRef}
      className="thread__summary-card thread__summary-card--comments"
      data-testid="thread-comments-summary-card"
      role="region"
      aria-label="AI summary of comments"
      aria-live="polite"
      aria-busy={loading}
      style={cardMinHeight !== undefined ? { minHeight: cardMinHeight } : undefined}
    >
      {loading ? (
        <span className="thread__summary-loading">Summarizing comments…</span>
      ) : null}
      {loading ? (
        <div
          className="thread__summary-skeleton thread__summary-skeleton--insights"
          data-testid="thread-comments-summary-skeleton"
          aria-hidden="true"
        >
          {Array.from({ length: EXPECTED_INSIGHT_COUNT }, (_, i) => (
            <div key={i} className="thread__summary-skeleton-insight">
              {Array.from({ length: linesPerInsight }, (_, j) => (
                <span
                  key={j}
                  className={
                    'thread__summary-skeleton-line' +
                    (j === linesPerInsight - 1
                      ? ' thread__summary-skeleton-line--short'
                      : '')
                  }
                />
              ))}
            </div>
          ))}
        </div>
      ) : null}
      {data ? (
        <ul className="thread__summary-list">
          {data.insights.map((insight, i) => (
            <li key={i}>{insight}</li>
          ))}
        </ul>
      ) : null}
      {offlineWithoutCache ? (
        <div
          className="thread__summary-error"
          data-testid="comments-summary-offline"
        >
          <p>
            Comment summary not available offline. Pin this story while online
            to keep a copy.
          </p>
        </div>
      ) : null}
      {isError && !isFetching && !offlineWithoutCache ? (
        <div className="thread__summary-error">
          <p>
            Could not summarize comments.
            {error instanceof Error && error.message
              ? ` ${error.message}.`
              : ''}
          </p>
          <button
            type="button"
            className="thread__summary-retry"
            onClick={() => refetch()}
          >
            Retry
          </button>
        </div>
      ) : null}
      {data ? (
        <div className="thread__summary-footer">
          Comment summary generated by Gemini
        </div>
      ) : null}
    </div>
  );
}

export function Thread({ id }: Props) {
  const { data, isLoading, isError, refetch } = useItemTree(id);
  const queryClient = useQueryClient();
  const online = useOnlineStatus();
  const [visibleCount, setVisibleCount] = useState(TOP_LEVEL_PAGE_SIZE);
  const { isPinned, pin, unpin } = usePinnedStories();
  const pinned = isPinned(id);
  const item = data?.item;
  const handleTogglePinned = useCallback(() => {
    if (pinned) {
      unpin(id);
    } else {
      pin(id);
      if (item) prefetchPinnedStory(queryClient, item);
    }
  }, [pinned, id, pin, unpin, item, queryClient]);
  const { isFavorite, favorite, unfavorite } = useFavorites();
  const favorited = isFavorite(id);
  const handleToggleFavorite = useCallback(() => {
    if (favorited) {
      unfavorite(id);
    } else {
      favorite(id);
      if (item) prefetchFavoriteStory(queryClient, item);
    }
  }, [favorited, id, favorite, unfavorite, item, queryClient]);
  const handleLinkClick = useInternalLinkClick();
  const shareStory = useShareStory();
  const [menuOpen, setMenuOpen] = useState(false);
  const openMenu = useCallback(() => setMenuOpen(true), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const menuItems = useMemo<StoryRowMenuItem[]>(() => {
    const items: StoryRowMenuItem[] = [
      {
        key: 'open-on-hn',
        label: 'Open on Hacker News',
        onSelect: () => {
          window.open(
            `https://news.ycombinator.com/item?id=${id}`,
            '_blank',
            'noopener,noreferrer',
          );
        },
      },
    ];
    if (item?.url) {
      items.push({
        key: 'share-article',
        label: 'Share article',
        onSelect: () => {
          void shareStory(item);
        },
      });
    }
    return items;
  }, [id, item, shareStory]);

  const kidIds = data?.kidIds ?? [];
  const shown = kidIds.slice(0, visibleCount);
  const hasMore = visibleCount < kidIds.length;

  const sentinelRef = useInfiniteScroll<HTMLDivElement>({
    enabled: hasMore,
    onLoadMore: () => {
      setVisibleCount((prev) => {
        const next = prev + TOP_LEVEL_PAGE_SIZE;
        // Warm the newly-visible slice in one /api/items batch so the
        // ~20 Comment observers that are about to mount hydrate from
        // cache instead of each firing their own Firebase fetch.
        // Filter out ids already in cache (e.g. from the first-page
        // batch or a recent visit) to avoid a redundant round-trip.
        const uncached = kidIds
          .slice(prev, next)
          .filter((kid) => !queryClient.getQueryData(['comment', kid]));
        if (uncached.length > 0) {
          prefetchCommentBatch(queryClient, uncached, getItems);
        }
        return next;
      });
    },
  });

  if (isLoading) {
    return (
      <div className="thread" aria-busy="true" aria-label="Loading thread">
        <ThreadSkeleton />
      </div>
    );
  }
  if (isError) {
    const message = online
      ? 'Could not load thread.'
      : 'This story is not available offline. Pin it while online to keep a copy.';
    return <ErrorState message={message} onRetry={online ? () => refetch() : undefined} />;
  }
  if (!data || !item) {
    return <EmptyState message="Item not found." />;
  }

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
  const hasExternalUrl = !!item.url;

  return (
    <article className="thread">
      <header className="thread__header">
        <h1 className="thread__title">{item.title ?? '[untitled]'}</h1>
        {item.url ? <SummaryCard storyId={id} /> : null}
        <div className="thread__actions">
          {item.url ? (
            <a
              className="thread__action thread__action--primary"
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => markArticleOpenedId(item.id)}
            >
              <OpenInNewIcon />
              <span className="thread__action-label">Read article</span>
            </a>
          ) : null}
          <TooltipButton
            type="button"
            className={
              'thread__action thread__action--icon' +
              (pinned ? ' thread__action--active' : '')
            }
            data-testid="thread-pin"
            aria-pressed={pinned}
            tooltip={pinned ? 'Unpin' : 'Pin'}
            onClick={handleTogglePinned}
          >
            {pinned ? <PinFilledIcon /> : <PinIcon />}
            <span className="visually-hidden">
              {pinned ? 'Unpin' : 'Pin'}
            </span>
          </TooltipButton>
          <TooltipButton
            type="button"
            className={
              'thread__action thread__action--icon' +
              (favorited ? ' thread__action--active' : '')
            }
            data-testid="thread-favorite"
            aria-pressed={favorited}
            tooltip={favorited ? 'Unfavorite' : 'Favorite'}
            onClick={handleToggleFavorite}
          >
            {favorited ? <HeartFilledIcon /> : <HeartIcon />}
            <span className="visually-hidden">
              {favorited ? 'Unfavorite' : 'Favorite'}
            </span>
          </TooltipButton>
          <TooltipButton
            type="button"
            className="thread__action thread__action--icon"
            data-testid="thread-more"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            tooltip="More actions"
            aria-label="More actions"
            onClick={openMenu}
          >
            <MoreVertIcon />
          </TooltipButton>
        </div>
        <StoryRowMenu
          open={menuOpen}
          title={item.title ?? '[untitled]'}
          items={menuItems}
          onClose={closeMenu}
        />
        <div className="thread__meta" data-testid="thread-meta">
          {hasExternalUrl ? (
            domain ? (
              <>
                <a
                  href={`https://${domain}/`}
                  className="thread__domain"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {domain}
                </a>
                {' · '}
              </>
            ) : null
          ) : item.by ? (
            <>
              <Link to={`/user/${item.by}`} className="thread__author">
                {item.by}
              </Link>
              {' · '}
            </>
          ) : null}
          {formatStoryMetaTail(item)}
        </div>
        {item.text ? (
          <div
            className="thread__text"
            onClick={handleLinkClick}
            dangerouslySetInnerHTML={{ __html: sanitizeCommentHtml(item.text) }}
          />
        ) : null}
      </header>
      {kidIds.length > 0 ? <CommentsSummaryCard storyId={id} /> : null}
      <ol className="thread__comments">
        {shown.map((kidId) => (
          <li key={kidId}>
            <Comment id={kidId} />
          </li>
        ))}
      </ol>
      {hasMore ? (
        <div
          ref={sentinelRef}
          className="thread__sentinel"
          data-testid="comments-sentinel"
          aria-hidden="true"
        />
      ) : null}
    </article>
  );
}
