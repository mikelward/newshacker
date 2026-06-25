// Per-device feed-behavior settings (drawer toggles), persisted in
// localStorage and broadcast via a custom event for cross-tab + same-tab sync.
// Mirrors the theme/chrome pattern (getStored*/setStored* + change event).
//
//  - hideOnScroll (default off): auto-dismiss an unpinned story the moment it
//    scrolls off the top of the viewport (an automatic Sweep — see StoryList).
//  - stickyBottomBar (default off): pin the bottom action bar (Back to top /
//    More / Undo / Sweep) to the foot of the viewport instead of letting it sit
//    at the end of the list in normal flow.

export const HIDE_ON_SCROLL_STORAGE_KEY = 'newshacker:hideOnScroll';
export const HIDE_ON_SCROLL_CHANGE_EVENT = 'newshacker:hideOnScrollChanged';

export const STICKY_BOTTOM_BAR_STORAGE_KEY = 'newshacker:stickyBottomBar';
export const STICKY_BOTTOM_BAR_CHANGE_EVENT =
  'newshacker:stickyBottomBarChanged';

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function readFlag(key: string): boolean {
  if (!hasWindow()) return false;
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, event: string, enabled: boolean): void {
  if (!hasWindow()) return;
  try {
    if (enabled) window.localStorage.setItem(key, '1');
    else window.localStorage.removeItem(key);
  } catch {
    // quota / privacy-mode failures are non-fatal — the toggle just reverts
  }
  window.dispatchEvent(new CustomEvent(event, { detail: { enabled } }));
}

export function getStoredHideOnScroll(): boolean {
  return readFlag(HIDE_ON_SCROLL_STORAGE_KEY);
}

export function setStoredHideOnScroll(enabled: boolean): void {
  writeFlag(HIDE_ON_SCROLL_STORAGE_KEY, HIDE_ON_SCROLL_CHANGE_EVENT, enabled);
}

export function getStoredStickyBottomBar(): boolean {
  return readFlag(STICKY_BOTTOM_BAR_STORAGE_KEY);
}

export function setStoredStickyBottomBar(enabled: boolean): void {
  writeFlag(
    STICKY_BOTTOM_BAR_STORAGE_KEY,
    STICKY_BOTTOM_BAR_CHANGE_EVENT,
    enabled,
  );
}
