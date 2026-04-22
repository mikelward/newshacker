import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../hooks/useAuth';
import { useItemTree } from '../hooks/useItemTree';
import { useInfiniteScroll } from '../hooks/useInfiniteScroll';
import { useDoneStories } from '../hooks/useDoneStories';
import { useFavorites } from '../hooks/useFavorites';
import { useInternalLinkClick } from '../hooks/useInternalLinkClick';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useOpenedStories } from '../hooks/useOpenedStories';
import { usePinnedStories } from '../hooks/usePinnedStories';
import { useShareStory } from '../hooks/useShareStory';
import { useVote } from '../hooks/useVote';
import { SummaryError, useSummary } from '../hooks/useSummary';
import { useCommentsSummary } from '../hooks/useCommentsSummary';
import { useContentWidth } from '../hooks/useContentWidth';
import { extractDomain, formatStoryMetaTail } from '../lib/format';
import {
  markArticleOpenedId,
  markCommentsOpenedId,
} from '../lib/openedStories';
import { prefetchCommentBatch } from '../lib/commentPrefetch';
import { prefetchPinnedStory } from '../lib/pinnedStoryPrefetch';
import { prefetchFavoriteStory } from '../lib/favoriteStoryPrefetch';
import { getItems } from '../lib/hn';
import { sanitizeCommentHtml } from '../lib/sanitize';
import { estimateWrappedLines } from '../lib/skeletonSize';
import { trackSummaryLayout } from '../lib/analytics';
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

function UpArrowIcon() {
  // Solid upward-pointing triangle — mirrors HN's `▲` vote arrow. We
  // rely on `.thread__action--active` toggling `currentColor` to HN
  // orange for the voted state, rather than a separate filled variant,
  // because HN itself uses a shape+color (not outline↔solid) convention
  // for upvoted.
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
      <path d="M480-720 220-320h520L480-720Z" />
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

function DoneIcon() {
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
      <path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z" />
    </svg>
  );
}

function DoneFilledIcon() {
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
      <path d="M480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm-56-216 280-280-56-56-224 224-114-114-56 56 170 170Z" />
    </svg>
  );
}

function VerticalAlignTopIcon() {
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
      <path d="M240-760v-80h480v80H240Zm200 640v-446L336-462l-56-58 200-200 200 200-56 58-104-104v446h-80Z" />
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

  const layoutFiredRef = useRef(false);
  useEffect(() => {
    if (layoutFiredRef.current) return;
    if (!data || !cardRef.current || width <= 0) return;
    const bodyEl = cardRef.current.querySelector<HTMLElement>(
      '.thread__summary-body',
    );
    if (!bodyEl) return;
    trackSummaryLayout({
      kind: 'article',
      cardWidthPx: width,
      summaryChars: data.summary.length,
      reservedContentHeightPx: skeletonBlockHeightPx(lines),
      renderedContentHeightPx: bodyEl.offsetHeight,
    });
    layoutFiredRef.current = true;
  }, [data, width, lines]);

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

  const layoutFiredRef = useRef(false);
  useEffect(() => {
    if (layoutFiredRef.current) return;
    if (!data || !cardRef.current || width <= 0) return;
    const listEl = cardRef.current.querySelector<HTMLElement>(
      '.thread__summary-list',
    );
    if (!listEl) return;
    const totalChars = data.insights.reduce((sum, s) => sum + s.length, 0);
    trackSummaryLayout({
      kind: 'comments',
      cardWidthPx: width,
      summaryChars: totalChars,
      reservedContentHeightPx: insightsBlockPx,
      renderedContentHeightPx: listEl.offsetHeight,
      insightCount: data.insights.length,
    });
    layoutFiredRef.current = true;
  }, [data, width, insightsBlockPx]);

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

interface ThreadActionBarProps {
  itemId: number;
  articleUrl?: string;
  articleOpened: boolean;
  canVote: boolean;
  voted: boolean;
  pinned: boolean;
  done: boolean;
  menuOpen: boolean;
  onToggleVote: () => void;
  onTogglePinned: () => void;
  onToggleDone: () => void;
  onOpenMenu: () => void;
  // 'top' (default) renders Read article (when the story has a url) as
  // the primary button. 'bottom' renders Back to top instead — the reader
  // is at the end of a long thread, so a quick jump up is more useful
  // than the article link (which is still reachable via the top bar).
  variant?: 'top' | 'bottom';
  testIdSuffix?: '' | '-bottom';
}

function scrollThreadToTop() {
  // Browsers that support prefers-reduced-motion fall back to an instant
  // scroll for this when the user opts out.
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function ThreadActionBar({
  itemId,
  articleUrl,
  articleOpened,
  canVote,
  voted,
  pinned,
  done,
  menuOpen,
  onToggleVote,
  onTogglePinned,
  onToggleDone,
  onOpenMenu,
  variant = 'top',
  testIdSuffix = '',
}: ThreadActionBarProps) {
  return (
    <div className="thread__actions">
      {variant === 'bottom' ? (
        // Intentionally not --primary: the bottom bar's Back to top is a
        // utility, not the main CTA for the page. Keeps the HN orange
        // reserved for Read article at the top, where "go read the
        // article" really is the primary action.
        <button
          type="button"
          className="thread__action"
          data-testid={`thread-back-to-top${testIdSuffix}`}
          onClick={scrollThreadToTop}
        >
          <VerticalAlignTopIcon />
          <span className="thread__action-label">Back to top</span>
        </button>
      ) : articleUrl ? (
        <a
          className={
            'thread__action thread__action--primary' +
            (articleOpened ? ' thread__action--read' : '')
          }
          data-testid={`thread-read-article${testIdSuffix}`}
          href={articleUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => markArticleOpenedId(itemId)}
        >
          <OpenInNewIcon />
          <span className="thread__action-label">Read article</span>
        </a>
      ) : null}
      {canVote ? (
        <TooltipButton
          type="button"
          className={
            'thread__action thread__action--icon' +
            (voted ? ' thread__action--active' : '')
          }
          data-testid={`thread-vote${testIdSuffix}`}
          aria-pressed={voted}
          tooltip={voted ? 'Unvote' : 'Upvote'}
          onClick={onToggleVote}
        >
          <UpArrowIcon />
          <span className="visually-hidden">
            {voted ? 'Unvote' : 'Upvote'}
          </span>
        </TooltipButton>
      ) : null}
      <TooltipButton
        type="button"
        className={
          'thread__action thread__action--icon' +
          (pinned ? ' thread__action--active' : '')
        }
        data-testid={`thread-pin${testIdSuffix}`}
        aria-pressed={pinned}
        tooltip={pinned ? 'Unpin' : 'Pin'}
        onClick={onTogglePinned}
      >
        {pinned ? <PinFilledIcon /> : <PinIcon />}
        <span className="visually-hidden">{pinned ? 'Unpin' : 'Pin'}</span>
      </TooltipButton>
      <TooltipButton
        type="button"
        className={
          'thread__action thread__action--icon' +
          (done ? ' thread__action--active' : '')
        }
        data-testid={`thread-done${testIdSuffix}`}
        aria-pressed={done}
        tooltip={done ? 'Unmark done' : 'Mark done'}
        onClick={onToggleDone}
      >
        {done ? <DoneFilledIcon /> : <DoneIcon />}
        <span className="visually-hidden">
          {done ? 'Unmark done' : 'Mark done'}
        </span>
      </TooltipButton>
      <TooltipButton
        type="button"
        className="thread__action thread__action--icon"
        data-testid={`thread-more${testIdSuffix}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        tooltip="More actions"
        aria-label="More actions"
        onClick={onOpenMenu}
      >
        <MoreVertIcon />
      </TooltipButton>
    </div>
  );
}

export function Thread({ id }: Props) {
  const { data, isLoading, isError, refetch } = useItemTree(id);
  const queryClient = useQueryClient();
  const online = useOnlineStatus();
  const navigate = useNavigate();
  const location = useLocation();
  const [visibleCount, setVisibleCount] = useState(TOP_LEVEL_PAGE_SIZE);
  const { isPinned, pin, unpin } = usePinnedStories();
  const pinned = isPinned(id);
  const { articleOpenedIds } = useOpenedStories();
  const articleOpened = articleOpenedIds.has(id);
  const item = data?.item;
  // Snapshot the thread's comment count whenever it loads (or the
  // background refetch brings in a fresher count). Row clicks in the
  // feed already record an initial snapshot — this keeps it current
  // for deep links and updates it after the user has actually seen
  // every comment on the page.
  const commentCount = item?.descendants;
  useEffect(() => {
    if (commentCount === undefined) return;
    markCommentsOpenedId(id, Date.now(), commentCount);
  }, [id, commentCount]);
  const handleTogglePinned = useCallback(() => {
    if (pinned) {
      unpin(id);
    } else {
      pin(id);
      if (item) prefetchPinnedStory(queryClient, item);
    }
  }, [pinned, id, pin, unpin, item, queryClient]);
  const { isDone, markDone, unmarkDone } = useDoneStories();
  const done = isDone(id);
  const handleToggleDone = useCallback(() => {
    if (done) {
      unmarkDone(id);
      return;
    }
    markDone(id);
    // Mark-done closes the thread: pop back to wherever the reader came
    // from (usually a feed). location.key === 'default' means this is
    // the first in-app history entry (deep link, refresh, shared URL),
    // so there's nothing to pop — land on the home feed instead.
    if (location.key !== 'default') navigate(-1);
    else navigate('/');
  }, [done, id, markDone, unmarkDone, location.key, navigate]);
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
  const { isAuthenticated } = useAuth();
  const { isVoted, toggleVote } = useVote();
  const voted = isVoted(id);
  const handleToggleVote = useCallback(() => {
    toggleVote(id);
  }, [id, toggleVote]);
  const handleLinkClick = useInternalLinkClick();
  const shareStory = useShareStory();
  const [menuOpen, setMenuOpen] = useState(false);
  const openMenu = useCallback(() => setMenuOpen(true), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const menuItems = useMemo<StoryRowMenuItem[]>(() => {
    // Bar carries the high-frequency toggles (Pin/Unpin and Done);
    // Favorite is the "keepsake" action and lives in overflow because
    // it's less frequent on the comments view than the queue/exit pair.
    const items: StoryRowMenuItem[] = [
      {
        key: 'favorite',
        label: favorited ? 'Unfavorite' : 'Favorite',
        onSelect: handleToggleFavorite,
      },
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
  }, [id, item, favorited, handleToggleFavorite, shareStory]);

  const kidIds = data?.kidIds ?? [];
  const shown = kidIds.slice(0, visibleCount);
  const hasMore = visibleCount < kidIds.length;

  const loadingMoreRef = useRef(false);

  const sentinelRef = useInfiniteScroll<HTMLDivElement>({
    enabled: hasMore,
    onLoadMore: async () => {
      // Guard against overlapping triggers — the sentinel keeps firing
      // while it's in view, and async prefetch means a second call can
      // land before state updates hide it.
      if (loadingMoreRef.current) return;
      const prev = visibleCount;
      if (prev >= kidIds.length) return;
      const next = prev + TOP_LEVEL_PAGE_SIZE;
      // Warm the newly-visible slice in one /api/items batch so the
      // ~20 Comment observers that are about to mount hydrate from
      // cache instead of each firing their own Firebase fetch. Filter
      // out ids already in cache (e.g. from the first-page batch or a
      // recent visit) to avoid a redundant round-trip. Awaited, so the
      // Comments don't mount — and start racing with their own
      // per-id fetches — until the batch has landed.
      const uncached = kidIds
        .slice(prev, next)
        .filter((kid) => !queryClient.getQueryData(['comment', kid]));
      loadingMoreRef.current = true;
      try {
        if (uncached.length > 0) {
          await prefetchCommentBatch(queryClient, uncached, getItems);
        }
        setVisibleCount(next);
      } finally {
        loadingMoreRef.current = false;
      }
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
        <ThreadActionBar
          itemId={item.id}
          articleUrl={item.url}
          articleOpened={articleOpened}
          canVote={isAuthenticated}
          voted={voted}
          pinned={pinned}
          done={done}
          menuOpen={menuOpen}
          onToggleVote={handleToggleVote}
          onTogglePinned={handleTogglePinned}
          onToggleDone={handleToggleDone}
          onOpenMenu={openMenu}
        />
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
      <footer className="thread__footer">
        <ThreadActionBar
          itemId={item.id}
          articleUrl={item.url}
          articleOpened={articleOpened}
          canVote={isAuthenticated}
          voted={voted}
          pinned={pinned}
          done={done}
          menuOpen={menuOpen}
          onToggleVote={handleToggleVote}
          onTogglePinned={handleTogglePinned}
          onToggleDone={handleToggleDone}
          onOpenMenu={openMenu}
          variant="bottom"
          testIdSuffix="-bottom"
        />
      </footer>
    </article>
  );
}
