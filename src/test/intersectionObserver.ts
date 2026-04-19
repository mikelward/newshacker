// jsdom has no IntersectionObserver, so we install a minimal mock for tests.
// By default, observing an element fires the callback with `intersectionRatio = 1`,
// which mirrors the "everything is on screen" happy path the existing tests assume.
// To simulate a partially-visible row, call `setVisibilityForTest(el, ratio)` — the
// mock re-fires each observer's callback for that element with the new ratio.

const mockObservers = new Set<MockIntersectionObserver>();
const elementRatios = new WeakMap<Element, number>();

function makeEntry(el: Element, ratio: number): IntersectionObserverEntry {
  const rect =
    typeof el.getBoundingClientRect === 'function'
      ? el.getBoundingClientRect()
      : new DOMRect();
  return {
    target: el,
    intersectionRatio: ratio,
    isIntersecting: ratio > 0,
    boundingClientRect: rect as DOMRectReadOnly,
    intersectionRect: rect as DOMRectReadOnly,
    rootBounds: null,
    time: 0,
  };
}

class MockIntersectionObserver implements IntersectionObserver {
  root: Element | null = null;
  rootMargin: string;
  thresholds: ReadonlyArray<number>;
  private cb: IntersectionObserverCallback;
  readonly watched = new Set<Element>();

  constructor(
    cb: IntersectionObserverCallback,
    opts?: IntersectionObserverInit,
  ) {
    this.cb = cb;
    this.rootMargin = opts?.rootMargin ?? '';
    const t = opts?.threshold;
    this.thresholds = Array.isArray(t) ? t : [t ?? 0];
    mockObservers.add(this);
  }

  observe(el: Element): void {
    this.watched.add(el);
    const ratio = elementRatios.get(el) ?? 1;
    this.fireEntries([makeEntry(el, ratio)]);
  }

  unobserve(el: Element): void {
    this.watched.delete(el);
  }

  disconnect(): void {
    this.watched.clear();
    mockObservers.delete(this);
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  fireEntries(entries: IntersectionObserverEntry[]): void {
    this.cb(entries, this as unknown as IntersectionObserver);
  }
}

export function setVisibilityForTest(el: Element, ratio: number): void {
  elementRatios.set(el, ratio);
  for (const o of mockObservers) {
    if (o.watched.has(el)) o.fireEntries([makeEntry(el, ratio)]);
  }
}

type IOGlobal = { IntersectionObserver?: typeof IntersectionObserver };

let previousIntersectionObserver: typeof IntersectionObserver | undefined;
let installed = false;

export function installIntersectionObserverMock(): void {
  const g = globalThis as unknown as IOGlobal;
  if (!installed) {
    previousIntersectionObserver = g.IntersectionObserver;
    installed = true;
  }
  g.IntersectionObserver =
    MockIntersectionObserver as unknown as typeof IntersectionObserver;
}

export function uninstallIntersectionObserverMock(): void {
  if (!installed) return;
  const g = globalThis as unknown as IOGlobal;
  if (previousIntersectionObserver) {
    g.IntersectionObserver = previousIntersectionObserver;
  } else {
    delete g.IntersectionObserver;
  }
  installed = false;
  previousIntersectionObserver = undefined;
  mockObservers.clear();
}
