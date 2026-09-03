import { createPersistentValue } from './persistentValue';

export const FONT_SIZE_STORAGE_KEY = 'newshacker:font-size';
export const FONT_SIZE_CHANGE_EVENT = 'newshacker:fontSizeChanged';

// Reading text size, in px. Drives `--nh-font-size` (the rem anchor on <html>),
// which the reading surfaces — story rows, comments, thread text — size against,
// so the setting scales what you read while the chrome stays put.
//
// The scale used to be three named steps (small 15 / medium 16 / large 17),
// which spanned 1.06× and was not a large-text mode at all. It now runs to 32px
// — 2× the default, the magnification WCAG 1.4.4 asks for — and the values are
// their own labels, because a relative name has to be re-coined every time the
// ladder grows and "Large" had already stopped meaning large.
//
// Steps widen past 20px: below it a reader is still nudging and 1px is worth
// having, above it another 1px is a 5% change nobody can see.
export type FontSize =
  | '14'
  | '15'
  | '16'
  | '17'
  | '18'
  | '19'
  | '20'
  | '22'
  | '24'
  | '26'
  | '28'
  | '30'
  | '32';

export const FONT_SIZES: readonly FontSize[] = [
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  '20',
  '22',
  '24',
  '26',
  '28',
  '30',
  '32',
];

// 16px is the default, so it owns the bare `:root` block, needs no
// `data-font-size` attribute, and clears the storage key when chosen — the same
// default-owns-the-baseline pattern as `system` theme and `mono` chrome.
export const DEFAULT_FONT_SIZE: FontSize = '16';

// The px value is the label. `FONT_SIZE_LABELS` stays as the one place that
// decides how a rung is written, so the stepper and any future surface agree.
export const FONT_SIZE_LABELS: Record<FontSize, string> = Object.fromEntries(
  FONT_SIZES.map((size) => [size, `${size}px`]),
) as Record<FontSize, string>;

// What the three named steps this scale replaced were actually worth, so
// somebody who set one keeps the size they chose rather than being reset to the
// default. Kept indefinitely: the key is only rewritten when the user picks a
// new size, so a reader who never touches the setting again would otherwise
// lose it at any point in the future.
const LEGACY_NAMES: Record<string, FontSize> = {
  small: '15',
  medium: '16',
  large: '17',
};

function isFontSize(value: unknown): value is FontSize {
  return (
    typeof value === 'string' &&
    (FONT_SIZES as readonly string[]).includes(value)
  );
}

/**
 * The rung closest to a px value that isn't one.
 *
 * Falling back to the default instead would read as the app forgetting a
 * choice, and — since the ladder only ever grows upward — would make the text
 * *smaller* at the moment it grew. Ties round up (17 lands on 18, not 16):
 * someone who chose a size above the default was asking for bigger, so the
 * ambiguous case keeps going that way.
 */
function nearestFontSize(raw: string): FontSize | undefined {
  const px = Number(raw);
  if (!Number.isFinite(px)) return undefined;
  let best: FontSize | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const size of FONT_SIZES) {
    const distance = Math.abs(Number(size) - px);
    // `<=` rather than `<`, walking an ascending ladder, is what rounds a tie up.
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = size;
    }
  }
  return best;
}

export function parseFontSize(raw: string): FontSize | undefined {
  if (isFontSize(raw)) return raw;
  return LEGACY_NAMES[raw] ?? nearestFontSize(raw);
}

export function applyFontSize(fontSize: FontSize): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (fontSize === DEFAULT_FONT_SIZE) {
    root.removeAttribute('data-font-size');
  } else {
    root.setAttribute('data-font-size', fontSize);
  }
}

export const fontSizeStore = createPersistentValue<FontSize>({
  storageKey: FONT_SIZE_STORAGE_KEY,
  changeEvent: FONT_SIZE_CHANGE_EVENT,
  defaultValue: DEFAULT_FONT_SIZE,
  parse: parseFontSize,
  onApply: applyFontSize,
  detailKey: 'fontSize',
});

export const getStoredFontSize = fontSizeStore.get;
export const setStoredFontSize = fontSizeStore.set;
