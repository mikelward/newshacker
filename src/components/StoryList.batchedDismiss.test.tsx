import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { DISMISS_BATCH_WINDOW_MS, StoryList } from './StoryList';
import { ToastProvider } from './Toast';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';

type Cb = (entries: IntersectionObserverEntry[]) => void;

interface FakeObs {
  observed: Set<Element>;
  trigger: Cb;
}

function setupObserver(): { observers: FakeObs[]; cleanup: () => void } {
  const observers: FakeObs[] = [];
  const OriginalIO = (globalThis as { IntersectionObserver?: unknown })
    .IntersectionObserver;

  class FakeIO {
    observed = new Set<Element>();
    private cb: Cb;
    constructor(cb: Cb) {
      this.cb = cb;
      observers.push({ observed: this.observed, trigger: this.cb });
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
        delete (globalThis as { IntersectionObserver?: unknown })
          .IntersectionObserver;
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

function triggerScrollPast(obs: FakeObs[], el: Element) {
  const owner = obs.find((o) => o.observed.has(el))!;
  act(() => {
    owner.trigger([entry(el, true, 50)]);
    owner.trigger([entry(el, false, -10)]);
  });
}

function findRow(obs: FakeObs[], title: string): Element {
  const all = obs.flatMap((o) => Array.from(o.observed));
  const row = all.find((el) => el.textContent?.includes(title));
  if (!row) throw new Error(`row "${title}" not found`);
  return row;
}

describe('<StoryList> batched dismiss undo toast', () => {
  let obs: ReturnType<typeof setupObserver>;

  beforeEach(() => {
    obs = setupObserver();
    window.localStorage.clear();
    Object.defineProperty(window, 'scrollTo', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });
  afterEach(() => {
    obs.cleanup();
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it('bundles rapid dismissals into one undo that restores all of them', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-04-18T10:00:00Z'));
    const ids = [1, 2, 3, 4];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(
      <ToastProvider>
        <StoryList feed="top" />
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(4);
    });

    triggerScrollPast(obs.observers, findRow(obs.observers, 'Story 1'));
    await waitFor(() => expect(screen.getByText('Dismissed')).toBeInTheDocument());

    vi.setSystemTime(new Date('2026-04-18T10:00:01Z'));
    triggerScrollPast(obs.observers, findRow(obs.observers, 'Story 2'));
    await waitFor(() =>
      expect(screen.getByText('Dismissed 2')).toBeInTheDocument(),
    );

    vi.setSystemTime(new Date('2026-04-18T10:00:02Z'));
    triggerScrollPast(obs.observers, findRow(obs.observers, 'Story 3'));
    await waitFor(() =>
      expect(screen.getByText('Dismissed 3')).toBeInTheDocument(),
    );

    expect(screen.queryByText('Story 1')).toBeNull();
    expect(screen.queryByText('Story 2')).toBeNull();
    expect(screen.queryByText('Story 3')).toBeNull();
    expect(screen.getByText('Story 4')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /undo/i }));

    await waitFor(() => {
      expect(screen.getByText('Story 1')).toBeInTheDocument();
      expect(screen.getByText('Story 2')).toBeInTheDocument();
      expect(screen.getByText('Story 3')).toBeInTheDocument();
    });

    const stored = window.localStorage.getItem('newshacker:dismissedStoryIds');
    const parsed = stored
      ? (JSON.parse(stored) as Array<{ id: number }>)
      : [];
    expect(parsed.map((e) => e.id)).toEqual([]);
  });

  it('starts a new batch once the window has elapsed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-04-18T10:00:00Z'));
    const ids = [10, 20, 30];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(
      <ToastProvider>
        <StoryList feed="top" />
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });

    triggerScrollPast(obs.observers, findRow(obs.observers, 'Story 10'));
    await waitFor(() => expect(screen.getByText('Dismissed')).toBeInTheDocument());

    // Jump well past the batch window so the next dismiss starts fresh.
    vi.setSystemTime(
      new Date(Date.now() + DISMISS_BATCH_WINDOW_MS + 1000),
    );
    triggerScrollPast(obs.observers, findRow(obs.observers, 'Story 20'));

    await waitFor(() => {
      // Still "Dismissed" (count 1) — the prior batch closed.
      expect(screen.getByText('Dismissed')).toBeInTheDocument();
      expect(screen.queryByText(/Dismissed 2/)).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: /undo/i }));

    // Only Story 20 returns; Story 10 stays dismissed.
    await waitFor(() => {
      expect(screen.getByText('Story 20')).toBeInTheDocument();
    });
    expect(screen.queryByText('Story 10')).toBeNull();
  });

  it('flashes the restored rows and scrolls to the first one if offscreen', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-04-18T10:00:00Z'));
    const scrollTo = vi.fn();
    Object.defineProperty(window, 'scrollTo', {
      configurable: true,
      writable: true,
      value: scrollTo,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 600,
    });
    // Row geometry: place each li above the viewport so undo triggers a scroll.
    Element.prototype.getBoundingClientRect = function () {
      const tag = (this as Element).tagName;
      if (tag === 'LI') {
        return {
          width: 320,
          height: 72,
          top: -200,
          bottom: -128,
          left: 0,
          right: 320,
          x: 0,
          y: -200,
          toJSON() {},
        } as DOMRect;
      }
      return {
        width: 320,
        height: 56,
        top: 0,
        bottom: 56,
        left: 0,
        right: 320,
        x: 0,
        y: 0,
        toJSON() {},
      } as DOMRect;
    };

    const ids = [11, 22, 33];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(
      <ToastProvider>
        <StoryList feed="top" />
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });

    triggerScrollPast(obs.observers, findRow(obs.observers, 'Story 11'));
    vi.setSystemTime(new Date(Date.now() + 200));
    triggerScrollPast(obs.observers, findRow(obs.observers, 'Story 22'));
    await waitFor(() =>
      expect(screen.getByText('Dismissed 2')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: /undo/i }));

    await waitFor(() => {
      expect(screen.getByText('Story 11')).toBeInTheDocument();
      expect(screen.getByText('Story 22')).toBeInTheDocument();
    });

    // First restored row gets scrolled into view since it's above the viewport.
    expect(scrollTo).toHaveBeenCalled();
    const arg = scrollTo.mock.calls[0][0] as ScrollToOptions;
    expect(arg.behavior).toBe('smooth');

    // Both restored rows are flashed.
    const items11 = screen.getByText('Story 11').closest('li');
    const items22 = screen.getByText('Story 22').closest('li');
    expect(items11?.className).toContain('story-list__item--restored');
    expect(items22?.className).toContain('story-list__item--restored');

    // Highlight clears after the flash duration.
    act(() => {
      vi.advanceTimersByTime(1300);
    });
    await waitFor(() => {
      const liAfter = screen.getByText('Story 11').closest('li');
      expect(liAfter?.className).not.toContain('story-list__item--restored');
    });
  });

  it('does not scroll when the first restored row is already on screen', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-04-18T10:00:00Z'));
    const scrollTo = vi.fn();
    Object.defineProperty(window, 'scrollTo', {
      configurable: true,
      writable: true,
      value: scrollTo,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 600,
    });
    // Row sits inside the viewport.
    Element.prototype.getBoundingClientRect = function () {
      const tag = (this as Element).tagName;
      if (tag === 'LI') {
        return {
          width: 320,
          height: 72,
          top: 200,
          bottom: 272,
          left: 0,
          right: 320,
          x: 0,
          y: 200,
          toJSON() {},
        } as DOMRect;
      }
      return {
        width: 320,
        height: 56,
        top: 0,
        bottom: 56,
        left: 0,
        right: 320,
        x: 0,
        y: 0,
        toJSON() {},
      } as DOMRect;
    };

    const ids = [44, 55];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(
      <ToastProvider>
        <StoryList feed="top" />
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });

    triggerScrollPast(obs.observers, findRow(obs.observers, 'Story 44'));
    await waitFor(() => expect(screen.getByText('Dismissed')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /undo/i }));

    await waitFor(() => {
      expect(screen.getByText('Story 44')).toBeInTheDocument();
    });

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('clears the batch after Undo so the next dismiss is fresh', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-04-18T10:00:00Z'));
    const ids = [100, 200, 300];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(
      <ToastProvider>
        <StoryList feed="top" />
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });

    triggerScrollPast(obs.observers, findRow(obs.observers, 'Story 100'));
    vi.setSystemTime(new Date(Date.now() + 500));
    triggerScrollPast(obs.observers, findRow(obs.observers, 'Story 200'));
    await waitFor(() =>
      expect(screen.getByText('Dismissed 2')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    await waitFor(() => {
      expect(screen.getByText('Story 100')).toBeInTheDocument();
      expect(screen.getByText('Story 200')).toBeInTheDocument();
    });

    // Only ~500ms later, dismiss again — should NOT join the cleared batch.
    vi.setSystemTime(new Date(Date.now() + 500));
    triggerScrollPast(obs.observers, findRow(obs.observers, 'Story 300'));
    await waitFor(() => {
      expect(screen.getByText('Dismissed')).toBeInTheDocument();
      expect(screen.queryByText(/Dismissed 2/)).toBeNull();
    });
  });
});
