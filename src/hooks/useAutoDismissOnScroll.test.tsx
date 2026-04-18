import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { act, render } from '@testing-library/react';
import { useAutoDismissOnScroll } from './useAutoDismissOnScroll';

type Cb = (entries: IntersectionObserverEntry[]) => void;

interface FakeObserver {
  observed: Set<Element>;
  trigger: (entries: IntersectionObserverEntry[]) => void;
}

function setupObserver(): { observers: FakeObserver[]; cleanup: () => void } {
  const observers: FakeObserver[] = [];
  const OriginalIO = (globalThis as { IntersectionObserver?: unknown })
    .IntersectionObserver;

  class FakeIO {
    observed = new Set<Element>();
    private cb: Cb;
    constructor(cb: Cb) {
      this.cb = cb;
      observers.push({
        observed: this.observed,
        trigger: (entries) => this.cb(entries),
      });
    }
    observe(el: Element) {
      this.observed.add(el);
    }
    unobserve(el: Element) {
      this.observed.delete(el);
    }
    disconnect() {
      this.observed.clear();
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
    FakeIO as unknown as typeof IntersectionObserver;

  return {
    observers,
    cleanup: () => {
      if (OriginalIO === undefined) {
        delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
      } else {
        (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
          OriginalIO;
      }
    },
  };
}

function entry(
  target: Element,
  isIntersecting: boolean,
  bottom: number,
): IntersectionObserverEntry {
  const rect: DOMRectReadOnly = {
    x: 0,
    y: 0,
    width: 100,
    height: 72,
    top: bottom - 72,
    left: 0,
    right: 100,
    bottom,
    toJSON() {
      return this;
    },
  };
  return {
    target,
    isIntersecting,
    intersectionRatio: isIntersecting ? 1 : 0,
    boundingClientRect: rect,
    intersectionRect: rect,
    rootBounds: null,
    time: 0,
  };
}

interface HostProps {
  ids: number[];
  onPast: (id: number) => void;
  enabled?: boolean;
  topOffset?: number;
}

function Host({ ids, onPast, enabled = true, topOffset }: HostProps) {
  const { observe } = useAutoDismissOnScroll({
    enabled,
    onScrolledPast: onPast,
    topOffset,
  });
  return (
    <ul>
      {ids.map((id) => (
        <li
          key={id}
          data-testid={`row-${id}`}
          ref={(el) => observe(id, el)}
        >
          {id}
        </li>
      ))}
    </ul>
  );
}

describe('useAutoDismissOnScroll', () => {
  let obs: ReturnType<typeof setupObserver>;

  beforeEach(() => {
    obs = setupObserver();
  });
  afterEach(() => {
    obs.cleanup();
    vi.restoreAllMocks();
  });

  it('fires onScrolledPast when a row has been seen and leaves upward', () => {
    const onPast = vi.fn();
    const { getByTestId } = render(<Host ids={[1]} onPast={onPast} />);
    const row = getByTestId('row-1');

    act(() => {
      obs.observers[0].trigger([entry(row, true, 50)]);
    });
    expect(onPast).not.toHaveBeenCalled();

    act(() => {
      obs.observers[0].trigger([entry(row, false, -10)]);
    });
    expect(onPast).toHaveBeenCalledWith(1);
  });

  it('does not fire when the row has never been seen', () => {
    const onPast = vi.fn();
    const { getByTestId } = render(<Host ids={[2]} onPast={onPast} />);
    const row = getByTestId('row-2');

    act(() => {
      obs.observers[0].trigger([entry(row, false, -10)]);
    });
    expect(onPast).not.toHaveBeenCalled();
  });

  it('does not fire when the row exits downward (user scrolled up)', () => {
    const onPast = vi.fn();
    const { getByTestId } = render(<Host ids={[3]} onPast={onPast} />);
    const row = getByTestId('row-3');

    act(() => {
      obs.observers[0].trigger([entry(row, true, 300)]);
      obs.observers[0].trigger([entry(row, false, 800)]);
    });
    expect(onPast).not.toHaveBeenCalled();
  });

  it('does nothing when disabled', () => {
    const onPast = vi.fn();
    render(<Host ids={[4]} onPast={onPast} enabled={false} />);
    expect(obs.observers.length).toBe(0);
    expect(onPast).not.toHaveBeenCalled();
  });

  it('disconnects on unmount', () => {
    const onPast = vi.fn();
    const { unmount, getByTestId } = render(<Host ids={[5]} onPast={onPast} />);
    const row = getByTestId('row-5');
    const fake = obs.observers[0];
    expect(fake.observed.has(row)).toBe(true);
    unmount();
    expect(fake.observed.size).toBe(0);
  });

  it('treats rows as past when they hide behind a topOffset sticky header', () => {
    const onPast = vi.fn();
    const { getByTestId } = render(
      <Host ids={[6]} onPast={onPast} topOffset={60} />,
    );
    const row = getByTestId('row-6');

    act(() => {
      obs.observers[0].trigger([entry(row, true, 120)]);
    });

    act(() => {
      obs.observers[0].trigger([entry(row, false, 40)]);
    });
    expect(onPast).toHaveBeenCalledWith(6);
  });

  it('does not fire when the row is still below the topOffset', () => {
    const onPast = vi.fn();
    const { getByTestId } = render(
      <Host ids={[7]} onPast={onPast} topOffset={60} />,
    );
    const row = getByTestId('row-7');

    act(() => {
      obs.observers[0].trigger([entry(row, true, 200)]);
      obs.observers[0].trigger([entry(row, false, 80)]);
    });
    expect(onPast).not.toHaveBeenCalled();
  });

  it('stops observing a row that is removed from the list', () => {
    const onPast = vi.fn() as Mock;
    const { rerender } = render(<Host ids={[10, 20]} onPast={onPast} />);
    const fake = obs.observers[0];
    expect(fake.observed.size).toBe(2);

    rerender(<Host ids={[10]} onPast={onPast} />);
    expect(fake.observed.size).toBe(1);
  });
});
