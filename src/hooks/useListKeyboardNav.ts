import { useEffect } from 'react';

// Document-level keyboard handler for list pages. Moves focus between
// rows with j/k and ArrowDown/ArrowUp. Enter is handled by the native
// <Link> on the focused row body; per-row Space/o/p/d live on the row
// itself (StoryListItem.handleRowKeyDown); `?` lives on the global
// KeyboardShortcutsOverlay. The active row is "whichever row body has
// DOM focus" — no separate selected-index state.

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
  // StoryRowMenu (role="menu" popover, role="dialog" sheet), LoginDialog
  // (role="dialog"), AppDrawer (role="dialog"), HeaderAccountMenu
  // (role="menu"), the shortcuts overlay (role="dialog") — all match.
  return document.querySelector('[role="dialog"], [role="menu"]') !== null;
}

function focusRow(direction: 'next' | 'prev'): boolean {
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>('.story-row__body'),
  );
  if (rows.length === 0) return false;
  const active = document.activeElement;
  const idx =
    active instanceof HTMLElement ? rows.indexOf(active) : -1;
  let target: number;
  if (idx < 0) {
    // Nothing focused yet — first j/k/arrow press lands on the first
    // visible row regardless of direction. Matches the "defer until
    // first keypress" rule from SPEC.md.
    target = 0;
  } else if (direction === 'next') {
    target = Math.min(idx + 1, rows.length - 1);
  } else {
    target = Math.max(0, idx - 1);
  }
  const el = rows[target];
  if (!el) return false;
  el.focus();
  el.scrollIntoView({ block: 'nearest' });
  return true;
}

export function useListKeyboardNav(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreKeyEvent(e)) return;
      if (isAnyModalOpen()) return;
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          if (focusRow('next')) e.preventDefault();
          break;
        case 'k':
        case 'ArrowUp':
          if (focusRow('prev')) e.preventDefault();
          break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}
