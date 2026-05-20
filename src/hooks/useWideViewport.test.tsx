import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWideViewport } from './useWideViewport';

type Listener = () => void;

function stubMatchMedia(initialMatches: boolean) {
  const listeners = new Set<Listener>();
  let matches = initialMatches;
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes('min-width: 960px') ? matches : false;
    },
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_: string, cb: Listener) => listeners.add(cb),
    removeEventListener: (_: string, cb: Listener) => listeners.delete(cb),
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return {
    setMatches(value: boolean) {
      matches = value;
      listeners.forEach((cb) => cb());
    },
    restore() {
      window.matchMedia = original;
    },
  };
}

describe('useWideViewport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when the viewport is at least 960px wide', () => {
    const mql = stubMatchMedia(true);
    try {
      const { result } = renderHook(() => useWideViewport());
      expect(result.current).toBe(true);
    } finally {
      mql.restore();
    }
  });

  it('returns false on narrow viewports', () => {
    const mql = stubMatchMedia(false);
    try {
      const { result } = renderHook(() => useWideViewport());
      expect(result.current).toBe(false);
    } finally {
      mql.restore();
    }
  });

  it('reacts to viewport changes', () => {
    const mql = stubMatchMedia(false);
    try {
      const { result } = renderHook(() => useWideViewport());
      expect(result.current).toBe(false);
      act(() => mql.setMatches(true));
      expect(result.current).toBe(true);
    } finally {
      mql.restore();
    }
  });
});
