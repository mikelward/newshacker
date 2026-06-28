import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnimationEvent as ReactAnimationEvent,
  ReactNode,
} from 'react';
import { useIsRestoring, useQueryClient } from '@tanstack/react-query';
import type { Feed } from '../lib/feeds';
import { PAGE_SIZE, useFeedItems } from '../hooks/useStoryList';
import { useHotFeedItems } from '../hooks/useHotFeedItems';
import { useDoneStories } from '../hooks/useDoneStories';
import { useHiddenStories } from '../hooks/useHiddenStories';
import { useHotThresholds } from '../hooks/useHotThresholds';
import { usePinnedFeedStories } from '../hooks/usePinnedFeedStories';
import { useOpenedStories } from '../hooks/useOpenedStories';
import { usePinnedStories } from '../hooks/usePinnedStories';
import { isHotStory } from '../lib/format';
import type { HNItem } from '../lib/hn';
import type { HotThresholds } from '../lib/hotThresholds';
import { BackToTopButton } from './BackToTopButton';
import { ListToolbar } from './ListToolbar';
import { PullToRefresh } from './PullToRefresh';
import { StoryListItem, type RowFlag } from './StoryListItem';
import { StoryRowSkeleton } from './Skeletons';
import { ErrorState, EmptyState } from './States';
import { TooltipButton } from './TooltipButton';
import { useListKeyboardNav } from '../hooks/useListKeyboardNav';
import { useShareStory } from '../hooks/useShareStory';
import { markCommentsOpenedId } from '../lib/openedStories';
import { prefetchPinnedStory } from '../lib/pinnedStoryPrefetch';
import { refreshPinnedStoriesForHomeView } from '../lib/homePinnedRefresh';
import { useStickyInset } from '../hooks/useStickyInset';
import { measureStickyInset } from '../lib/stickyInset';
import { useStickyFooterInset } from '../hooks/useStickyFooterInset';
import {
  FEED_PREFETCH_SCORE_THRESHOLD,
  prefetchFeedStory,
} from '../lib/feedStoryPrefetch';
import { warmFeedSummaries } from '../lib/feedSummaryWarm';
import { recordFirstAction } from '../lib/telemetry';
import { useAuth } from '../hooks/useAuth';
import { pullNow as cloudSyncPullNow } from '../lib/cloudSync';
import { checkForServiceWorkerUpdate } from '../lib/swUpdate';
import { useFeedBar } from '../hooks/useFeedBar';
import { useHideOnScroll, useStickyBottomBar } from '../hooks/useFeedSettings';
import './StoryList.css';

// Keep in sync with the `story-list__item--sweeping` animation duration
// in StoryList.css, which in turn matches `EXIT_DURATION_MS` in
// `useSwipeToDismiss` — tapping the broom should feel like every
// unpinned row swiped itself away at the same time. The timer fires
// the actual hide + undo-batch record once the animation has played,
// so the row slides in place instead of popping.
const SWEEP_ANIMATION_MS = 200;

// A fully-visible row can report an intersectionRatio fractionally below 1 on
// sub-pixel layouts, so anything at or above this counts as fully in view. The
// same value is also an observer threshold (not just `[0, 1]`): the callback
// only fires when the ratio crosses a configured threshold, so without the
// cutoff a row that left full visibility at ~0.9995 would get no follow-up
// callback until it exited the viewport entirely — staying wrongly sweepable
// behind the sticky header the whole way up.
const FULLY_VISIBLE_RATIO = 0.999;

// Auto-dismiss-on-scroll hides within this window of each other share one undo
// batch, so a single Undo restores the whole burst the reader just scrolled
// past. Long enough to cover a fast scroll burst, short enough that Undo only
// reaches what was just on screen.
const DISMISS_BATCH_WINDOW_MS = 2000;

// Module-level monotonic source of auto-dismiss burst keys. The undo batch key
// (`lastHiddenKeyRef`) lives in the global FeedBarProvider, so a per-mount
// counter that always starts at 0 would let two StoryListImpl mounts collide:
// feed B's first burst would reuse feed A's stale key and append to its undo
// batch. A global sequence makes every burst's key unique across all lists.
let scrollBurstSeq = 0;

// Reused for "no in-body-pinned ids right now" so the `useMemo` below
// returns the same Set instance across renders — callers (isRowVisible,
// pinnedTopStories) can rely on reference equality to skip re-derivation.
const EMPTY_ID_SET: ReadonlySet<number> = new Set();

interface Props {
  feed: Feed;
  // When true, the toolbar above the list renders the one-row
  // "Try the Hot view" promo link + dismiss button on the left. Only
  // the home route at `/` sets this (and only when the home feed is
  // `top`, not `/hot` itself).
  homePromo?: boolean;
}

// /hot rows that came from the `/new` source (and were not also in
// the `/top` source) render a `new` segment in place of the
// otherwise-suppressed `hot` flag — see SPEC.md *Hot flag*. The
// underlying `RowFlag` enum is declared on `StoryListItem` (where
// it's consumed); we just thread a `flagFor` callback through the
// list so each row can opt into an override.
type FlagFor = (id: number) => RowFlag | undefined;

interface ImplProps {
  feedItems: ReturnType<typeof useFeedItems>;
  flagFor?: FlagFor;
  emptyMessage?: string;
  // Free-form short label (`'top'`, `'hot'`, `'new'`, …) tagged
  // onto every threshold-tuning telemetry event fired from this
  // list — so the /admin scatter can slice "rejected from /hot
  // at score X" vs "rejected from /top at score X". See
  // `src/lib/telemetry.ts`.
  sourceFeed: string;
  // Whether to prepend the reader's off-feed pinned stories (the
  // pinned reading list overlay that SPEC.md *Off-feed pinned
  // stories pinned to the top* describes). Default `true` —
  // every shipping feed view (Top, New, Best, Ask, Show, Jobs,
  // Hot) wants the overlay so a pinned story that has dropped
  // off the source feed is still reachable from the home view.
  // The /tuning Preview passes `false`: there the page is
  // explicitly asking "what would /hot render under this rule?"
  // and the pin overlay would conflate the rule's output with
  // the reader's curated list, defeating the tuning question.
  includeOffFeedPinned?: boolean;
  // Per-row override for the right-side icon button. When the
  // callback returns a value for a given id, it replaces the
  // default Pin/Unpin button on that row. Used by the /tuning
  // Preview: rule-passing rows get the default Pin/Unpin, while
  // pinned-but-not-rule-matching rows get an exclamation icon
  // ("you cared about this but the rule wouldn't surface it").
  // Returning `undefined` falls through to the default behavior.
  rightActionFor?: (id: number) => StoryListItemRightAction | undefined;
  // When true, every row's meta line picks up a points-per-hour
  // velocity segment between points and comments. Off by default;
  // only the /tuning Preview turns it on.
  showVelocity?: boolean;
  // When true, rows the reader has marked done are still rendered
  // (instead of being filtered out alongside hidden / dead / score
  // ≤ 1). Off by default. The /tuning Preview turns it on so the
  // operator sees the rule's full output, not just the slice they
  // haven't read yet — otherwise an operator who's been actively
  // working their reading list sees a near-empty Preview even
  // when the rule is matching plenty of trending stories.
  includeDone?: boolean;
  // When true, rows the reader has hidden are still rendered
  // (instead of being filtered out alongside dead / score ≤ 1).
  // Off by default — shipping feeds always honor Hide. The
  // /tuning Preview turns it on so a rule that surfaces a story
  // the operator already said no to becomes visible as a
  // tightening cue (paired with the per-row yellow question-mark
  // right action; see ThresholdTuningPage). Without this, false-positive
  // rule matches against the hidden set are silently invisible
  // and the operator has no signal that the rule is too loose.
  includeHidden?: boolean;
  // When true, the list renders without any row-level mutation
  // affordances: Pin/Unpin, Hide, Share, swipe gestures, the
  // long-press row menu, and the bulk Sweep button are all
  // suppressed. The right-side icon (driven by `rightActionFor`)
  // still renders but is informational only — the consumer's
  // `onToggle` is responsible for being a no-op. Used by the
  // /tuning Preview where the operator should never mutate
  // reader state from inside a tuning experiment.
  readOnly?: boolean;
  // The user's Hot customize panel overrides, threaded in by the parent
  // so this component doesn't open its own `useHotThresholds`
  // subscription. On `/hot` and the `/tuning` Preview, `flagFor`
  // already returns a concrete value for every row (so the auto-
  // computed pill never fires) and these thresholds are unused; on
  // shipping feeds (`/top`, `/new`, etc.) the `<StoryList>` wrapper
  // calls `useHotThresholds` once and passes the value down so all
  // rows in this list paint against the same captured snapshot.
  // Required to make the hook-call site explicit at every parent
  // (Copilot review on PR #240) — never silently default to the
  // production constants here, since a forgotten prop would mean
  // every shipping feed quietly stops honoring user customization.
  hotThresholds: HotThresholds;
  // When true, the toolbar bar above the list renders the Hot rule
  // customize button + expandable panel. Only `/hot` sets it.
  showHotCustomize?: boolean;
  // When true, the toolbar renders the one-row "Try the Hot view"
  // promo link + dismiss button on the left. Only `/` (home top
  // feed) sets it; suppressed once the reader has dismissed the promo.
  showHomePromo?: boolean;
}

interface StoryListItemRightAction {
  label: string;
  icon: ReactNode;
  onToggle: () => void;
  testId?: string;
  // When explicitly false, the button renders without the
  // `pin-btn--active` orange tint — so a "read-only / inactive"
  // affordance (e.g. the Preview's hollow-pin variant) doesn't
  // get painted in HN orange like the normal pin/exclam icons
  // do. Default true preserves backwards compat.
  active?: boolean;
}

// Material Symbols Outlined — Apache 2.0, Google. Same glyphs as the
// list toolbar's Undo / Sweep buttons, repeated inline so the list
// footer doesn't have to reach into ListToolbar for an icon.
function SweepIcon() {
  return (
    <svg
      className="list-footer__icon"
      viewBox="0 -960 960 960"
      fill="currentColor"
      width="24"
      height="24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M400-240v-80h240v80H400Zm-158 0L15-467l57-57 170 170 366-366 57 57-423 423Zm318-160v-80h240v80H560Zm160-160v-80h240v80H720Z" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg
      className="list-footer__icon"
      viewBox="0 -960 960 960"
      fill="currentColor"
      width="24"
      height="24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M280-200v-80h284q63 0 109.5-40T720-420q0-60-46.5-100T564-560H312l104 104-56 56-200-200 200-200 56 56-104 104h252q97 0 166.5 63T800-420q0 94-69.5 157T564-200H280Z" />
    </svg>
  );
}

export function StoryList({ feed, homePromo = false }: Props) {
  const feedItems = useFeedItems(feed);
  // Subscribe to the user's Hot customize panel overrides once per route
  // mount and pass them down so `<StoryListImpl>` doesn't open its
  // own subscription (Copilot review on PR #240).
  const { prefs: hotThresholds } = useHotThresholds();
  return (
    <StoryListImpl
      feedItems={feedItems}
      sourceFeed={feed}
      hotThresholds={hotThresholds}
      showHomePromo={homePromo}
    />
  );
}

// `/hot` shim: same render path, different data source + a per-row
// `flag` override so rows that came from the `/new` source carry a
// `new` debug segment (the suppressed `hot` segment is what every
// other row would otherwise render — see SPEC.md *Hot flag*). The
// empty state copy matches SPEC.md *Story feeds → /hot*.
//
// The Hot customize panel sits above the list as the inline editor for
// the user's `/hot` rule (per-branch on/off + four slider numbers).
// It's a sibling rather than a wrapper so the empty state, error
// state, and load skeletons render below it and the editor stays
// visible — important when the user has both branches off and the
// list is empty as a result.
export function HotStoryList() {
  // `useHotFeedItems` requires an explicit predicate; bind it to the
  // user's Hot customize panel overrides here so the threshold subscription
  // only lives on `/hot` (and not on `/tuning`, which passes its own
  // compiled expression instead).
  //
  // `hotNow` is captured once per render and closed over by a plain
  // (non-memoized) `hotPredicate`. All items in any single filter
  // pass evaluate against the same wall clock — saves per-row
  // `new Date()` allocations — and `hotNow` refreshes every render so
  // a More-button advance or refetch sees the current time. We
  // deliberately don't `useRef`-mutate during render (Copilot review
  // on PR #240) since concurrent React may discard/replay renders;
  // plain-function predicate keeps everything inside the committed
  // render. The trade-off is that `useHotFeedItems`'s inner filter
  // `useMemo` recomputes whenever this predicate's identity changes
  // (i.e. every render of `<HotStoryList>`); the work is ~60 items
  // of primitive math — sub-microsecond, well below render budget.
  const { prefs: hotThresholds } = useHotThresholds();
  const hotNow = new Date();
  const hotPredicate = (item: HNItem) =>
    isHotStory(item, hotNow, hotThresholds);
  const feedItems = useHotFeedItems(hotPredicate);
  const newSourceIds = feedItems.newSourceIds;
  const flagFor = useCallback(
    (id: number): RowFlag => (newSourceIds.has(id) ? 'new' : null),
    [newSourceIds],
  );
  return (
    <StoryListImpl
      feedItems={feedItems}
      flagFor={flagFor}
      emptyMessage="Nothing hot right now."
      sourceFeed="hot"
      hotThresholds={hotThresholds}
      showHotCustomize
    />
  );
}

// Inner renderer shared by `<StoryList>` (the standard feed shim
// above) and `<HotStoryList>` (the /hot route, which uses a
// different data hook to merge `/top` and `/new`). All sweep / IO
// observer / prefetch / "load more" wiring lives here so the two
// entry points behave identically except for the data source and
// the per-row flag override.
export function StoryListImpl({
  feedItems,
  flagFor,
  emptyMessage = 'No stories yet.',
  sourceFeed,
  includeOffFeedPinned = true,
  rightActionFor,
  showVelocity = false,
  includeDone = false,
  includeHidden = false,
  readOnly = false,
  hotThresholds,
  showHotCustomize = false,
  showHomePromo = false,
}: ImplProps) {
  useListKeyboardNav();
  const queryClient = useQueryClient();
  const isRestoring = useIsRestoring();
  const { isAuthenticated } = useAuth();
  const { hiddenIds, hide, hideMany } = useHiddenStories();
  const { doneIds } = useDoneStories();
  const { articleOpenedIds, commentsOpenedIds, seenCommentCounts, unopen } =
    useOpenedStories();
  const { pinnedIds, pin, unpin } = usePinnedStories();
  const shareStory = useShareStory();
  const { setSweep, recordHide, canUndo, undo, setOnUndo } = useFeedBar();
  const { hideOnScroll } = useHideOnScroll();
  const { stickyBottomBar } = useStickyBottomBar();
  // `hotThresholds` is supplied by the parent (`<StoryList>` for
  // shipping feeds, `<HotStoryList>` for /hot, `ThresholdTuningPage`
  // for the Preview), so this component opens no `useHotThresholds`
  // subscription of its own. `flagFor` (when supplied) still wins
  // per row; when it returns undefined we fall through to the
  // auto-computed user-tuned `isHotStory`. `now` is captured once
  // per render so all rows in this paint evaluate against the same
  // wall-clock instant — saves per-row `new Date()` allocations and
  // keeps the velocity branch consistent across rows in a single
  // commit. `computeFlag` is a plain function (not `useCallback`)
  // because it's only invoked inline inside the `.map` below — no
  // memoized child cares about its identity.
  const now = new Date();
  const computeFlag = (story: HNItem): RowFlag => {
    const explicit = flagFor?.(story.id);
    if (explicit !== undefined) return explicit;
    return isHotStory(story, now, hotThresholds) ? 'hot' : null;
  };

  const {
    items,
    hasMore,
    isFetchingMore,
    loadMore,
    refetch,
    isError,
    isRefreshing,
    refreshFailed,
  } = feedItems;
  const { stories: rawPinnedStories } = usePinnedFeedStories(
    items,
    includeOffFeedPinned,
  );
  useEffect(() => {
    if (!includeOffFeedPinned) return;
    if (isRestoring) return;
    refreshPinnedStoriesForHomeView(queryClient);
    const refreshOnFocus = () => refreshPinnedStoriesForHomeView(queryClient);
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, [includeOffFeedPinned, isRestoring, pinnedIds, queryClient]);
  // Ids the reader has pinned while the row was rendered in the feed
  // body. Pinning shouldn't yank a story you're looking at into the
  // top block — keep it at its natural feed position and let the
  // explicit Sweep gesture be the moment all in-body pins consolidate
  // into the top block (see commitSweep). On a fresh mount this set
  // is empty, so pre-existing pins still surface at the top as
  // before. Garbage-collected by the effect below: an id falls out
  // the moment the row stops being able to render in body (unpinned,
  // or the feed window no longer contains it after a PTR/refresh) so
  // it can't reactivate if the same row later returns to the feed
  // window (loadMore, cross-device sync) — the intent was "just
  // pinned, here-and-now", and a stale marker would silently re-route
  // a re-fetched pin into the body instead of the top block.
  const [stayInBodyIds, setStayInBodyIds] = useState<Set<number>>(
    () => new Set(),
  );

  // Reconcile stayInBodyIds with the external feed/pinned state. This
  // is the only place that drops stale entries when a row leaves the
  // feed window via PTR/refetch (the user takes no action, so a
  // handler can't catch it). The lint rule usually warns about derived
  // state — but here the state really is reconciliation history with
  // external sources (React Query items, the pinned-stories store),
  // exactly the "subscribe for updates from some external system"
  // case the rule's own docs call out. The updater returns `prev`
  // unchanged when nothing dropped out, so a re-run with no change
  // can't cascade; the `[items, pinnedIds]` deps mean it only fires
  // when one of those external sources actually moved.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see comment above
    setStayInBodyIds((prev) => {
      if (prev.size === 0) return prev;
      const itemIds = new Set<number>();
      for (const item of items) {
        if (item) itemIds.add(item.id);
      }
      const next = new Set<number>();
      let changed = false;
      for (const id of prev) {
        if (itemIds.has(id) && pinnedIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [items, pinnedIds]);

  const inBodyPinnedIds = useMemo<ReadonlySet<number>>(() => {
    if (stayInBodyIds.size === 0) return EMPTY_ID_SET;
    // Defense-in-depth for the one render between `items` / `pinnedIds`
    // changing and the GC effect above committing — the body filter and
    // top-block filter both consult this, so excluding stale entries
    // here keeps a row from briefly rendering in neither place.
    const itemIds = new Set<number>();
    for (const item of items) {
      if (item) itemIds.add(item.id);
    }
    const result = new Set<number>();
    for (const id of stayInBodyIds) {
      if (itemIds.has(id) && pinnedIds.has(id)) result.add(id);
    }
    return result;
  }, [stayInBodyIds, items, pinnedIds]);

  // Pin is a shield against Hide, so new state can't produce a pin ∩
  // hidden collision (swipe-right and menu "Hide" are blocked on
  // pinned rows; see StoryListItem). The hidden-collision filter is
  // defense-in-depth for legacy storage that predates that rule and
  // for brief cross-device-sync windows where the two stores could
  // disagree. The `inBodyPinnedIds` filter keeps in-session pins out
  // of the top block until Sweep consolidates them.
  const pinnedTopStories = useMemo(() => {
    if (!includeOffFeedPinned) return [];
    return rawPinnedStories.filter(
      (s) => !hiddenIds.has(s.id) && !inBodyPinnedIds.has(s.id),
    );
  }, [rawPinnedStories, hiddenIds, includeOffFeedPinned, inBodyPinnedIds]);

  // Pin/hide can target either an in-feed row or one of the pinned rows
  // that prepend the list. Look in both collections so the telemetry
  // call doesn't silently miss a story that's only in the top block
  // (e.g. a pin whose feed page hasn't been loaded).
  const lookupStory = useCallback(
    (id: number) =>
      items.find((it): it is NonNullable<typeof it> => it?.id === id) ??
      pinnedTopStories.find((s) => s.id === id) ??
      null,
    [items, pinnedTopStories],
  );

  const handlePin = useCallback(
    (id: number) => {
      pin(id);
      // Keep the row at its natural feed position if it's currently
      // rendered in the body — pinning shouldn't jump it into the top
      // block under the reader's eye. Sweep is what consolidates.
      const inLoadedFeed = items.some((it) => it?.id === id);
      if (inLoadedFeed) {
        setStayInBodyIds((prev) => {
          if (prev.has(id)) return prev;
          const next = new Set(prev);
          next.add(id);
          return next;
        });
      }
      const story = lookupStory(id);
      if (story) {
        prefetchPinnedStory(queryClient, story);
        recordFirstAction('pin', story, sourceFeed, {
          isAuthenticated,
          articleOpened: articleOpenedIds.has(id),
        });
      }
    },
    [
      pin,
      items,
      lookupStory,
      queryClient,
      sourceFeed,
      isAuthenticated,
      articleOpenedIds,
    ],
  );

  const handleUnpin = useCallback(
    (id: number) => {
      unpin(id);
      setStayInBodyIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    [unpin],
  );

  const handleHideOne = useCallback(
    (id: number) => {
      hide(id);
      recordHide([id]);
      const story = lookupStory(id);
      if (story) {
        recordFirstAction('hide', story, sourceFeed, {
          isAuthenticated,
          articleOpened: articleOpenedIds.has(id),
        });
      }
    },
    [
      hide,
      recordHide,
      lookupStory,
      sourceFeed,
      isAuthenticated,
      articleOpenedIds,
    ],
  );

  // Auto-dismiss-on-scroll: hide unpinned rows the moment they scroll off the
  // top of the viewport (the reader scrolled past them without pinning). Each
  // burst gets a fresh batchKey; recordHide only extends a batch with a matching
  // key, so the whole scroll burst restores with one Undo, while an intervening
  // swipe/Sweep (keyless) can't be folded into a later scroll hide. A gap longer
  // than the window also starts a new burst. Pinned and already-hidden rows are
  // shielded. Gated on the hideOnScroll setting (off by default).
  const lastScrollHideAt = useRef(0);
  const scrollBatchKey = useRef(0);
  const handleScrolledPast = useCallback(
    (ids: readonly number[]) => {
      // The /tuning Preview mounts StoryListImpl with `readOnly` (and
      // includeDone/includeHidden) and suppresses every mutation affordance —
      // auto-dismiss must not mutate the reader's hidden store there either.
      if (readOnly) return;
      const toHide = ids.filter(
        (id) => !pinnedIds.has(id) && !hiddenIds.has(id),
      );
      if (toHide.length === 0) return;
      const now = Date.now();
      if (now - lastScrollHideAt.current >= DISMISS_BATCH_WINDOW_MS) {
        // A gap ends the burst; mint a globally-unique key for the new one so it
        // can't extend another list's (or this list's prior) undo batch.
        scrollBatchKey.current = ++scrollBurstSeq;
      }
      lastScrollHideAt.current = now;
      hideMany(toHide);
      recordHide(toHide, { batchKey: scrollBatchKey.current });
    },
    [readOnly, pinnedIds, hiddenIds, hideMany, recordHide],
  );

  // Visibility floor: filter out stories that haven't earned at least one
  // organic upvote (HN submissions start at score 1 from the
  // submitter's implicit self-vote; `> 1` means at least one other
  // person has voted). This is a live, per-render check, not a
  // persistent filter — if a story's score climbs above 1 on a
  // subsequent feed refetch, it rejoins the list automatically.
  // Done and hidden are filtered by default: Done is the
  // completion log and Hide is "never show again", so the feed
  // should represent "what's still worth looking at". The
  // `includeDone` and `includeHidden` opt-ins flip those off for
  // the `/tuning` Preview, where the question is "what does the
  // rule surface" (so done rows stay in to show full rule output)
  // and "is the rule promoting something I rejected" (so hidden
  // rows light up the yellow question mark as a false-positive cue).
  // The single source of truth for "will this fetched item render?".
  // `visibleStories` filters the rendered list with it, and it's also
  // handed to `loadMore` so `/hot`'s page chase counts the same rows
  // the list will show — otherwise the chase could stop on a hot story
  // the reader has hidden or marked done, the renderer would drop it,
  // and the More tap would reveal nothing (a dead button).
  const isRowVisible = useCallback(
    (it: HNItem): boolean =>
      !it.deleted &&
      !it.dead &&
      (it.score ?? 0) > 1 &&
      (includeHidden || !hiddenIds.has(it.id)) &&
      (includeDone || !doneIds.has(it.id)) &&
      // Pinned rows render exactly once: either at their natural feed
      // position (pinned in-session, see stayInBodyIds) or in the top
      // block (the default — pre-existing pins, off-feed pins). The
      // /tuning Preview opts out of the top block entirely, so it
      // leaves pinned rows in place.
      (!includeOffFeedPinned ||
        !pinnedIds.has(it.id) ||
        inBodyPinnedIds.has(it.id)),
    [
      hiddenIds,
      doneIds,
      includeHidden,
      includeDone,
      includeOffFeedPinned,
      pinnedIds,
      inBodyPinnedIds,
    ],
  );

  const visibleStories = useMemo(
    () =>
      items.filter(
        (it): it is NonNullable<typeof it> => it != null && isRowVisible(it),
      ),
    [items, isRowVisible],
  );

  // Opportunistically warm the thread/comment cache for currently-trending
  // stories so tapping one feels instant. We only fire once per story id
  // per session (tracked by `warmedIdsRef`) and skip anything already in
  // the query cache — see `prefetchFeedStory` for the cost note.
  const warmedIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    for (const story of visibleStories) {
      if ((story.score ?? 0) <= FEED_PREFETCH_SCORE_THRESHOLD) continue;
      if (warmedIdsRef.current.has(story.id)) continue;
      warmedIdsRef.current.add(story.id);
      prefetchFeedStory(queryClient, story);
    }
  }, [visibleStories, queryClient]);

  // Sweep only applies to rows the user can actually see *right now*, not
  // the whole rendered list. A row counts as "in view" iff its bounding
  // box sits entirely inside the viewport minus the sticky chrome at
  // the top (header + list toolbar). We track that via a shared
  // IntersectionObserver whose rootMargin shrinks the top of the
  // viewport by the combined sticky-strip height.
  const [inViewIds, setInViewIds] = useState<Set<number>>(() => new Set());
  const rowEls = useRef<Map<number, HTMLLIElement>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const stickyInset = useStickyInset();
  // Bottom intrusion of the pinned bar (0 unless the sticky-bottom-bar setting
  // is on), so a row behind it isn't swept — mirrors the top sticky inset. The
  // footer element is captured by a callback ref into state so the inset
  // re-measures the instant the footer mounts (a cold load renders the skeleton
  // first); gated on the setting so the non-sticky footer never insets.
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);
  const footerInset = useStickyFooterInset(stickyBottomBar ? footerEl : null);

  // Rows that have been fully visible at least once *while the setting is on*.
  // Only a previously-seen row that then leaves via the top counts as "scrolled
  // past" — this excludes rows still below the fold (never intersected).
  const seenRef = useRef<Set<number>>(new Set());

  // Latest inViewIds mirrored into a ref so the enable effect can seed from it
  // without subscribing to it (depending on inViewIds would re-seed seen on
  // every scroll and wipe the accumulating set).
  const inViewIdsRef = useRef(inViewIds);
  useEffect(() => {
    inViewIdsRef.current = inViewIds;
  }, [inViewIds]);

  // Latest setting + handler held in refs so toggling hideOnScroll or
  // re-deriving the handler never recreates the observer (its effect only
  // depends on the insets). Updated in effects, matching the hideManyRef /
  // recordHideRef pattern below.
  const hideOnScrollRef = useRef(hideOnScroll);
  const onScrolledPastRef = useRef(handleScrolledPast);
  useEffect(() => {
    hideOnScrollRef.current = hideOnScroll;
    // On enable, seed `seen` with exactly the rows fully visible *right now*.
    // Those become dismissable on their next top-exit (so the setting applies to
    // what's on screen immediately), while rows already scrolled past — above the
    // viewport, absent from inViewIds — stay excluded so they aren't retroactively
    // hidden (e.g. when toggling Sticky bottom toolbar recreates the observer
    // below and replays initial non-intersecting entries). The observer only adds
    // to `seen` while the setting is on, so rows that enter view later are
    // tracked going forward.
    if (hideOnScroll) seenRef.current = new Set(inViewIdsRef.current);
  }, [hideOnScroll]);
  useEffect(() => {
    onScrolledPastRef.current = handleScrolledPast;
  }, [handleScrolledPast]);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const exitedTop: number[] = [];
        const nowVisible: number[] = [];
        const nowHidden: number[] = [];
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          const id = Number(el.dataset.storyId);
          if (!id) continue;
          if (entry.intersectionRatio >= FULLY_VISIBLE_RATIO) {
            nowVisible.push(id);
            // Only track "seen" while the setting is on, so a row fully viewed
            // with auto-dismiss off never becomes dismissable after a later
            // enable (paired with the clear-on-enable above).
            if (hideOnScrollRef.current) seenRef.current.add(id);
          } else {
            nowHidden.push(id);
            // A previously-seen row now fully out of view: auto-dismiss it only
            // if it left via the *top* (scrolled past while reading down), not
            // the bottom (scrolled back up). rootBounds is unavailable in jsdom;
            // treat its absence as a top exit, which the seen-guard already keeps
            // from firing on below-the-fold rows.
            if (
              hideOnScrollRef.current &&
              !entry.isIntersecting &&
              seenRef.current.has(id)
            ) {
              const rb = entry.rootBounds;
              if (rb ? entry.boundingClientRect.bottom <= rb.top : true) {
                exitedTop.push(id);
              }
            }
          }
        }
        if (nowVisible.length || nowHidden.length) {
          setInViewIds((prev) => {
            const next = new Set(prev);
            for (const id of nowVisible) next.add(id);
            for (const id of nowHidden) next.delete(id);
            return next;
          });
        }
        if (exitedTop.length) onScrolledPastRef.current(exitedTop);
      },
      {
        threshold: [0, FULLY_VISIBLE_RATIO, 1],
        rootMargin: `-${stickyInset}px 0px -${footerInset}px 0px`,
      },
    );
    observerRef.current = io;
    for (const el of rowEls.current.values()) io.observe(el);
    return () => {
      io.disconnect();
      observerRef.current = null;
    };
  }, [stickyInset, footerInset]);

  // Cache one stable callback-ref per row id so React doesn't tear
  // down the IntersectionObserver attachment on every render. The
  // proper React-19 alternative is a single callback ref that returns
  // a cleanup function, but we're still on 18.3 where cleanup-returning
  // refs don't exist — hence the per-id cache held in a useRef. Two
  // `react-hooks/refs` disables below silence the rule at the two map
  // call sites that thread `getRowRef` into JSX.
  const rowRefCache = useRef<
    Map<number, (el: HTMLLIElement | null) => void>
  >(new Map());
  const getRowRef = useCallback((id: number) => {
    const cached = rowRefCache.current.get(id);
    if (cached) return cached;
    const setRef = (el: HTMLLIElement | null) => {
      const io = observerRef.current;
      const prev = rowEls.current.get(id);
      if (prev && prev !== el) {
        io?.unobserve(prev);
        rowEls.current.delete(id);
        // Forget that this row was ever seen once it leaves the DOM, so an
        // Undo-restored row that remounts above the viewport isn't instantly
        // re-dismissed by its first non-intersecting observation.
        seenRef.current.delete(id);
        setInViewIds((s) => {
          if (!s.has(id)) return s;
          const next = new Set(s);
          next.delete(id);
          return next;
        });
      }
      if (el) {
        rowEls.current.set(id, el);
        io?.observe(el);
      }
    };
    rowRefCache.current.set(id, setRef);
    return setRef;
  }, []);

  // Warm the server-side Gemini summary caches (/api/summary and
  // /api/comments-summary, both Upstash-backed) for rows the user has
  // actually scrolled into view. This replaces a periodic cron — instead
  // of generating summaries for every story on a schedule, we generate
  // them on demand for the stories people are actually looking at. The
  // endpoints already short-circuit on a KV hit, so only the first view
  // of each story in a TTL window pays a Gemini call. Session-scoped
  // dedup via `warmedServerIdsRef` stops us from re-hitting the server
  // as a row re-enters the viewport during scroll.
  const warmedServerIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (inViewIds.size === 0) return;
    for (const story of visibleStories) {
      if (!inViewIds.has(story.id)) continue;
      if (warmedServerIdsRef.current.has(story.id)) continue;
      warmedServerIdsRef.current.add(story.id);
      warmFeedSummaries(story);
    }
  }, [inViewIds, visibleStories]);

  const sweepableIds = useMemo(
    () =>
      readOnly
        ? []
        : visibleStories
            .map((s) => s.id)
            .filter(
              (id) =>
                inViewIds.has(id) &&
                !pinnedIds.has(id) &&
                !hiddenIds.has(id),
            ),
    [readOnly, visibleStories, inViewIds, pinnedIds, hiddenIds],
  );

  // Visual "whoosh" when sweep fires: every unpinned, fully-visible row
  // slides+fades out together as a single gesture (matches the verb —
  // sweep is one motion, not a staggered cascade), then the hide
  // commits once the animation finishes. CSS gates the actual motion
  // behind `prefers-reduced-motion: no-preference`; JS mirrors that
  // gate so readers who opted out skip the delay too.
  //
  // The commit is driven by the `animationend` signal that bubbles up
  // from the swept `<li>` (so JS follows whatever duration the CSS
  // defines), with a fallback timer at 2× SWEEP_ANIMATION_MS in case
  // the event never fires — background-tab throttling, the browser
  // optimizing out the animation on an offscreen element, jsdom not
  // synthesizing animation events, etc.
  const [sweepingIds, setSweepingIds] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const sweepPendingIdsRef = useRef<readonly number[] | null>(null);
  const sweepFallbackTimerRef = useRef<number | null>(null);
  // Keep handler refs so the unmount cleanup below can commit without
  // re-subscribing every time hideMany/recordHide change identity.
  const hideManyRef = useRef(hideMany);
  const recordHideRef = useRef(recordHide);
  useEffect(() => {
    hideManyRef.current = hideMany;
  }, [hideMany]);
  useEffect(() => {
    recordHideRef.current = recordHide;
  }, [recordHide]);

  const commitSweep = useCallback(() => {
    const ids = sweepPendingIdsRef.current;
    if (!ids) return;
    sweepPendingIdsRef.current = null;
    if (sweepFallbackTimerRef.current != null) {
      window.clearTimeout(sweepFallbackTimerRef.current);
      sweepFallbackTimerRef.current = null;
    }
    hideMany(ids);
    recordHide(ids);
    setSweepingIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    // Sweep is the moment in-session body pins consolidate into the
    // top block (see stayInBodyIds). Clearing the set right after the
    // hide commit means the next render sees pinned rows surface at
    // the top in one motion with the unpinned rows leaving.
    setStayInBodyIds((prev) => (prev.size === 0 ? prev : new Set()));
  }, [hideMany, recordHide]);

  // If the list unmounts (route change, etc.) while a sweep is still
  // animating, commit the hide synchronously so the action isn't
  // silently dropped — the user's intent ("hide everything unpinned")
  // has already been recorded by the tap. Uses refs to avoid
  // re-subscribing the cleanup every render.
  useEffect(() => {
    return () => {
      const ids = sweepPendingIdsRef.current;
      if (ids) {
        hideManyRef.current(ids);
        recordHideRef.current(ids);
        sweepPendingIdsRef.current = null;
      }
      if (sweepFallbackTimerRef.current != null) {
        window.clearTimeout(sweepFallbackTimerRef.current);
        sweepFallbackTimerRef.current = null;
      }
    };
  }, []);

  const handleSweep = useCallback(() => {
    if (sweepableIds.length === 0) return;
    // Ignore repeat taps while a sweep is already playing out — the
    // second batch would be identical (hiddenIds hasn't updated yet).
    if (sweepPendingIdsRef.current !== null) return;
    const ids = sweepableIds.slice();
    const reducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
      hideMany(ids);
      recordHide(ids);
      setStayInBodyIds((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    sweepPendingIdsRef.current = ids;
    setSweepingIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    sweepFallbackTimerRef.current = window.setTimeout(
      commitSweep,
      SWEEP_ANIMATION_MS * 2,
    );
  }, [sweepableIds, hideMany, recordHide, commitSweep]);

  // First `animationend` from a swept row drives the commit — `<li>`
  // elements all animate with the same duration, so one signal is
  // enough. Filter by animationName so an unrelated descendant
  // animation (a skeleton shimmer, etc.) can't accidentally trigger
  // the commit.
  const handleListAnimationEnd = useCallback(
    (e: ReactAnimationEvent<HTMLOListElement>) => {
      if (e.animationName !== 'story-list__sweep-out') return;
      commitSweep();
    },
    [commitSweep],
  );

  useEffect(() => {
    setSweep(handleSweep, sweepableIds.length);
    return () => setSweep(null, 0);
  }, [setSweep, handleSweep, sweepableIds.length]);

  // Ids restored by the most recent Undo, awaiting a scroll-into-view. After
  // undoing an auto-dismiss-on-scroll burst the restored rows remount *above*
  // the viewport (they sit earlier in the feed than where the reader scrolled
  // to), so bring the topmost one back on screen. The Undo button lives in the
  // toolbar, so we register a handler with the shared feed bar; the scroll
  // itself is deferred to the effect below, which fires once the restored rows
  // are back in the rendered list.
  const pendingUndoScrollIds = useRef<Set<number> | null>(null);
  const handleUndoScroll = useCallback((ids: readonly number[]) => {
    pendingUndoScrollIds.current = ids.length > 0 ? new Set(ids) : null;
  }, []);
  useEffect(() => {
    setOnUndo(handleUndoScroll);
    return () => setOnUndo(null);
  }, [setOnUndo, handleUndoScroll]);

  // Scroll back up to the topmost row an Undo just restored, but only when it's
  // off-screen above the fold — so undoing a scroll-past burst returns the
  // reader to where they were reading, while undoing a swipe/Sweep (whose rows
  // are still on screen) never jerks the viewport.
  useEffect(() => {
    const pending = pendingUndoScrollIds.current;
    if (!pending) return;
    // Consume the request on this single post-undo render. Un-hiding is
    // synchronous, so any restored rows that belong to this feed are already
    // back in visibleStories — one pass is enough. Clearing even when none match
    // stops a stale request from scrolling later: the undo batch is global, so
    // Undo may restore rows that live in a different feed the reader navigated
    // from, and a later refresh could otherwise surface one of those ids and
    // scroll this feed unexpectedly (Codex P2 on PR #357).
    pendingUndoScrollIds.current = null;
    const restoredInList = visibleStories.filter((s) => pending.has(s.id));
    if (restoredInList.length === 0) return;
    let target: HTMLElement | null = null;
    for (const s of restoredInList) {
      const el = document.querySelector(`[data-story-id="${s.id}"]`);
      if (el instanceof HTMLElement) {
        target = el;
        break;
      }
    }
    if (!target) return;
    const chrome = measureStickyInset();
    const top = target.getBoundingClientRect().top;
    if (top >= chrome) return; // already fully below the sticky chrome — on screen
    // Browsers honoring prefers-reduced-motion fall back to an instant scroll.
    window.scrollTo({
      top: Math.max(0, top + window.scrollY - chrome),
      behavior: 'smooth',
    });
  }, [visibleStories]);

  // Refresh == "pull the feed + cross-device sync state + latest
  // app bundle". Same callback PullToRefresh uses — see onRefresh
  // below. `cloudSyncPullNow` and `checkForServiceWorkerUpdate` are
  // outer-scope module imports, not dependencies of this hook —
  // `react-hooks/exhaustive-deps` flags adding them (their values
  // can't mutate in a way that would require a re-callback).
  //
  // `checkForServiceWorkerUpdate` pings the SW to re-fetch `/sw.js`
  // and reloads the tab if a newer build has shipped. Without it
  // the browser only re-checks on full navigation, and our custom
  // PTR overrides the browser's native swipe-to-reload, so a
  // session parked on one route stays on the old bundle — the
  // failure mode that made Vercel preview testing after a
  // force-push unreliable.
  const handleRefresh = useCallback(
    () =>
      Promise.all([refetch(), cloudSyncPullNow(), checkForServiceWorkerUpdate()]),
    [refetch],
  );

  // Snapshot the current comment count so later visits can show a
  // "N new" badge for anything posted since. Look the story up in both
  // the feed page and the off-feed pinned list — a tap on a pinned
  // story that has scrolled off the feed otherwise wouldn't record
  // anything.
  const handleOpenThread = useCallback(
    (id: number) => {
      const story =
        items.find((it): it is NonNullable<typeof it> => it?.id === id) ??
        pinnedTopStories.find((s) => s.id === id);
      markCommentsOpenedId(id, Date.now(), story?.descendants ?? 0);
    },
    [items, pinnedTopStories],
  );

  // Long-press "Mark unread" should clear both opened halves so the row
  // immediately returns to the unread visual state (and drops from /opened).
  const handleMarkUnread = useCallback((id: number) => unopen(id), [unopen]);

  // The bar sits above every render state (loading skeletons, error,
  // empty, populated) so the toolbar controls stay reachable in every
  // case — readOnly (the /tuning Preview) opts out since the page has
  // its own controls and no sweep affordance applies there.
  const toolbar = readOnly ? null : (
    <ListToolbar
      showHotCustomize={showHotCustomize}
      showHomePromo={showHomePromo}
    />
  );

  // Tells the reader what's happening to the *visible* list when they open
  // it after a while: a quiet "Checking for new stories…" while a refresh
  // is in flight over the persisted snapshot, or a "Couldn't load new
  // stories — Retry" when that refresh failed (so we don't silently leave
  // them on a stale feed). Rendered at the foot of the list, just above the
  // More / Back-to-top row, so all the load-related affordances sit
  // together. The /tuning Preview (readOnly) opts out — it has its own
  // chrome and isn't a reading surface.
  const refreshStatus =
    readOnly || !(isRefreshing || refreshFailed) ? null : (
      <div
        className={'feed-refresh' + (refreshFailed ? ' feed-refresh--failed' : '')}
        role="status"
        aria-live="polite"
        data-testid="feed-refresh"
      >
        {refreshFailed ? (
          <>
            <span className="feed-refresh__msg">Couldn’t load new stories.</span>
            <button
              type="button"
              className="feed-refresh__retry"
              onClick={() => refetch()}
            >
              Retry
            </button>
          </>
        ) : (
          <span className="feed-refresh__msg">
            <span className="feed-refresh__spinner" aria-hidden="true" />
            Checking for new stories…
          </span>
        )}
      </div>
    );

  const hasAnyItems = items.length > 0;
  // `isPending` (no data yet, regardless of why) covers both the
  // in-flight first fetch and the PersistQueryClientProvider rehydrate
  // window. The narrower `isLoading` (= `isPending && isFetching`)
  // would be false during rehydrate and let "No stories yet." flash
  // on first paint.
  if (!hasAnyItems && feedItems.isPending) {
    return (
      <>
        {toolbar}
        <ol className="story-list" aria-busy="true" aria-label="Loading stories">
          {Array.from({ length: 6 }).map((_, i) => (
            <li key={i} className="story-list__item">
              <StoryRowSkeleton />
            </li>
          ))}
        </ol>
      </>
    );
  }

  if (isError) {
    return (
      <>
        {toolbar}
        <ErrorState message="Could not load stories." onRetry={refetch} />
      </>
    );
  }

  if (
    visibleStories.length === 0 &&
    pinnedTopStories.length === 0 &&
    !hasMore
  ) {
    return (
      <>
        {toolbar}
        <EmptyState message={emptyMessage} />
      </>
    );
  }

  return (
    <>
    {toolbar}
    <PullToRefresh
      // Pull cross-device sync state alongside the HN feed — PTR is
      // the user's "show me the latest" gesture and they'd expect
      // pins from other devices to land here too. cloudSyncPullNow
      // (inside handleRefresh) is a no-op when the user isn't
      // signed in.
      onRefresh={handleRefresh}
    >
      <ol className="story-list" onAnimationEnd={handleListAnimationEnd}>
        {/* eslint-disable-next-line react-hooks/refs -- getRowRef caches per-id callback refs, see rowRefCache note above */}
        {pinnedTopStories.map((story) => (
          <li
            key={`pinned-${story.id}`}
            ref={getRowRef(story.id)}
            className="story-list__item"
            data-story-id={story.id}
            data-pinned-top="true"
          >
            <StoryListItem
              story={story}
              articleOpened={articleOpenedIds.has(story.id)}
              commentsOpened={commentsOpenedIds.has(story.id)}
              seenCommentCount={seenCommentCounts.get(story.id)}
              pinned
              flag={computeFlag(story)}
              rightAction={rightActionFor?.(story.id)}
              showVelocity={showVelocity}
              onHide={readOnly ? undefined : handleHideOne}
              onPin={readOnly ? undefined : handlePin}
              onUnpin={readOnly ? undefined : handleUnpin}
              onShare={readOnly ? undefined : shareStory}
              onMarkUnread={readOnly ? undefined : handleMarkUnread}
              onOpenThread={handleOpenThread}
              readOnly={readOnly}
            />
          </li>
        ))}
        {/* eslint-disable-next-line react-hooks/refs -- getRowRef caches per-id callback refs, see rowRefCache note above */}
        {visibleStories.map((story, idx) => (
          <li
            key={story.id}
            ref={getRowRef(story.id)}
            className={
              'story-list__item' +
              (sweepingIds.has(story.id) ? ' story-list__item--sweeping' : '')
            }
            data-story-id={story.id}
          >
            <StoryListItem
              story={story}
              rank={idx + 1}
              flag={computeFlag(story)}
              rightAction={rightActionFor?.(story.id)}
              showVelocity={showVelocity}
              articleOpened={articleOpenedIds.has(story.id)}
              commentsOpened={commentsOpenedIds.has(story.id)}
              seenCommentCount={seenCommentCounts.get(story.id)}
              pinned={pinnedIds.has(story.id)}
              // The `hidden` prop only drives the swipe-hint
              // label and the right-edge "Hidden" rubber-band —
              // the actual pin shield is enforced by the caller
              // withholding `onPin`/`onUnpin` (this is the same
              // pattern `LibraryStoryList` uses on `/hidden`).
              // On shipping feeds `visibleStories` already
              // filters out `hiddenIds`, so neither line below
              // does anything. On the /tuning Preview, where
              // `includeHidden` keeps hidden rows visible, the
              // pin shield here is load-bearing: without it a
              // swipe-left could pin a hidden story and recreate
              // the pin∩hidden collision the shield rule exists
              // to prevent.
              hidden={hiddenIds.has(story.id)}
              onHide={readOnly ? undefined : handleHideOne}
              onPin={
                readOnly || hiddenIds.has(story.id) ? undefined : handlePin
              }
              onUnpin={
                readOnly || hiddenIds.has(story.id) ? undefined : handleUnpin
              }
              onShare={readOnly ? undefined : shareStory}
              onMarkUnread={readOnly ? undefined : handleMarkUnread}
              onOpenThread={handleOpenThread}
              readOnly={readOnly}
            />
          </li>
        ))}
      </ol>
      {refreshStatus}
      <div
        ref={setFooterEl}
        className={
          'story-list__footer story-list__footer--feed' +
          (stickyBottomBar ? ' story-list__footer--sticky' : '')
        }
      >
        <BackToTopButton iconOnly />
        {/* Always rendered on a populated feed so reaching the end is
            explicit feedback, not a vanished control: enabled "More"
            while another page is available, then a grayed, disabled
            "No more stories" once the id list is exhausted (rather than
            removing the button, which read as "the button did
            nothing"). Library pages render their own footer and never
            reach here. */}
        <button
          type="button"
          className="load-more-btn"
          onClick={hasMore ? () => loadMore(isRowVisible) : undefined}
          disabled={!hasMore || isFetchingMore}
          aria-disabled={!hasMore || undefined}
        >
          {isFetchingMore ? 'Loading…' : hasMore ? 'More' : 'No more stories'}
        </button>
        {readOnly ? null : (
          <div className="story-list__footer-right">
            <TooltipButton
              type="button"
              className="list-footer__icon-btn"
              data-testid="undo-btn-bottom"
              onClick={canUndo ? undo : undefined}
              disabled={!canUndo}
              tooltip={canUndo ? 'Undo hide' : 'Nothing to undo'}
              aria-label={canUndo ? 'Undo hide' : 'Nothing to undo'}
            >
              <UndoIcon />
            </TooltipButton>
            <TooltipButton
              type="button"
              className="list-footer__icon-btn"
              data-testid="sweep-btn-bottom"
              onClick={sweepableIds.length > 0 ? handleSweep : undefined}
              disabled={sweepableIds.length === 0}
              tooltip={
                sweepableIds.length > 0 ? 'Hide unpinned' : 'Nothing to hide'
              }
              aria-label={
                sweepableIds.length > 0 ? 'Hide unpinned' : 'Nothing to hide'
              }
            >
              <SweepIcon />
            </TooltipButton>
          </div>
        )}
      </div>
    </PullToRefresh>
    </>
  );
}

export { PAGE_SIZE };
