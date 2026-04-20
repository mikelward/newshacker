import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { useContentWidth } from './useContentWidth';

type ResizeCallback = (entries: { target: Element }[]) => void;

interface MockObserverState {
  callback: ResizeCallback;
  observed: Element[];
  disconnected: boolean;
}

let lastObserver: MockObserverState | null = null;
let mockClientWidth = 0;

function makeMockRO() {
  return function MockRO(cb: ResizeCallback) {
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
    };
  };
}

function Harness({ onMeasure }: { onMeasure: (w: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useContentWidth(ref);
  onMeasure(width);
  return <div data-testid="target" ref={ref} />;
}

describe('useContentWidth', () => {
  beforeEach(() => {
    lastObserver = null;
    mockClientWidth = 360;
    vi.stubGlobal('ResizeObserver', makeMockRO());
    // jsdom returns 0 for clientWidth without a layout engine; stub the
    // getter so the hook receives a deterministic, non-zero value.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return mockClientWidth;
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    // Remove the clientWidth override so it doesn't leak into other suites.
    delete (HTMLElement.prototype as unknown as { clientWidth?: number })
      .clientWidth;
  });

  it('measures the target element on mount', () => {
    const widths: number[] = [];
    render(<Harness onMeasure={(w) => widths.push(w)} />);
    expect(widths).toContain(360);
    expect(lastObserver).not.toBeNull();
    expect(lastObserver!.observed).toHaveLength(1);
  });

  it('updates when ResizeObserver fires with a new size', () => {
    const widths: number[] = [];
    render(<Harness onMeasure={(w) => widths.push(w)} />);
    mockClientWidth = 240;
    const target = lastObserver!.observed[0];
    act(() => {
      lastObserver!.callback([{ target }]);
    });
    expect(widths.at(-1)).toBe(240);
  });

  it('disconnects the observer on unmount', () => {
    const { unmount } = render(<Harness onMeasure={() => {}} />);
    const obs = lastObserver!;
    unmount();
    expect(obs.disconnected).toBe(true);
  });
});
