import { useEffect } from 'react';

// Document-level keyboard handler for the thread / comments page.
// Mirrors useListKeyboardNav's bail-outs (focused input, modifier
// keys, open dialog/menu), so the same "no surprise hijack" rules
// apply.
//
// j / ↓ and k / ↑ scroll between rendered comments in the thread.
// Comments aren't focusable like list rows are — the "active" comment
// is just whichever one is currently nearest the top of the viewport.
// Each press scrolls the next/prev comment up to just below the sticky
// header. At the top of the thread, k scrolls all the way to the
// header; at the bottom, j is a no-op.
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
    document.querySelectorAll<HTMLElement>(
      '.thread__comments .comment:not(.comment--loading)',
    ),
  );
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
  // A small tolerance below the sticky header — anything whose top has
  // crossed the header is "behind us". 8px absorbs the resting offset
  // applied by scrollToComment so a freshly-jumped-to comment doesn't
  // immediately count as "previous".
  const triggerLine = getHeaderOffset() + 8;

  let currentIdx = -1;
  for (let i = 0; i < comments.length; i++) {
    if (comments[i].getBoundingClientRect().top <= triggerLine) {
      currentIdx = i;
    } else {
      break;
    }
  }

  if (direction === 'next') {
    const targetIdx = currentIdx + 1;
    if (targetIdx >= comments.length) return false;
    scrollToComment(comments[targetIdx]);
    return true;
  }
  if (currentIdx <= 0) {
    if (window.scrollY === 0) return false;
    window.scrollTo({ top: 0, behavior: 'auto' });
    return true;
  }
  scrollToComment(comments[currentIdx - 1]);
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
    return () => document.removeEventListener('keydown', onKey);
  }, [onOpenArticle, onTogglePin, onToggleDone]);
}
