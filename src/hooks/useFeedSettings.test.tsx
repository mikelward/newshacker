import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useHideOnScroll, useStickyBottomBar } from './useFeedSettings';
import {
  HIDE_ON_SCROLL_STORAGE_KEY,
  STICKY_BOTTOM_BAR_STORAGE_KEY,
} from '../lib/feedSettings';

describe('useFeedSettings', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  describe('useHideOnScroll', () => {
    it('defaults to off', () => {
      const { result } = renderHook(() => useHideOnScroll());
      expect(result.current.hideOnScroll).toBe(false);
    });

    it('reads a persisted flag on mount', () => {
      window.localStorage.setItem(HIDE_ON_SCROLL_STORAGE_KEY, '1');
      const { result } = renderHook(() => useHideOnScroll());
      expect(result.current.hideOnScroll).toBe(true);
    });

    it('persists a toggle and clears the key when turned off', () => {
      const { result } = renderHook(() => useHideOnScroll());
      act(() => result.current.setHideOnScroll(true));
      expect(result.current.hideOnScroll).toBe(true);
      expect(window.localStorage.getItem(HIDE_ON_SCROLL_STORAGE_KEY)).toBe('1');

      act(() => result.current.setHideOnScroll(false));
      expect(result.current.hideOnScroll).toBe(false);
      expect(window.localStorage.getItem(HIDE_ON_SCROLL_STORAGE_KEY)).toBeNull();
    });

    it('syncs across separate consumers via the change event', () => {
      const a = renderHook(() => useHideOnScroll());
      const b = renderHook(() => useHideOnScroll());
      act(() => a.result.current.setHideOnScroll(true));
      expect(a.result.current.hideOnScroll).toBe(true);
      expect(b.result.current.hideOnScroll).toBe(true);
    });
  });

  describe('useStickyBottomBar', () => {
    it('defaults to off and is independent of hideOnScroll', () => {
      const { result } = renderHook(() => ({
        bar: useStickyBottomBar(),
        hide: useHideOnScroll(),
      }));
      expect(result.current.bar.stickyBottomBar).toBe(false);

      act(() => result.current.bar.setStickyBottomBar(true));
      expect(result.current.bar.stickyBottomBar).toBe(true);
      expect(result.current.hide.hideOnScroll).toBe(false);
      expect(window.localStorage.getItem(STICKY_BOTTOM_BAR_STORAGE_KEY)).toBe(
        '1',
      );
      expect(
        window.localStorage.getItem(HIDE_ON_SCROLL_STORAGE_KEY),
      ).toBeNull();
    });
  });
});
