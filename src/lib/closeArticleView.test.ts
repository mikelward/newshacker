import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeArticleView } from './closeArticleView';

// The Navigation API isn't in jsdom; define/remove window.navigation per test.
function stubNavigation(canGoBack: boolean | undefined) {
  if (canGoBack === undefined) {
    delete (window as { navigation?: unknown }).navigation;
    return;
  }
  Object.defineProperty(window, 'navigation', {
    configurable: true,
    value: { canGoBack },
  });
}

function stubHistoryLength(length: number) {
  Object.defineProperty(window.history, 'length', {
    configurable: true,
    value: length,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as { navigation?: unknown }).navigation;
  // Restore history.length to its prototype getter.
  delete (window.history as unknown as { length?: number }).length;
});

describe('closeArticleView', () => {
  it('pops in-app history when the router owns a prior entry', () => {
    const navigate = vi.fn();
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    closeArticleView(navigate, 'abc123');
    expect(navigate).toHaveBeenCalledWith(-1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it('pops to the external referrer on a deep link with a back entry (Navigation API)', () => {
    stubNavigation(true);
    const navigate = vi.fn();
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    closeArticleView(navigate, 'default');
    expect(navigate).toHaveBeenCalledWith(-1);
    expect(close).not.toHaveBeenCalled();
  });

  it('falls back to history.length when the Navigation API is unavailable', () => {
    stubNavigation(undefined);
    stubHistoryLength(2);
    const navigate = vi.fn();
    closeArticleView(navigate, 'default');
    expect(navigate).toHaveBeenCalledWith(-1);
  });

  it('closes the tab then falls back to root when there is no back entry', () => {
    // canGoBack === false even though history.length > 1 (e.g. a forward entry
    // from an in-app link the reader then browser-Back'd away from): there is
    // no *back* entry, so we must not strand on a no-op navigate(-1).
    stubNavigation(false);
    stubHistoryLength(2);
    const navigate = vi.fn();
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    closeArticleView(navigate, 'default');
    expect(close).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/');
    expect(navigate).not.toHaveBeenCalledWith(-1);
  });

  it('closes then roots on a cold deep link (single history entry)', () => {
    stubNavigation(undefined);
    stubHistoryLength(1);
    const navigate = vi.fn();
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    closeArticleView(navigate, 'default');
    expect(close).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/');
  });
});
