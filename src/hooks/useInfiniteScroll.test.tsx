import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useInfiniteScroll } from './useInfiniteScroll';

interface MockEntry {
  isIntersecting: boolean;
  boundingClientRect?: { bottom: number };
}
type MockCallback = (entries: MockEntry[]) => void;

interface MockObserverState {
  callback: MockCallback;
  observed: Element[];
  disconnected: boolean;
}

let lastObserver: MockObserverState | null = null;

function makeMockIO() {
  return function MockIO(cb: MockCallback) {
    const state: MockObserverState = {
      callback: cb,
      observed: [],
      disconnected: false,
    };
    lastObserver = state;
    return {
      observe: (el: Element) => {
        state.observed.push(el);
      },
      disconnect: () => {
        state.disconnected = true;
      },
      unobserve: (el: Element) => {
        const i = state.observed.indexOf(el);
        if (i >= 0) state.observed.splice(i, 1);
      },
      takeRecords: () => [] as MockEntry[],
    };
  };
}

// A reader who has scrolled past the 1px sentinel: its bottom edge is at
// or above the real viewport top.
const SCROLLED_PAST: MockEntry = {
  isIntersecting: false,
  boundingClientRect: { bottom: -10 },
};

function rect(top: number): DOMRect {
  return {
    top,
    bottom: top + 1,
    left: 0,
    right: 100,
    width: 100,
    height: 1,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function Harness({ enabled, onLoadMore }: { enabled: boolean; onLoadMore: () => void | Promise<void> }) {
  const ref = useInfiniteScroll<HTMLDivElement>({ enabled, onLoadMore });
  return <div data-testid="sentinel" ref={ref} />;
}

// Drain microtasks so an async `pump` loop settles between assertions.
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('useInfiniteScroll', () => {
  beforeEach(() => {
    lastObserver = null;
    vi.stubGlobal('IntersectionObserver', makeMockIO());
    // Run the catch-up loop's frame yield synchronously so tests don't
    // depend on real animation-frame timing.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    Object.defineProperty(window, 'innerHeight', {
      value: 800,
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fires onLoadMore when the sentinel intersects', async () => {
    const onLoadMore = vi.fn();
    render(<Harness enabled onLoadMore={onLoadMore} />);
    expect(lastObserver).not.toBeNull();
    expect(lastObserver!.observed).toHaveLength(1);

    lastObserver!.callback([{ isIntersecting: true }]);
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    await flush();
    // No layout in the test DOM (zero-size rect), so the catch-up loop
    // doesn't spin: one page per intersection.
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    lastObserver!.callback([{ isIntersecting: false }]);
    await flush();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('does not observe when disabled', () => {
    render(<Harness enabled={false} onLoadMore={() => {}} />);
    expect(lastObserver).toBeNull();
  });

  it('disconnects the observer on unmount', () => {
    const { unmount } = render(<Harness enabled onLoadMore={() => {}} />);
    const obs = lastObserver!;
    unmount();
    expect(obs.disconnected).toBe(true);
  });

  // Regression: the thread reserves its full scroll height up front with
  // placeholders, so on a slow connection a reader can scroll past the
  // single 1px sentinel before a page loads. The old check only fired on
  // `isIntersecting`, so once the sentinel left the viewport upward it
  // never fired again — pagination halted and the rest of the thread was
  // stuck showing gray placeholders. A sentinel that has been scrolled
  // past (its bottom above the real viewport top) must still load.
  it('fires onLoadMore when the reader has scrolled past the sentinel', async () => {
    const onLoadMore = vi.fn();
    render(<Harness enabled onLoadMore={onLoadMore} />);

    lastObserver!.callback([SCROLLED_PAST]);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    await flush();
  });

  // Catch-up: a single page often isn't enough when a fast scroll on a
  // slow link left the reader many pages past the sentinel. The pager
  // keeps loading — re-measuring the sentinel's live position after each
  // page — until it drops back below the fold, then stops (so a visible
  // sentinel never dumps the whole thread at once).
  it('keeps loading while the reader is still past the sentinel, then stops', async () => {
    const onLoadMore = vi.fn().mockResolvedValue(undefined);
    render(<Harness enabled onLoadMore={onLoadMore} />);
    const sentinel = screen.getByTestId('sentinel');
    // Still above the fold for the first two post-load checks, then the
    // freshly loaded comments have pushed it back below the viewport.
    sentinel.getBoundingClientRect = vi
      .fn()
      .mockReturnValueOnce(rect(-50))
      .mockReturnValueOnce(rect(-20))
      .mockReturnValue(rect(5000));

    lastObserver!.callback([{ isIntersecting: true }]);
    await flush();

    // Initial page + two catch-up pages, then the sentinel is below the
    // fold (rect.top 5000 > innerHeight 800) so the loop stops.
    expect(onLoadMore).toHaveBeenCalledTimes(3);
  });

  it('loads a single page when the sentinel is already below the fold', async () => {
    const onLoadMore = vi.fn().mockResolvedValue(undefined);
    render(<Harness enabled onLoadMore={onLoadMore} />);
    const sentinel = screen.getByTestId('sentinel');
    sentinel.getBoundingClientRect = vi.fn().mockReturnValue(rect(5000));

    lastObserver!.callback([{ isIntersecting: true }]);
    await flush();

    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
