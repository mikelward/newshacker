import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTheme } from './useTheme';
import { THEME_STORAGE_KEY } from '../lib/theme';

// Helper: mock `window.matchMedia` so the hook's system-flip effect can
// subscribe. `fire` flips the mock's reported match state and dispatches
// a synthetic change event to every listener the hook has attached.
function mockMatchMedia(initialMatches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  let matches = initialMatches;
  const spy = vi
    .spyOn(window, 'matchMedia')
    .mockImplementation(
      (query: string) =>
        ({
          get matches() {
            return matches;
          },
          media: query,
          addEventListener: (
            _type: string,
            listener: (event: MediaQueryListEvent) => void,
          ) => listeners.add(listener),
          removeEventListener: (
            _type: string,
            listener: (event: MediaQueryListEvent) => void,
          ) => listeners.delete(listener),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
          onchange: null,
        }) as unknown as MediaQueryList,
    );
  function fire(nextMatches: boolean) {
    matches = nextMatches;
    const event = {
      matches: nextMatches,
      media: '(prefers-color-scheme: dark)',
    } as MediaQueryListEvent;
    for (const listener of listeners) listener(event);
  }
  return { spy, fire };
}

function installMetaThemeColor(initial = ''): HTMLMetaElement {
  const existing = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (existing) existing.remove();
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = initial;
  document.head.appendChild(meta);
  return meta;
}

describe('useTheme', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.remove();
    vi.restoreAllMocks();
  });

  it('returns the stored theme and persists changes', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('system');

    act(() => result.current.setTheme('dark'));
    expect(result.current.theme).toBe('dark');
    expect(result.current.resolved).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    act(() => result.current.setTheme('system'));
    expect(result.current.theme).toBe('system');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('syncs across hook instances via the change event', () => {
    const a = renderHook(() => useTheme());
    const b = renderHook(() => useTheme());

    act(() => a.result.current.setTheme('light'));
    expect(b.result.current.theme).toBe('light');
    expect(b.result.current.resolved).toBe('light');
  });

  // The inline boot script seeds <meta theme-color> before React mounts,
  // and `applyTheme` keeps it current on explicit Mode changes. The
  // remaining gap is: when the user is on `system` and the OS flips,
  // the hook has to pick up the change via matchMedia and also update
  // the meta so the browser chrome tint doesn't lag the page.
  it('updates <meta theme-color> when the OS flips under a system selection', () => {
    const { fire } = mockMatchMedia(false);
    const meta = installMetaThemeColor('#f6f6ef');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('system');
    expect(result.current.resolved).toBe('light');

    act(() => fire(true));
    expect(result.current.resolved).toBe('dark');
    expect(meta.content).toBe('#1b1b17');

    act(() => fire(false));
    expect(result.current.resolved).toBe('light');
    expect(meta.content).toBe('#f6f6ef');
  });
});
