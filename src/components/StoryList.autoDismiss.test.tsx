import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { StoryList } from './StoryList';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';
import { addOpenedId } from '../lib/openedStories';

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

describe('<StoryList> auto-dismiss on scroll-past', () => {
  let obs: ReturnType<typeof setupObserver>;

  beforeEach(() => {
    obs = setupObserver();
    window.localStorage.clear();
  });
  afterEach(() => {
    obs.cleanup();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('dismisses a row that scrolled past upward and persists the id', async () => {
    const ids = [100, 200, 300];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });

    renderWithProviders(<StoryList feed="top" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(3);
    });

    const rowTargets = obs.observers.flatMap((o) => Array.from(o.observed));
    const row100 = rowTargets.find((el) =>
      el.textContent?.includes('Story 100'),
    );
    expect(row100).toBeDefined();

    const dismissObs = obs.observers.find((o) => o.observed.has(row100!))!;

    act(() => {
      dismissObs.trigger([entry(row100!, true, 50)]);
      dismissObs.trigger([entry(row100!, false, -10)]);
    });

    await waitFor(() => {
      expect(screen.queryByText('Story 100')).toBeNull();
    });

    const stored = window.localStorage.getItem('newshacker:dismissedStoryIds');
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored as string) as Array<{
      id: number;
      at: number;
    }>;
    expect(parsed.map((e) => e.id)).toContain(100);
  });

  it('renders the opened modifier class for opened rows', async () => {
    const ids = [1, 2];
    const items = Object.fromEntries(
      ids.map((id) => [id, makeStory(id, { title: `Story ${id}` })]),
    );
    installHNFetchMock({ feeds: { topstories: ids }, items });
    addOpenedId(1);

    renderWithProviders(<StoryList feed="top" />);
    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(2);
    });

    const rows = screen.getAllByTestId('story-row');
    const openedRow = rows.find((r) => r.textContent?.includes('Story 1'))!;
    const unopenedRow = rows.find((r) => r.textContent?.includes('Story 2'))!;
    expect(openedRow.className).toContain('story-row--title-opened');
    expect(openedRow.className).toContain('story-row--comments-opened');
    expect(unopenedRow.className).not.toContain('story-row--title-opened');
    expect(unopenedRow.className).not.toContain('story-row--comments-opened');
  });
});
