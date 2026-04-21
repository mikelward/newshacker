import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWarmQueue } from './useWarmQueue';

describe('useWarmQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeFetch() {
    return vi.fn<typeof fetch>(
      async () => new Response('{}', { status: 200 }),
    );
  }

  it('batches ids enqueued within the debounce window into one POST', () => {
    const fetchImpl = makeFetch();
    const { result } = renderHook(() =>
      useWarmQueue({ fetchImpl, debounceMs: 100 }),
    );
    act(() => {
      result.current.enqueue(1);
      result.current.enqueue(2);
      result.current.enqueue(3);
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('/api/warm-summaries');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string) as { ids: number[] };
    expect(body.ids.sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('uses keepalive so the POST can outlive a tab hide', () => {
    const fetchImpl = makeFetch();
    const { result } = renderHook(() =>
      useWarmQueue({ fetchImpl, debounceMs: 50 }),
    );
    act(() => {
      result.current.enqueue(1);
    });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.keepalive).toBe(true);
  });

  it('does not enqueue an id that has already been sent in this session', () => {
    const fetchImpl = makeFetch();
    const { result } = renderHook(() =>
      useWarmQueue({ fetchImpl, debounceMs: 50 }),
    );
    act(() => {
      result.current.enqueue(42);
    });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    act(() => {
      result.current.enqueue(42);
    });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('dedupes ids within the pending batch', () => {
    const fetchImpl = makeFetch();
    const { result } = renderHook(() =>
      useWarmQueue({ fetchImpl, debounceMs: 50 }),
    );
    act(() => {
      result.current.enqueue(1);
      result.current.enqueue(1);
      result.current.enqueue(1);
    });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      fetchImpl.mock.calls[0]![1]!.body as string,
    ) as { ids: number[] };
    expect(body.ids).toEqual([1]);
  });

  it('flushes immediately when the batch cap is reached', () => {
    const fetchImpl = makeFetch();
    const { result } = renderHook(() =>
      useWarmQueue({ fetchImpl, debounceMs: 10_000, batchCap: 3 }),
    );
    act(() => {
      result.current.enqueue(1);
      result.current.enqueue(2);
      result.current.enqueue(3);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      fetchImpl.mock.calls[0]![1]!.body as string,
    ) as { ids: number[] };
    expect(body.ids.sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('ignores invalid ids (non-integer, negative, zero)', () => {
    const fetchImpl = makeFetch();
    const { result } = renderHook(() =>
      useWarmQueue({ fetchImpl, debounceMs: 50 }),
    );
    act(() => {
      result.current.enqueue(0);
      result.current.enqueue(-1);
      result.current.enqueue(1.5);
    });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('flush() sends pending ids immediately', () => {
    const fetchImpl = makeFetch();
    const { result } = renderHook(() =>
      useWarmQueue({ fetchImpl, debounceMs: 1_000 }),
    );
    act(() => {
      result.current.enqueue(7);
      result.current.enqueue(8);
      result.current.flush();
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('swallows fetch rejection without raising (fire-and-forget)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('offline');
    });
    const { result } = renderHook(() =>
      useWarmQueue({ fetchImpl, debounceMs: 10 }),
    );
    act(() => {
      result.current.enqueue(1);
    });
    await act(async () => {
      vi.advanceTimersByTime(10);
      // Let the microtask settle.
      await Promise.resolve();
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('flushes any pending ids on unmount', () => {
    const fetchImpl = makeFetch();
    const { result, unmount } = renderHook(() =>
      useWarmQueue({ fetchImpl, debounceMs: 10_000 }),
    );
    act(() => {
      result.current.enqueue(1);
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    unmount();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
