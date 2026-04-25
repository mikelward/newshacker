import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useHotThresholds } from './useHotThresholds';
import {
  DEFAULT_HOT_THRESHOLDS,
  HOT_THRESHOLDS_CHANGE_EVENT,
  HOT_THRESHOLDS_STORAGE_KEY,
  setStoredHotThresholds,
} from '../lib/hotThresholds';

describe('useHotThresholds', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns DEFAULT_HOT_THRESHOLDS on a pristine device', () => {
    const { result } = renderHook(() => useHotThresholds());
    expect(result.current.prefs).toEqual(DEFAULT_HOT_THRESHOLDS);
  });

  it('reflects prefs written before mount', () => {
    setStoredHotThresholds(
      { ...DEFAULT_HOT_THRESHOLDS, topEnabled: false },
      1,
    );
    const { result } = renderHook(() => useHotThresholds());
    expect(result.current.prefs.topEnabled).toBe(false);
  });

  it('updates when the change event fires from elsewhere', () => {
    const { result } = renderHook(() => useHotThresholds());
    act(() => {
      setStoredHotThresholds(
        { ...DEFAULT_HOT_THRESHOLDS, newVelocityMin: 25 },
        1,
      );
    });
    expect(result.current.prefs.newVelocityMin).toBe(25);
  });

  it('save() persists and re-reads', () => {
    const { result } = renderHook(() => useHotThresholds());
    act(() => {
      result.current.save({ ...DEFAULT_HOT_THRESHOLDS, topScoreMin: 150 });
    });
    expect(result.current.prefs.topScoreMin).toBe(150);
  });

  it('re-reads on a cross-tab storage event for the hot-thresholds key', () => {
    const { result } = renderHook(() => useHotThresholds());
    window.localStorage.setItem(
      HOT_THRESHOLDS_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_HOT_THRESHOLDS,
        topDescendantsMin: 50,
        at: 1,
      }),
    );
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: HOT_THRESHOLDS_STORAGE_KEY }),
      );
    });
    expect(result.current.prefs.topDescendantsMin).toBe(50);
  });

  it('re-reads on a cross-tab storage clear (event.key === null)', () => {
    setStoredHotThresholds(
      { ...DEFAULT_HOT_THRESHOLDS, topEnabled: false },
      1,
    );
    const { result } = renderHook(() => useHotThresholds());
    expect(result.current.prefs.topEnabled).toBe(false);
    window.localStorage.clear();
    act(() => {
      // `localStorage.clear()` from another tab fires `storage` with
      // `key: null`. We treat that as "re-read everything".
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(result.current.prefs).toEqual(DEFAULT_HOT_THRESHOLDS);
  });

  it('ignores cross-tab storage events for unrelated keys', () => {
    const { result } = renderHook(() => useHotThresholds());
    // Another tab writes a different localStorage key (e.g. pinned).
    // Without the key filter the listener would needlessly re-read
    // and trigger a re-render.
    window.localStorage.setItem(
      HOT_THRESHOLDS_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_HOT_THRESHOLDS,
        topDescendantsMin: 50,
        at: 1,
      }),
    );
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'newshacker:pinnedStoryIds' }),
      );
    });
    // Hook still reports defaults — the unrelated `storage` event
    // didn't trigger a re-read, even though the underlying key now
    // has a fresh value.
    expect(result.current.prefs.topDescendantsMin).toBe(
      DEFAULT_HOT_THRESHOLDS.topDescendantsMin,
    );
  });

  it('cleans up listeners on unmount (no throw on later events)', () => {
    const { unmount } = renderHook(() => useHotThresholds());
    unmount();
    window.dispatchEvent(new CustomEvent(HOT_THRESHOLDS_CHANGE_EVENT));
  });
});
