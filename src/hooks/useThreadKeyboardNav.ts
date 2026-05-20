import { useEffect } from 'react';

// Document-level keyboard handler for the thread / comments page.
// Mirrors useListKeyboardNav's bail-outs (focused input, modifier
// keys, open dialog/menu), so the same "no surprise hijack" rules
// apply.
//
// j / ↓ and k / ↑ scroll one visible comment at a time. The cursor
// matches every rendered `.comment` — `<Comment>` only mounts its
// `comment__children` subtree when its parent is expanded, so a
// fresh load that has nothing expanded only has the top-level cards
// in the DOM and j walks them one per press; expanding a card adds
// its replies and j now visits each one in turn before continuing
// to the next top-level. "Active" comment = whichever rendered card
// is currently nearest the top of the viewport, recomputed each
// press so manual scrolling and keyboard scrolling compose without
// a parallel selection state.
//
// After each successful j/k/Enter we tag the active card with
// `.is-keyboard-focused` so the reader can see which one Enter
// will toggle. The class is a pure visual marker — the active-
// comment computation still runs against the viewport on the next
// press, so mouse scrolling can temporarily leave the indicator
// out of sync, and the next j/k realigns it. Cleared on unmount.
//
// Enter toggles the active comment's expand/collapse so the reader
// can fan out a thread's replies without leaving the keyboard. We
// bail when focus is on a button or link, so Enter's native click
// activation still wins on the action bar.
//
// o / p / d call out to the thread's own handlers (open article in a
// new tab, toggle pin, toggle done), matching the per-row shortcuts
// on the feed pages. The args are optional so the focused-comment
// view — which has no per-thread action bar — can leave them off and
// only get the scroll keys.

interface Args {
  onOpenArticle?: () => void;
  onTogglePin?: () => void;
  onToggleDone?: () => void;
}

// Every rendered comment in the thread, top-level or nested.
// `<Comment>` only mounts its `.comment__children` subtree when its
// parent is expanded, so this selector naturally excludes hidden
// replies — "rendered" already means "visible". The loading-card
// variant (the placeholder while a comment item is being fetched)
// and the height-reserving `.comment--placeholder` (the not-yet-loaded
// top-level rows below the sentinel) are excluded so j doesn't park on
// something the reader can't read.
const VISIBLE_COMMENT_SELECTOR =
  '.thread__comments .comment:not(.comment--loading):not(.comment--placeholder)';

// Marker attribute set by the keyboard handler on the active card.
// A data attribute (rather than a className) is deliberate: <Comment>
// re-renders on expand/collapse and React would overwrite an
// imperatively-added class on the next reconcile. React doesn't
// reconcile attributes it didn't render itself, so this survives.
const KEYBOARD_FOCUS_ATTR = 'data-keyboard-focused';

// Move the visual focus marker. Strips the attribute from any element
// currently carrying it inside the thread (defensive — there should
// only ever be one), then adds it to `el` if non-null. Passing null
// clears the indicator (e.g. k from the top of the thread, or hook
// teardown on route change).
function markKeyboardFocused(el: HTMLElement | null): void {
  const previous = document.querySelectorAll<HTMLElement>(
    `.thread__comments [${KEYBOARD_FOCUS_ATTR}]`,
  );
  previous.forEach((p) => p.removeAttribute(KEYBOARD_FOCUS_ATTR));
  if (el) el.setAttribute(KEYBOARD_FOCUS_ATTR, '');
}

function shouldIgnoreKeyEvent(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return true;
  if (e.metaKey || e.ctrlKey || e.altKey) return true;
  const target = e.target as HTMLElement | null;
  if (!target) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

function isAnyModalOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="menu"]') !== null;
}

function getHeaderOffset(): number {
  const h = document.querySelector<HTMLElement>('.app-header');
  if (!h) return 0;
  return h.getBoundingClientRect().height;
}

function getComments(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(VISIBLE_COMMENT_SELECTOR),
  );
}

function findActiveCommentIndex(comments: HTMLElement[]): number {
  const triggerLine = getHeaderOffset() + 8;
  let idx = -1;
  for (let i = 0; i < comments.length; i++) {
    if (comments[i].getBoundingClientRect().top <= triggerLine) {
      idx = i;
    } else {
      break;
    }
  }
  return idx;
}

function toggleActiveComment(): boolean {
  const comments = getComments();
  if (comments.length === 0) return false;
  // If no comment has crossed the trigger line yet (reader is still
  // up in the story header), Enter acts on the first one — the most
  // natural "the comment I'm about to read" interpretation.
  const idx = Math.max(0, findActiveCommentIndex(comments));
  const active = comments[idx];
  // :scope keeps us on THIS comment's footer toggle rather than
  // descending into nested replies' toggles.
  const toggle = active.querySelector<HTMLButtonElement>(
    ':scope > .comment__footer > .comment__toggle',
  );
  if (!toggle) return false;
  markKeyboardFocused(active);
  toggle.click();
  return true;
}

function scrollToComment(el: HTMLElement): void {
  const headerOffset = getHeaderOffset();
  const targetTop =
    el.getBoundingClientRect().top + window.scrollY - headerOffset - 4;
  window.scrollTo({ top: Math.max(0, targetTop), behavior: 'auto' });
}

function jumpComment(direction: 'next' | 'prev'): boolean {
  const comments = getComments();
  if (comments.length === 0) return false;
  // The 8px tolerance inside findActiveCommentIndex absorbs the
  // resting offset applied by scrollToComment so a freshly-jumped-to
  // comment doesn't immediately count as "previous".
  const currentIdx = findActiveCommentIndex(comments);

  if (direction === 'next') {
    const targetIdx = currentIdx + 1;
    if (targetIdx >= comments.length) return false;
    scrollToComment(comments[targetIdx]);
    markKeyboardFocused(comments[targetIdx]);
    return true;
  }
  if (currentIdx <= 0) {
    if (window.scrollY === 0) return false;
    window.scrollTo({ top: 0, behavior: 'auto' });
    markKeyboardFocused(null);
    return true;
  }
  scrollToComment(comments[currentIdx - 1]);
  markKeyboardFocused(comments[currentIdx - 1]);
  return true;
}

export function useThreadKeyboardNav({
  onOpenArticle,
  onTogglePin,
  onToggleDone,
}: Args): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreKeyEvent(e)) return;
      if (isAnyModalOpen()) return;
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          if (jumpComment('next')) e.preventDefault();
          break;
        case 'k':
        case 'ArrowUp':
          if (jumpComment('prev')) e.preventDefault();
          break;
        case 'Enter': {
          // Let native activation win when focus is on an interactive
          // element (action-bar button, story-title link, etc.) so
          // Enter still clicks them — we only handle the "no
          // interactive focus" case where Enter would otherwise be a
          // no-op.
          const target = e.target as HTMLElement | null;
          const tag = target?.tagName;
          if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') break;
          if (toggleActiveComment()) e.preventDefault();
          break;
        }
        case 'o':
          if (onOpenArticle) {
            e.preventDefault();
            onOpenArticle();
          }
          break;
        case 'p':
          if (onTogglePin) {
            e.preventDefault();
            onTogglePin();
          }
          break;
        case 'd':
          if (onToggleDone) {
            e.preventDefault();
            onToggleDone();
          }
          break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      markKeyboardFocused(null);
    };
  }, [onOpenArticle, onTogglePin, onToggleDone]);
}
