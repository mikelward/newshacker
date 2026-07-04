import type { NavigateFunction } from 'react-router-dom';

/**
 * Leave the thread/reader view the way the browser's Back button would.
 *
 * The ladder, in order:
 * 1. `locationKey !== 'default'` — the router owns a prior in-app entry, so
 *    `navigate(-1)` traverses our own history.
 * 2. Otherwise this is the first router entry (deep link, refresh, shared URL,
 *    or a link tapped from another app). If the browser still has a page behind
 *    us — opened from another site in the same tab — pop back to it.
 * 3. No back entry at all: try to close the tab. This dismisses a script-opened
 *    tab or an Android Custom Tab straight back into the app that opened us
 *    (e.g. Readmo). Browsers that refuse to let a script close a user-opened
 *    tab (notably iOS Safari) leave us here, so we fall back to the app root.
 *
 * `window.navigation?.canGoBack` (Chromium's Navigation API) reports whether a
 * *back* entry exists precisely; `history.length` is the fallback where it's
 * unavailable (Firefox/Safari), even though it also counts forward and
 * pre-existing entries.
 */
export function closeArticleView(
  navigate: NavigateFunction,
  locationKey: string,
): void {
  if (locationKey !== 'default') {
    navigate(-1);
    return;
  }
  const nav = (window as { navigation?: { canGoBack?: boolean } }).navigation;
  const hasBackEntry = nav?.canGoBack ?? window.history.length > 1;
  if (hasBackEntry) {
    navigate(-1);
    return;
  }
  // No back entry: dismiss the tab/Custom Tab back into the opener. A no-op on
  // tabs the browser won't let scripts close, so fall back to the root.
  window.close();
  navigate('/');
}
