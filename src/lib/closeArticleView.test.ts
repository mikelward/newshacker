import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeArticleView } from './closeArticleView';

function stubHistoryLength(length: number) {
  Object.defineProperty(window.history, 'length', {
    configurable: true,
    value: length,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  // Restore history.length to its prototype getter.
  delete (window.history as unknown as { length?: number }).length;
});

describe('closeArticleView', () => {
  it('goes back when the browser has another history entry', () => {
    // length > 1 covers an in-app page, and — since history.length counts
    // cross-origin entries — the external-return flow (opened from Readmo).
    stubHistoryLength(2);
    const navigate = vi.fn();
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    closeArticleView(navigate);
    expect(navigate).toHaveBeenCalledWith(-1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it('closes the tab then falls back to root on a cold entry (single history entry)', () => {
    stubHistoryLength(1);
    const navigate = vi.fn();
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    closeArticleView(navigate);
    expect(close).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/');
    expect(navigate).not.toHaveBeenCalledWith(-1);
  });
});
