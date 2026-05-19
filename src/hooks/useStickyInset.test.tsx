import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useStickyInset } from './useStickyInset';

// Regression for the second Codex review on PR #299: the sticky
// inset must re-measure when the sticky strips themselves change
// height (e.g. opening the `/hot` customize panel grows
// `.list-toolbar` without a window resize), not just on viewport
// resizes — otherwise rows behind the expanded panel still count
// as "fully visible" and slip into Sweep's batch.

type ResizeCallback = (entries: { target: Element }[]) => void;

interface MockObserverState {
  callback: ResizeCallback;
  observed: Element[];
  disconnected: boolean;
}

let lastObserver: MockObserverState | null = null;

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

function mountSticky(className: string, bottom: number): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  setBottomFor(el, bottom);
  document.body.appendChild(el);
  return el;
}

function setBottomFor(el: HTMLElement, bottom: number) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () =>
      ({
        top: bottom - 48,
        right: 0,
        bottom,
        left: 0,
        width: 0,
        height: 48,
        x: 0,
        y: bottom - 48,
        toJSON() {
          return {};
        },
      }) as DOMRect,
  });
}

function Probe({ onMeasure }: { onMeasure: (n: number) => void }) {
  const inset = useStickyInset();
  onMeasure(inset);
  return null;
}

describe('useStickyInset', () => {
  beforeEach(() => {
    lastObserver = null;
    vi.stubGlobal('ResizeObserver', makeMockRO());
    // Fire requestAnimationFrame synchronously so the scroll path
    // is testable without `vi.useFakeTimers`. The hook's onScroll
    // wraps the update in rAF to coalesce same-frame events; in
    // tests we want each scroll event to flush immediately so we
    // can assert the resulting state.
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      },
    );
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('measures both sticky strips on mount', () => {
    mountSticky('app-header', 56);
    const toolbar = mountSticky('list-toolbar', 104);
    const seen: number[] = [];
    render(<Probe onMeasure={(n) => seen.push(n)} />);
    expect(seen.at(-1)).toBe(104);
    expect(lastObserver).not.toBeNull();
    // Both strips are observed so any size change fires the update.
    expect(lastObserver!.observed).toContain(document.querySelector('.app-header'));
    expect(lastObserver!.observed).toContain(toolbar);
  });

  it('re-measures when ResizeObserver fires (toolbar height changed without a window resize)', () => {
    mountSticky('app-header', 56);
    const toolbar = mountSticky('list-toolbar', 104);
    const seen: number[] = [];
    render(<Probe onMeasure={(n) => seen.push(n)} />);
    expect(seen.at(-1)).toBe(104);
    // Simulate the `/hot` customize panel expanding: toolbar bottom
    // grows from 104 to 300, no window resize.
    setBottomFor(toolbar, 300);
    act(() => {
      lastObserver!.callback([{ target: toolbar }]);
    });
    expect(seen.at(-1)).toBe(300);
  });

  it('re-measures on window resize', () => {
    mountSticky('app-header', 56);
    const toolbar = mountSticky('list-toolbar', 104);
    const seen: number[] = [];
    render(<Probe onMeasure={(n) => seen.push(n)} />);
    setBottomFor(toolbar, 160);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(seen.at(-1)).toBe(160);
  });

  it('re-measures on window scroll (sticky transition shifts the toolbar bottom by a few px)', () => {
    mountSticky('app-header', 57);
    const toolbar = mountSticky('list-toolbar', 107);
    const seen: number[] = [];
    render(<Probe onMeasure={(n) => seen.push(n)} />);
    expect(seen.at(-1)).toBe(107);
    // Simulate the user scrolling enough to drive the toolbar from
    // normal flow (`getBoundingClientRect().bottom === 107`) to
    // sticky (`bottom === 104`, since the toolbar sticks at
    // `top: var(--app-header-height)` and overlaps the header's
    // bottom border by 1px in mono/duo chrome).
    setBottomFor(toolbar, 104);
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(seen.at(-1)).toBe(104);
  });

  it('disconnects the observer on unmount', () => {
    mountSticky('app-header', 56);
    mountSticky('list-toolbar', 104);
    const { unmount } = render(<Probe onMeasure={() => {}} />);
    const obs = lastObserver!;
    unmount();
    expect(obs.disconnected).toBe(true);
  });

  it('falls back gracefully when ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    mountSticky('app-header', 56);
    mountSticky('list-toolbar', 104);
    const seen: number[] = [];
    expect(() => {
      render(<Probe onMeasure={(n) => seen.push(n)} />);
    }).not.toThrow();
    expect(seen.at(-1)).toBe(104);
  });
});
