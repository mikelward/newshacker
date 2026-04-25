import { useCallback, useMemo, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { HNItem } from '../lib/hn';
import {
  formatDisplayDomain,
  formatStoryMetaTail,
  isHotStory,
} from '../lib/format';
import { usePointerDevice } from '../hooks/usePointerDevice';
import { useSwipeToDismiss } from '../hooks/useSwipeToDismiss';
import { StoryRowMenu, type StoryRowMenuItem } from './StoryRowMenu';
import { TooltipButton } from './TooltipButton';
import './StoryListItem.css';

export type RowFlag = 'hot' | 'new' | null;

interface Props {
  story: HNItem;
  rank?: number;
  articleOpened?: boolean;
  commentsOpened?: boolean;
  /**
   * Total comment count at the moment the reader last opened the
   * thread. When provided, the row's meta shows a ` · N new` segment
   * for any extra comments posted since.
   */
  seenCommentCount?: number;
  pinned?: boolean;
  /**
   * Renders the "Hidden" swipe-hint label behind the row's right
   * edge and suppresses the "Pin" action hint there (swipe-left on
   * a hidden row rubber-bands — pin-on-hidden is blocked). Set by
   * LibraryStoryList when `hiddenIds.has(story.id)`. The row itself
   * is not dimmed — the pin ∩ hidden invariant removed the need for
   * a separate visual state; this prop is strictly the hint driver.
   */
  hidden?: boolean;
  onHide?: (id: number) => void;
  onPin?: (id: number) => void;
  onUnpin?: (id: number) => void;
  onShare?: (story: HNItem) => void;
  onOpenThread?: (id: number) => void;
  /**
   * Per-row override for the trailing flag segment in the meta line.
   * Default behavior (prop omitted or `undefined`): the row auto-
   * computes via `isHotStory(story)` and renders `hot` when true,
   * nothing otherwise — every standard feed (Top, New, Best, Ask,
   * Show, Jobs) leaves this prop unset so behavior is unchanged.
   * `null` suppresses the auto-computed flag without substituting
   * anything (used on `/hot` for `/top`-source rows, where every
   * row is hot by construction so the literal `hot` text is noise).
   * `'new'` forces the segment to render the literal `new` (used on
   * `/hot` for rows that came from the `/new` source and were not
   * also in the `/top` slice — the temporary debug affordance from
   * SPEC.md *Hot flag*). `'hot'` is included in the type for
   * symmetry but no caller currently forces it.
   */
  flag?: RowFlag;
  /**
   * Replaces the default Pin/Unpin button on the right side of the row
   * with a view-contextual action — used by library views (/done,
   * /favorites, /hidden) where every visible row already has the state
   * the button represents, so the "primary" row action is the inverse
   * (Unmark done, Unfavorite, Unhide) rather than Pin. The button
   * paints in the `--active` orange state by default (matching every
   * library view's filled-icon affordance); callers that want a
   * non-orange "informational / inactive" variant — e.g. the /tuning
   * Preview's hollow-pin button on a row the rule matches but the
   * operator hasn't engaged with — pass `active: false` to opt out.
   * See SPEC.md § "Library views" for the default-case rationale.
   */
  rightAction?: {
    label: string;
    icon: ReactNode;
    onToggle: () => void;
    testId?: string;
    /**
     * When explicitly false, the button renders without the
     * `pin-btn--active` orange tint — used for "informational
     * inactive" affordances (e.g. the /tuning Preview's
     * read-only hollow-pin variant). Default true preserves
     * backwards compat: every existing rightAction caller
     * (library views, exclam icons) wants the orange paint.
     */
    active?: boolean;
  };
  /**
   * When true, the meta line tucks points-per-hour into the
   * points segment as an inline parenthetical — "1h · 50 points
   * (25/h) · 10 comments". Off by default; only /hot and the
   * /tuning Preview enable it (where the operator is explicitly
   * looking at velocity for threshold tuning). Inline rather
   * than a separate dot-segment so the row stays tight on
   * narrow phones.
   */
  showVelocity?: boolean;
  /**
   * When true, the row binds no pointer-driven mutation
   * handlers: the long-press / right-click menu doesn't open
   * (so the Pin / Hide / Share items are unreachable), and
   * `useSwipeToDismiss` stays inert because all three of its
   * handlers are undefined (`onSwipeRight`/`Left` already are
   * when their commit handlers are absent; this flag also
   * suppresses `onLongPress`). Used by the /tuning Preview, in
   * conjunction with `StoryListImpl`'s own `readOnly` (which
   * withholds the commit handlers themselves), so an operator
   * tuning thresholds can't accidentally pin / hide a story by
   * swiping or long-pressing a row.
   */
  readOnly?: boolean;
}

export function StoryListItem({
  story,
  articleOpened = false,
  commentsOpened = false,
  seenCommentCount,
  pinned = false,
  hidden = false,
  readOnly = false,
  onHide,
  onPin,
  onUnpin,
  onShare,
  onOpenThread,
  rightAction,
  flag,
  showVelocity = false,
}: Props) {
  const hasExternalUrl = !!story.url;
  const domain = formatDisplayDomain(story.url);

  const title = story.title ?? '[untitled]';
  const domainLabel = hasExternalUrl ? domain : 'self post';

  const newCommentCount =
    seenCommentCount !== undefined
      ? Math.max(0, (story.descendants ?? 0) - seenCommentCount)
      : 0;

  // `flag` prop overrides the auto-computed Hot segment when set:
  // `null` suppresses the segment, `'new'` substitutes the literal
  // text. When the prop is omitted (every standard feed), behavior
  // matches the pre-/hot world — render `hot` iff `isHotStory` is
  // true, nothing otherwise.
  const flagText: 'hot' | 'new' | null =
    flag === undefined ? (isHotStory(story) ? 'hot' : null) : flag;

  const [menuOpen, setMenuOpen] = useState(false);
  const articleRef = useRef<HTMLElement>(null);
  const pointerDevice = usePointerDevice();

  const handleHide = useCallback(() => {
    onHide?.(story.id);
  }, [onHide, story.id]);

  const handlePin = useCallback(() => {
    onPin?.(story.id);
  }, [onPin, story.id]);

  const handleUnpin = useCallback(() => {
    onUnpin?.(story.id);
  }, [onUnpin, story.id]);

  const handleShare = useCallback(() => {
    onShare?.(story);
  }, [onShare, story]);

  const openMenu = useCallback(() => setMenuOpen(true), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  const handleOpenThread = useCallback(() => {
    onOpenThread?.(story.id);
  }, [onOpenThread, story.id]);

  const handleTogglePin = useCallback(() => {
    if (pinned) onUnpin?.(story.id);
    else onPin?.(story.id);
  }, [pinned, onPin, onUnpin, story.id]);

  // Pin and Hide are mutually exclusive: a pinned row can't be hidden
  // (swipe-right and the row-menu "Hide" item are suppressed) and a
  // hidden row can't be pinned (swipe-left and the menu "Pin" item
  // are suppressed when the caller marks the row as hidden; in
  // practice LibraryStoryList decides that by withholding
  // onPin/onUnpin from rows in `hiddenIds`). Additionally, a pinned
  // row rejects swipe-left as well — both swipe directions are
  // shielded on pinned rows, so a pin can't be re-timestamped
  // (silent reordering) by a stray swipe. A pin exits via Done
  // (normal lifecycle, clears the pin as a side effect — see
  // useDoneStories) or via Unpin (explicit). A hide exits via the
  // `/hidden` page's recover action or the feed-header Undo button.
  //
  // The suppressed gestures still *track* the finger and snap back
  // on release — rubber-band feedback, not silent absorption. That
  // comes for free from useSwipeToDismiss: the gesture activates
  // whenever any handler is wired (long-press always is), the row
  // translates as the finger moves, and on pointerup the direction
  // whose `handler` is `undefined` falls through to the hook's
  // snap-back branch. See SPEC.md under *Pinned vs. Favorite vs.
  // Done*.
  const { dragging, isDismissing, style, handlers } = useSwipeToDismiss({
    onSwipeRight: onHide && !pinned ? handleHide : undefined,
    onSwipeLeft: onPin && !pinned ? handlePin : undefined,
    // `readOnly` suppresses long-press too. Combined with
    // already-undefined swipe handlers (when StoryListImpl
    // withholds onPin/onHide), `useSwipeToDismiss` sees no
    // handlers wired and binds no pointer events at all
    // (line ~71 in the hook gates everything on
    // `hasAnyHandler`). The row no longer rubber-bands or
    // intercepts contextmenu — fully inert under tuning.
    onLongPress: readOnly ? undefined : openMenu,
  });

  // Right-click opens the same menu on pointer devices — the desktop
  // equivalent of touch long-press. The swipe-to-dismiss hook's own
  // onContextMenu already calls preventDefault when a long-press
  // handler is wired; we compose on top of it and only act when the
  // media query reports a hover-capable pointer, so we don't
  // double-fire on mobile where long-press also opens the menu and
  // the OS may fire a synthetic contextmenu.
  const swipeOnContextMenu = handlers.onContextMenu;
  const hasAnyMenuItem = !!(onHide || onPin || onUnpin || onShare);
  const handleContextMenu = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      swipeOnContextMenu?.(e);
      if (!pointerDevice || !hasAnyMenuItem) return;
      e.preventDefault();
      setMenuOpen(true);
    },
    [swipeOnContextMenu, pointerDevice, hasAnyMenuItem],
  );

  const rowOpened = articleOpened || commentsOpened;

  const rowClass =
    'story-row' +
    (dragging ? ' story-row--dragging' : '') +
    (isDismissing ? ' story-row--dismissing' : '') +
    (rowOpened ? ' story-row--opened' : '');

  const menuItems = useMemo<StoryRowMenuItem[]>(() => {
    const items: StoryRowMenuItem[] = [];
    if (pinned && onUnpin) {
      items.push({ key: 'unpin', label: 'Unpin', onSelect: handleUnpin });
    } else if (!pinned && onPin) {
      items.push({ key: 'pin', label: 'Pin', onSelect: handlePin });
    }
    // Hide is suppressed on pinned rows — same rule as swipe-right.
    // Pinned exits via Done (lifecycle) or Unpin (explicit).
    if (onHide && !pinned) {
      items.push({ key: 'hide', label: 'Hide', onSelect: handleHide });
    }
    if (onShare) {
      items.push({ key: 'share', label: 'Share', onSelect: handleShare });
    }
    return items;
  }, [
    pinned,
    onPin,
    onUnpin,
    onHide,
    onShare,
    handlePin,
    handleUnpin,
    handleHide,
    handleShare,
  ]);

  const pinLabel = pinned ? `Unpin ${title}` : `Pin ${title}`;

  // Swipe-reveal hints, shown behind the row. Each edge labels the
  // outcome of a swipe that reveals *that* edge: shield text when
  // the row's state blocks the gesture, action text when the
  // gesture commits. Static layout, revealed by the row's own
  // translate3d at rest vs. mid-swipe. See SPEC.md under *Pinned
  // vs. Favorite vs. Done*.
  //
  //   left edge  (revealed when finger pushes right):
  //     pinned      → "Pinned" (shield — swipe-right blocked)
  //     has onHide  → "Hide"   (action — swipe-right will hide)
  //   right edge (revealed when finger pushes left):
  //     hidden      → "Hidden" (shield — swipe-left blocked)
  //     pinned      → "Pinned" (shield — swipe-left also blocked,
  //                             both directions on a pinned row
  //                             rubber-band identically)
  //     has onPin   → "Pin"    (action — swipe-left will pin)
  const leftHint = pinned
    ? { label: 'Pinned', testId: 'swipe-hint-pinned-left' }
    : onHide
    ? { label: 'Hide', testId: 'swipe-hint-hide' }
    : null;
  const rightHint = hidden
    ? { label: 'Hidden', testId: 'swipe-hint-hidden' }
    : pinned
    ? { label: 'Pinned', testId: 'swipe-hint-pinned-right' }
    : onPin
    ? { label: 'Pin', testId: 'swipe-hint-pin' }
    : null;

  return (
    <>
      {leftHint ? (
        <span
          className="story-row__swipe-hint story-row__swipe-hint--left"
          data-testid={leftHint.testId}
          aria-hidden="true"
        >
          {leftHint.label}
        </span>
      ) : null}
      {rightHint ? (
        <span
          className="story-row__swipe-hint story-row__swipe-hint--right"
          data-testid={rightHint.testId}
          aria-hidden="true"
        >
          {rightHint.label}
        </span>
      ) : null}
      <article
        ref={articleRef}
        className={rowClass}
        data-testid="story-row"
        style={style}
        {...handlers}
        onContextMenu={handleContextMenu}
      >
      <Link
        to={`/item/${story.id}`}
        className="story-row__body story-row__body--stretched"
        data-testid="story-title"
        onClick={handleOpenThread}
      >
        <span className="story-row__title-text">{title}</span>
        <span className="story-row__meta" data-testid="story-meta">
          {domainLabel ? `${domainLabel} · ` : ''}
          {formatStoryMetaTail({ ...story, newCommentCount }, undefined, {
            showVelocity,
          })}
          {flagText ? (
            <>
              {' · '}
              <span className="story-row__hot" data-testid="story-hot">
                {flagText}
              </span>
            </>
          ) : null}
        </span>
      </Link>

      {rightAction ? (
        <TooltipButton
          type="button"
          className={
            'pin-btn' + (rightAction.active === false ? '' : ' pin-btn--active')
          }
          data-testid={rightAction.testId ?? 'row-action-btn'}
          aria-label={rightAction.label}
          tooltip={rightAction.label}
          onClick={rightAction.onToggle}
        >
          <span className="pin-btn__icon">{rightAction.icon}</span>
        </TooltipButton>
      ) : (
        <TooltipButton
          type="button"
          className={'pin-btn' + (pinned ? ' pin-btn--active' : '')}
          data-testid="pin-btn"
          aria-pressed={pinned}
          aria-label={pinLabel}
          tooltip={pinned ? 'Unpin' : 'Pin'}
          onClick={handleTogglePin}
        >
          <svg
            className="pin-btn__icon"
            viewBox="0 0 24 24"
            width="22"
            height="22"
            fill="currentColor"
            aria-hidden="true"
            focusable="false"
          >
            {/* Material Icons push_pin — Apache 2.0, Google. */}
            {pinned ? (
              <path d="M16 9V4l1 0c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1l1 0v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z" />
            ) : (
              <path d="M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7c-.55 0-1 .45-1 1s.45 1 1 1l1 0v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4l1 0c.55 0 1-.45 1-1s-.45-1-1-1z" />
            )}
          </svg>
        </TooltipButton>
      )}

      {menuItems.length > 0 ? (
        <StoryRowMenu
          open={menuOpen}
          title={title}
          items={menuItems}
          anchorEl={articleRef.current}
          onClose={closeMenu}
        />
      ) : null}
      </article>
    </>
  );
}
