// One-shot dismissal flag for the home promo card pointing readers at
// `/hot` (see `<HomePromoCard>` and SPEC.md *Story feeds → /hot*). The
// card renders only on `/` when the home feed is `top` and only until
// the reader taps its dismiss button — there is no un-dismiss path.
// Storage is a single string value: exactly `'1'` ⇒ dismissed,
// anything else (missing key, empty string, future-other-value) ⇒
// not dismissed. Cross-tab sync would just hide a card the other tab
// is already rendering, so no change event.
export const HOME_PROMO_DISMISSED_STORAGE_KEY =
  'newshacker:homePromoHotDismissed';

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

export function isHomePromoDismissed(): boolean {
  if (!hasWindow()) return false;
  try {
    return (
      window.localStorage.getItem(HOME_PROMO_DISMISSED_STORAGE_KEY) === '1'
    );
  } catch {
    return false;
  }
}

export function dismissHomePromo(): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(HOME_PROMO_DISMISSED_STORAGE_KEY, '1');
  } catch {
    // quota / privacy mode — non-fatal; the card just stays mounted
    // for this tab until React state hides it.
  }
}
