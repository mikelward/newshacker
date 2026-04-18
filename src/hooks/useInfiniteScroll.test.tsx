import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useInfiniteScroll } from './useInfiniteScroll';

interface MockEntry {
  isIntersecting: boolean;
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
      unobserve: () => {},
      takeRecords: () => [] as MockEntry[],
    };
  };
}

function Harness({ enabled, onLoadMore }: { enabled: boolean; onLoadMore: () => void }) {
  const ref = useInfiniteScroll<HTMLDivElement>({ enabled, onLoadMore });
  return <div data-testid="sentinel" ref={ref} />;
}

describe('useInfiniteScroll', () => {
  beforeEach(() => {
    lastObserver = null;
    vi.stubGlobal('IntersectionObserver', makeMockIO());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fires onLoadMore when the sentinel intersects', () => {
    const onLoadMore = vi.fn();
    render(<Harness enabled onLoadMore={onLoadMore} />);
    expect(lastObserver).not.toBeNull();
    expect(lastObserver!.observed).toHaveLength(1);

    lastObserver!.callback([{ isIntersecting: true }]);
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    lastObserver!.callback([{ isIntersecting: false }]);
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
});
