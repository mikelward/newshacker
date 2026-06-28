import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { FeedBarProvider } from './FeedBarContext';
import { useFeedBar } from '../hooks/useFeedBar';
import { addHiddenIds, getHiddenIds } from '../lib/hiddenStories';

const wrapper = ({ children }: { children: ReactNode }) => (
  <FeedBarProvider>{children}</FeedBarProvider>
);

describe('FeedBarContext recordHide undo batching', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it('replaces the batch by default (one Undo restores the last call only)', () => {
    addHiddenIds([10, 20]);
    const { result } = renderHook(() => useFeedBar(), { wrapper });
    act(() => result.current.recordHide([10]));
    act(() => result.current.recordHide([20])); // keyless → new batch
    act(() => result.current.undo());
    expect(getHiddenIds()).toEqual(new Set([10])); // only 20 restored
  });

  it('accumulates same-key hides so one Undo restores the whole burst', () => {
    addHiddenIds([10, 20, 30]);
    const { result } = renderHook(() => useFeedBar(), { wrapper });
    act(() => result.current.recordHide([10], { batchKey: 1 }));
    act(() => result.current.recordHide([20], { batchKey: 1 }));
    act(() => result.current.undo());
    expect(getHiddenIds()).toEqual(new Set([30])); // 10 and 20 both restored
  });

  it('does not bundle a keyless hide between two same-key hides', () => {
    addHiddenIds([10, 20, 30]);
    const { result } = renderHook(() => useFeedBar(), { wrapper });
    act(() => result.current.recordHide([10], { batchKey: 1 })); // scroll hide
    act(() => result.current.recordHide([20])); // manual swipe/Sweep (keyless)
    act(() => result.current.recordHide([30], { batchKey: 1 })); // later scroll hide
    act(() => result.current.undo());
    // The later same-key hide must start a fresh batch, not re-extend the manual
    // one, so Undo restores only 30.
    expect(getHiddenIds()).toEqual(new Set([10, 20]));
  });

  it('fires the registered onUndo handler with the restored ids (in order)', () => {
    addHiddenIds([10, 20, 30]);
    const { result } = renderHook(() => useFeedBar(), { wrapper });
    const restored: number[][] = [];
    act(() => result.current.setOnUndo((ids) => restored.push([...ids])));
    act(() => result.current.recordHide([10, 20], { batchKey: 1 }));
    act(() => result.current.recordHide([30], { batchKey: 1 })); // same burst
    act(() => result.current.undo());
    expect(restored).toEqual([[10, 20, 30]]);
  });

  it('does not fire onUndo when there is nothing to undo', () => {
    const { result } = renderHook(() => useFeedBar(), { wrapper });
    let calls = 0;
    act(() => result.current.setOnUndo(() => calls++));
    act(() => result.current.undo()); // empty batch — no-op
    expect(calls).toBe(0);
  });

  it('stops firing onUndo once the handler is cleared', () => {
    addHiddenIds([10]);
    const { result } = renderHook(() => useFeedBar(), { wrapper });
    let calls = 0;
    act(() => result.current.setOnUndo(() => calls++));
    act(() => result.current.setOnUndo(null));
    act(() => result.current.recordHide([10]));
    act(() => result.current.undo());
    expect(calls).toBe(0);
  });
});
