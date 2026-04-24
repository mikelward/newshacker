export const THEME_STORAGE_KEY = 'newshacker:theme';
export const THEME_CHANGE_EVENT = 'newshacker:themeChanged';

export type Theme = 'light' | 'dark' | 'system';

const THEMES: readonly Theme[] = ['light', 'dark', 'system'];

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function isTheme(value: unknown): value is Theme {
  return (
    typeof value === 'string' && (THEMES as readonly string[]).includes(value)
  );
}

export function getStoredTheme(): Theme {
  if (!hasWindow()) return 'system';
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

// These have to match the `--nh-bg` values in `global.css`: the browser
// paints `<meta name="theme-color">` above the page, and we want that
// strip to be indistinguishable from the sticky app header.
const META_THEME_COLORS = {
  light: '#f6f6ef',
  dark: '#1b1b17',
} as const;

// Keep the browser's address-bar / OS-chrome tint in sync with the
// resolved theme. The inline boot script in index.html seeds this on
// first paint; this module keeps it current when the user flips the
// drawer toggle or the OS `prefers-color-scheme` changes under a
// `system` selection. Without this, forcing dark-on-light (or vice
// versa) leaves a stale band of the wrong color above the header.
export function applyThemeColorMeta(resolved: 'light' | 'dark'): void {
  if (typeof document === 'undefined') return;
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (meta) meta.content = META_THEME_COLORS[resolved];
}

export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
  applyThemeColorMeta(resolveTheme(theme));
}

export function setStoredTheme(theme: Theme): void {
  if (!hasWindow()) return;
  try {
    if (theme === 'system') {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
  } catch {
    // quota or privacy-mode failures are non-fatal
  }
  applyTheme(theme);
  window.dispatchEvent(
    new CustomEvent(THEME_CHANGE_EVENT, { detail: { theme } }),
  );
}

// Browsers only expose "prefers dark" vs "not dark", so treat anything that
// isn't an explicit dark match as light.
export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  if (!hasWindow() || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}
