export const CHROME_STORAGE_KEY = 'newshacker:chrome-preview';
export const CHROME_CHANGE_EVENT = 'newshacker:chromeChanged';

export type Chrome = 'default' | 'mono-a' | 'mono-b';

const CHROMES: readonly Chrome[] = ['default', 'mono-a', 'mono-b'];

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function isChrome(value: unknown): value is Chrome {
  return (
    typeof value === 'string' && (CHROMES as readonly string[]).includes(value)
  );
}

export function getStoredChrome(): Chrome {
  if (!hasWindow()) return 'default';
  try {
    const raw = window.localStorage.getItem(CHROME_STORAGE_KEY);
    return isChrome(raw) ? raw : 'default';
  } catch {
    return 'default';
  }
}

export function applyChrome(chrome: Chrome): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (chrome === 'default') {
    root.removeAttribute('data-chrome');
  } else {
    root.setAttribute('data-chrome', chrome);
  }
}

export function setStoredChrome(chrome: Chrome): void {
  if (!hasWindow()) return;
  try {
    if (chrome === 'default') {
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
