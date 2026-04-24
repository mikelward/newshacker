export const CHROME_STORAGE_KEY = 'newshacker:chrome-preview';
export const CHROME_CHANGE_EVENT = 'newshacker:chromeChanged';

// The three presets surfaced in the drawer's Theme picker:
//   - `mono`: the shipping default — neutral bar, filled orange disc,
//     neutral wordmark. "One" orange element.
//   - `duo`: neutral bar with an orange disc and an orange wordmark.
//     "Two" orange elements.
//   - `classic`: the pre-mono-a look — solid orange bar with a white
//     wordmark. Kept as an opt-in for anyone who preferred the original.
//
// `mono` maps to "no data-chrome attribute" — the baseline CSS already
// paints the mono look — so storing it is redundant. `setStoredChrome`
// clears the key when the user picks it, mirroring how the theme lib
// handles `system`.
export type Chrome = 'mono' | 'duo' | 'classic';

const CHROMES: readonly Chrome[] = ['mono', 'duo', 'classic'];

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function isChrome(value: unknown): value is Chrome {
  return (
    typeof value === 'string' && (CHROMES as readonly string[]).includes(value)
  );
}

export function getStoredChrome(): Chrome {
  if (!hasWindow()) return 'mono';
  try {
    const raw = window.localStorage.getItem(CHROME_STORAGE_KEY);
    return isChrome(raw) ? raw : 'mono';
  } catch {
    return 'mono';
  }
}

export function applyChrome(chrome: Chrome): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (chrome === 'mono') {
    root.removeAttribute('data-chrome');
  } else {
    root.setAttribute('data-chrome', chrome);
  }
}

export function setStoredChrome(chrome: Chrome): void {
  if (!hasWindow()) return;
  try {
    if (chrome === 'mono') {
      window.localStorage.removeItem(CHROME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(CHROME_STORAGE_KEY, chrome);
    }
  } catch {
    // quota or privacy-mode failures are non-fatal
  }
  applyChrome(chrome);
  window.dispatchEvent(
    new CustomEvent(CHROME_CHANGE_EVENT, { detail: { chrome } }),
  );
}
