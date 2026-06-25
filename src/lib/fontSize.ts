export const FONT_SIZE_STORAGE_KEY = 'newshacker:font-size';
export const FONT_SIZE_CHANGE_EVENT = 'newshacker:fontSizeChanged';

// Reading text size. Drives `--nh-font-size` (the rem anchor on <html>), which
// the reading surfaces — story rows, comments, thread text — size against, so
// the setting scales what you read while the chrome stays put.
//   - `medium`: the shipping default (16px). Maps to "no data-font-size
//     attribute" — the baseline CSS already sets 16px — so storing it is
//     redundant. `setStoredFontSize` clears the key when the user picks it,
//     mirroring how the theme lib handles `system` and chrome handles `mono`.
//   - `small`: 15px. `large`: 17px.
export type FontSize = 'small' | 'medium' | 'large';

const FONT_SIZES: readonly FontSize[] = ['small', 'medium', 'large'];

// User-facing labels for the drawer's Text size picker.
export const FONT_SIZE_LABELS: Record<FontSize, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
};

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function isFontSize(value: unknown): value is FontSize {
  return (
    typeof value === 'string' &&
    (FONT_SIZES as readonly string[]).includes(value)
  );
}

export function getStoredFontSize(): FontSize {
  if (!hasWindow()) return 'medium';
  try {
    const raw = window.localStorage.getItem(FONT_SIZE_STORAGE_KEY);
    return isFontSize(raw) ? raw : 'medium';
  } catch {
    return 'medium';
  }
}

export function applyFontSize(fontSize: FontSize): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (fontSize === 'medium') {
    root.removeAttribute('data-font-size');
  } else {
    root.setAttribute('data-font-size', fontSize);
  }
}

export function setStoredFontSize(fontSize: FontSize): void {
  if (!hasWindow()) return;
  try {
    if (fontSize === 'medium') {
      window.localStorage.removeItem(FONT_SIZE_STORAGE_KEY);
    } else {
      window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, fontSize);
    }
  } catch {
    // quota or privacy-mode failures are non-fatal
  }
  applyFontSize(fontSize);
  window.dispatchEvent(
    new CustomEvent(FONT_SIZE_CHANGE_EVENT, { detail: { fontSize } }),
  );
}
