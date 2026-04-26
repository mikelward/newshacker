import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import {
  CommentsSummaryError,
  useCommentsSummary,
} from '../hooks/useCommentsSummary';
import { useContentWidth } from '../hooks/useContentWidth';
import {
  extractDomain,
  formatStoryMetaTail,
  isSafeHttpUrl,
} from '../lib/format';
import {
  markArticleOpenedId,
  markCommentsOpenedId,
} from '../lib/openedStories';
import { prefetchCommentBatch } from '../lib/commentPrefetch';
import { prefetchPinnedStory } from '../lib/pinnedStoryPrefetch';
import { recordFirstAction } from '../lib/telemetry';
import { prefetchFavoriteStory } from '../lib/favoriteStoryPrefetch';
import { getItem, getItems } from '../lib/hn';
import { sanitizeCommentHtml } from '../lib/sanitize';
import { hasSelfPostBody } from '../lib/selfPostBody';
import { trackSummaryLayout } from '../lib/analytics';
import { Comment } from './Comment';
import { MarkdownText } from './MarkdownText';
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
      case 'source_captcha':
        return 'The article site returned a CAPTCHA page instead of the article. Try opening the link directly.';
      case 'summarization_failed':
        return 'Something went wrong summarizing the article. Try again in a moment.';
      case 'not_configured':
        return "Summaries aren't available right now.";
      case 'summary_budget_exhausted':
        return 'Summaries are temporarily unavailable. Please try again later.';
      case 'rate_limited':
        return 'Too many requests — try again later.';
    }
  }
  if (error instanceof Error && error.message) {
    return `${error.message}.`;
  }
  return '';
}

function commentsSummaryErrorDetail(error: unknown): string {
  if (error instanceof CommentsSummaryError && error.reason === 'rate_limited') {
    return 'Too many requests — try again later.';
  }
  if (error instanceof Error && error.message) {
    return `${error.message}.`;
  }
  return '';
}

// Expected content lengths that the loading skeleton reserves for. These
// are content knobs only — the skeleton uses the real `.thread__summary-body`
// and `.thread__summary-list` CSS with placeholder text of this length, so
// the browser does the actual wrap and we don't carry any line-height,
// line-gap, or indent constants that have to be kept in sync with CSS.
// Picking these is a content-distribution problem (how long are summaries
// in practice?) that the /api/telemetry pipeline answers — tune from live
// data, not from device-side guesswork.
const ARTICLE_SUMMARY_EXPECTED_CHARS = 230;
const INSIGHT_EXPECTED_CHARS = 75;
const EXPECTED_INSIGHT_COUNT = 5;

// Loading copy shown inside the summary skeleton. The shimmer styling in
// Thread.css is supposed to clip the glyphs out, but in practice the text
// is readable during the load, so keep it user-facing.
const SKELETON_PROBE_PROSE =
  'Summary is loading. Please wait.';

function probeText(chars: number): string {
  if (chars <= 0) return '';
  let out = '';
  while (out.length < chars) out += SKELETON_PROBE_PROSE + ' ';
  return out.slice(0, chars).trimEnd();
}

// Lazy wrapper around <SummaryCard>. Renders a "Summarize article"
// button up front and only mounts the real summary card (which
// auto-fetches via useSummary) once the reader explicitly asks for
// it. Used on the focused-comment view at /item/<commentId> so a
// reader who landed on a deep comment doesn't trigger an article
// summary auto-run for a story they may have no interest in.
//
// Server-side caching by storyId means a popular story's first lazy
// reveal is essentially free, but the gate keeps the cold-compute
// path off the default code path on the comment view.
function LazyArticleSummaryCard({ storyId }: { storyId: number }) {
  const [revealed, setRevealed] = useState(false);
  if (revealed) {
    return <SummaryCard storyId={storyId} />;
  }
  return (
    <div className="thread__lazy-summary">
      <button
        type="button"
        className="thread__lazy-summary-button"
        onClick={() => setRevealed(true)}
        data-testid="lazy-summarize-button"
      >
        Summarize article
      </button>
    </div>
  );
}

function SummaryCard({ storyId }: { storyId: number }) {
  const { data, isFetching, isError, error, refetch } = useSummary(storyId, true);
  const online = useOnlineStatus();
  const loading = isFetching && !data;
  const offlineWithoutCache = !online && !data && !loading;
  const cardRef = useRef<HTMLDivElement>(null);
  const width = useContentWidth(cardRef);
  const articleProbe = useMemo(
    () => probeText(ARTICLE_SUMMARY_EXPECTED_CHARS),
    [],
  );

  // Capture the skeleton's actually-rendered height while it's in the DOM.
  // The skeleton uses the same CSS as real content (just with invisible
  // shimmer-clipped glyphs), so this is the browser's own wrap calculation
  // — no hand-coded line-height or gap constants.
  const reservedHRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!loading) return;
    const probeEl = cardRef.current?.querySelector<HTMLElement>(
      '.thread__summary-body--loading',
    );
    if (!probeEl) return;
    reservedHRef.current = probeEl.offsetHeight;
  }, [loading, width]);

  const layoutFiredRef = useRef(false);
  useEffect(() => {
    if (layoutFiredRef.current) return;
    if (!data || !cardRef.current || width <= 0) return;
    const reserved = reservedHRef.current;
    if (reserved === null) return;
    const bodyEl = cardRef.current.querySelector<HTMLElement>(
      '.thread__summary-body:not(.thread__summary-body--loading)',
    );
    if (!bodyEl) return;
    trackSummaryLayout({
      kind: 'article',
      cardWidthPx: width,
      // Visible characters as actually rendered. `textContent` strips the
      // <code>/<strong> tags MarkdownText emits, so e.g. "configuring the
      // `base_url` here" reports the rendered length without the two
      // backticks. Falls back to the raw string if textContent is null
      // (it isn't, in practice — element nodes always return a string).
      summaryChars: bodyEl.textContent?.length ?? data.summary.length,
      reservedContentHeightPx: reserved,
      renderedContentHeightPx: bodyEl.offsetHeight,
    });
    layoutFiredRef.current = true;
  }, [data, width]);

  return (
    <div
      ref={cardRef}
      className="thread__summary-card"
      data-testid="thread-summary-card"
      role="region"
      aria-label="AI summary"
      aria-live="polite"
      aria-busy={loading}
    >
      {loading ? (
        <span className="thread__summary-loading">Summarizing…</span>
      ) : null}
      {loading ? (
        <p
          className="thread__summary-body thread__summary-body--loading"
          data-testid="thread-summary-skeleton"
          aria-hidden="true"
        >
          {articleProbe}
        </p>
      ) : null}
      {data ? (
        <p className="thread__summary-body">
          <MarkdownText text={data.summary} />
        </p>
      ) : null}
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
          {data.archiveSource ? (
            <>
              Article summary generated by Gemini from{' '}
              <span className="thread__summary-attribution-host">
                {data.archiveSource.archiveHost}
              </span>{' '}
              copy linked by HN user{' '}
              <span className="thread__summary-attribution-user">
                {data.archiveSource.username}
              </span>
            </>
          ) : (
            'Article summary generated by Gemini'
          )}
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
  const insightProbe = useMemo(
    () => probeText(INSIGHT_EXPECTED_CHARS),
    [],
  );

  const reservedHRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!loading) return;
    const probeEl = cardRef.current?.querySelector<HTMLElement>(
      '.thread__summary-list--loading',
    );
    if (!probeEl) return;
    reservedHRef.current = probeEl.offsetHeight;
  }, [loading, width]);

  const layoutFiredRef = useRef(false);
  useEffect(() => {
    if (layoutFiredRef.current) return;
    if (!data || !cardRef.current || width <= 0) return;
    const reserved = reservedHRef.current;
    if (reserved === null) return;
    const listEl = cardRef.current.querySelector<HTMLElement>(
      '.thread__summary-list:not(.thread__summary-list--loading)',
    );
    if (!listEl) return;
    const totalChars = data.insights.reduce((sum, s) => sum + s.length, 0);
    trackSummaryLayout({
      kind: 'comments',
      cardWidthPx: width,
      // See SummaryCard above — read what the browser actually rendered
      // (post-MarkdownText) so the chars-vs-height correlation isn't
      // biased by stripped backtick / asterisk delimiters.
      summaryChars: listEl.textContent?.length ?? totalChars,
      reservedContentHeightPx: reserved,
      renderedContentHeightPx: listEl.offsetHeight,
      insightCount: data.insights.length,
    });
    layoutFiredRef.current = true;
  }, [data, width]);

  return (
    <div
      ref={cardRef}
      className="thread__summary-card thread__summary-card--comments"
      data-testid="thread-comments-summary-card"
      role="region"
      aria-label="AI summary of comments"
      aria-live="polite"
      aria-busy={loading}
    >
      {loading ? (
        <span className="thread__summary-loading">Summarizing comments…</span>
      ) : null}
      {loading ? (
        <ul
          className="thread__summary-list thread__summary-list--loading"
          data-testid="thread-comments-summary-skeleton"
          aria-hidden="true"
        >
          {Array.from({ length: EXPECTED_INSIGHT_COUNT }, (_, i) => (
            <li key={i}>{insightProbe}</li>
          ))}
        </ul>
      ) : null}
      {data ? (
        <ul className="thread__summary-list">
          {data.insights.map((insight, i) => (
            <li key={i}>
              <MarkdownText text={insight} />
            </li>
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
            {(() => {
              const detail = commentsSummaryErrorDetail(error);
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
  onOpenMenu: (anchor: HTMLElement | null) => void;
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
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="thread__actions">
      {variant === 'bottom' ? (
        // Not --primary (that slot's orange is reserved for "Read
        // article" at the top, where "go read the article" really is
        // the primary action) — but --stretch so the button fills the
        // same primary-slot width as Read article does at the top.
        // That keeps Pin/Done/⋮ in the same on-screen position top
        // and bottom, so the reader's thumb doesn't have to relearn
        // where they are at the end of a long thread. The label
        // ellipsis-truncates via .thread__action-label when space
        // gets tight, so the bar stays on a single row at every
        // phone width (see Thread.toolbarLayout.test.tsx).
        <button
          type="button"
          className="thread__action thread__action--stretch"
          data-testid={`thread-back-to-top${testIdSuffix}`}
          onClick={scrollThreadToTop}
        >
          <VerticalAlignTopIcon />
          <span className="thread__action-label">Back to top</span>
        </button>
      ) : isSafeHttpUrl(articleUrl) ? (
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
        ref={moreBtnRef}
        type="button"
        className="thread__action thread__action--icon"
        data-testid={`thread-more${testIdSuffix}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        tooltip="More actions"
        aria-label="More actions"
        onClick={() => onOpenMenu(moreBtnRef.current)}
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
  const { isAuthenticated } = useAuth();
  const { isPinned, pin, unpin } = usePinnedStories();
  const pinned = isPinned(id);
  const { articleOpenedIds } = useOpenedStories();
  const articleOpened = articleOpenedIds.has(id);
  const item = data?.item;
  // When the loaded item is a comment, the focused-comment view renders
  // it via <Comment defaultExpanded> below. Comment.tsx fetches the
  // body via useCommentItem (queryKey ['comment', id]) — a different
  // cache key from useItemTree's ['itemRoot', id]. Without this prime,
  // <Comment> would fire a redundant single-item Firebase fetch for the
  // exact data we already have in `item`. setQueryData is best-effort
  // hydration, so a future itemRoot refetch still serves the freshest
  // copy via the comment cache via prefetchCommentBatch on the kid
  // batch (loadRoot's prefetch).
  useEffect(() => {
    if (item && item.type === 'comment') {
      queryClient.setQueryData(['comment', item.id], item);
    }
  }, [item, queryClient]);
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
      if (item) {
        prefetchPinnedStory(queryClient, item);
        // The user is *on* the thread page when they tap Pin, so
        // they're well into "I read this" territory — almost
        // always true. We still consult `articleOpenedIds` to
        // honor the actual record.
        recordFirstAction('pin', item, 'thread', {
          isAuthenticated,
          articleOpened: articleOpenedIds.has(id),
        });
      }
    }
  }, [
    pinned,
    id,
    pin,
    unpin,
    item,
    queryClient,
    isAuthenticated,
    articleOpenedIds,
  ]);
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
  const { isVoted, toggleVote } = useVote();
  const voted = isVoted(id);
  const handleToggleVote = useCallback(() => {
    toggleVote(id);
  }, [id, toggleVote]);
  const handleLinkClick = useInternalLinkClick();
  const shareStory = useShareStory();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const openMenu = useCallback((anchor: HTMLElement | null) => {
    // Toggle when clicking the same anchor twice — standard
    // popover-dismiss behavior on desktop; on touch the bottom sheet
    // closes via its backdrop or Cancel button anyway.
    setMenuOpen((prev) => {
      if (prev && menuAnchor === anchor) {
        setMenuAnchor(null);
        return false;
      }
      setMenuAnchor(anchor);
      return true;
    });
  }, [menuAnchor]);
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setMenuAnchor(null);
  }, []);
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

  // When /item/:id resolves to a comment (HN's API treats every node
  // uniformly, so it can — links from /threads, /user, and /from
  // routinely land on comment ids), walk up the `parent` chain to find
  // the root story so the comment-thread view can surface the story
  // title as the heading link above the comment. If the walk can't
  // reach a story, the UI falls back to a "View parent →" link to the
  // immediate parent so the reader is never stranded. Disabled for
  // stories; returns null if the walk hits a missing item or the depth
  // cap.
  const { data: rootStory } = useQuery({
    queryKey: ['comment-root', id],
    queryFn: async ({ signal }) => {
      let cursor: number | undefined = item?.parent;
      for (let i = 0; i < 10 && cursor !== undefined; i++) {
        const next = await getItem(cursor, signal);
        if (!next) return null;
        if (next.type === 'story') return next;
        cursor = next.parent;
      }
      return null;
    },
    enabled: item?.type === 'comment' && item?.parent !== undefined,
  });

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

  if (item.type === 'comment') {
    // Focused single-comment view — effectively a filtered comments
    // page rooted at this comment. Mirrors HN's /item?id=<commentId>:
    // header carries the article context (eyebrow, story-title link,
    // opt-in Summarize), and the comment subtree below renders via
    // the same <Comment> the story view uses. We pass defaultExpanded
    // so the focused comment opens unclamped with its toolbar visible
    // (the reader specifically came to see this comment); its kids
    // render in their normal collapsed-with-3-line-preview state, just
    // as they would when an expanded comment is encountered in a
    // story thread. The comment cache was pre-warmed above so
    // <Comment>'s useCommentItem doesn't fire a redundant fetch.
    //
    // TODO (parent-comment escape): a reader landing on a deeply-
    // nested reply has no inline path back to the comment it
    // replies to — only the root story link. Adding a "Reply to:
    // <parent author>" link or breadcrumb that walks one level up
    // would be useful, but is its own decision (extra single-item
    // fetch per comment view, extra space in the header, format).
    // Left out of this change to keep the scope focused.
    //
    // TODO (CommentsSummaryCard): decide whether the comments summary
    // belongs here too. It summarizes "what the wider thread is
    // saying", a different question from the focused comment.
    return (
      <article className="thread thread--comment">
        <header className="thread__header">
          {/* Eyebrow flips to "Comment on" once the parent walk has
              resolved a root story, so the eyebrow + title heading
              read together as "Comment on <story title>". Until then
              (walk still in flight, or walk failed to find a story)
              we render plain "Comment" so the header doesn't dangle a
              preposition with no object underneath. */}
          <p className="thread__comment-eyebrow">
            {rootStory ? 'Comment on' : 'Comment'}
          </p>
          {rootStory ? (
            <h1 className="thread__comment-story-title">
              <Link to={`/item/${rootStory.id}`}>
                {rootStory.title ?? '[untitled]'}
              </Link>
            </h1>
          ) : null}
          {rootStory && (rootStory.url || hasSelfPostBody(rootStory.text)) ? (
            // key by storyId so navigating from one /item/<commentId>
            // to another (different root story) remounts the wrapper
            // and resets `revealed` to false. Without the key, a reader
            // who tapped Summarize on the first comment would land on
            // the second comment's article summary auto-fetched on
            // arrival, defeating the lazy gate's whole point.
            <LazyArticleSummaryCard
              key={rootStory.id}
              storyId={rootStory.id}
            />
          ) : null}
        </header>
        <ol className="thread__comments">
          <li>
            <Comment id={id} defaultExpanded />
          </li>
        </ol>
      </article>
    );
  }

  const domain = extractDomain(item.url);
  const hasExternalUrl = !!item.url;

  return (
    <article className="thread">
      <header className="thread__header">
        <h1 className="thread__title">
          {isSafeHttpUrl(item.url) ? (
            <a
              className="thread__title-link"
              data-testid="thread-title-link"
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => markArticleOpenedId(item.id)}
            >
              {item.title ?? '[untitled]'}
            </a>
          ) : (
            item.title ?? '[untitled]'
          )}
        </h1>
        {item.url || hasSelfPostBody(item.text) ? (
          <SummaryCard storyId={id} />
        ) : null}
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
          anchorEl={menuAnchor}
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
