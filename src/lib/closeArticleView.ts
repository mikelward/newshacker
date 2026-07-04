import type { NavigateFunction } from 'react-router-dom';

/**
 * Leave the thread/reader view the way the browser's Back button would:
 * go back if the browser has somewhere to go, else close the tab, else root.
 *
 * We key off `window.history.length` rather than the router's `location.key` or
 * the Navigation API's `canGoBack`, because both misreport the cases that
 * matter here:
 * - `location.key` is a generated (non-`'default'`) value after a `replace`
 *   navigation (e.g. a sign-in redirect that swaps a route back to the target),
 *   even when that entry is the only one in session history — so it can't tell
 *   "has a real back entry" from "was replaced into place".
 * - `navigation.canGoBack` only sees **same-origin** entries (cross-origin
 *   history is hidden from script for privacy), so it is `false` for exactly the
 *   external-return flow (opened from Readmo in the same tab) this exists for.
 *
 * `history.length` counts the real session-history entries, cross-origin
 * included, and stays 1 through `replace`. Its one blind spot is that it also
 * counts *forward* entries, so a cold deep link → in-app link → browser Back
 * leaves `length > 1` with no back entry, and `navigate(-1)` is a no-op there —
 * rare and low-impact.
 */
export function closeArticleView(navigate: NavigateFunction): void {
  if (window.history.length > 1) {
    navigate(-1);
    return;
  }
  // No other entry at all (cold/fresh tab): dismiss the tab/Custom Tab back into
  // the opener, falling back to the root if the browser won't close it.
  window.close();
  navigate('/');
}
