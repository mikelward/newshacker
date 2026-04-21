import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetNetworkStatusForTests,
  getOnline,
  reportFetchFailure,
  reportFetchSuccess,
  subscribeOnline,
  trackedFetch,
} from './networkStatus';

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value,
  });
}

describe('networkStatus tracker', () => {
  beforeEach(() => {
    setNavigatorOnline(true);
    _resetNetworkStatusForTests();
  });
  afterEach(() => {
    setNavigatorOnline(true);
    _resetNetworkStatusForTests();
    vi.unstubAllGlobals();
  });

  describe('trackedFetch', () => {
    it('reports success on any response, even a 500 (reaching a server proves connectivity)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('oops', { status: 500 })),
      );
      await trackedFetch('/x');
      expect(getOnline()).toBe(true);
    });

    it('flips offline when fetch throws a TypeError, then back online on next success', async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(trackedFetch('/x')).rejects.toBeInstanceOf(TypeError);
      expect(getOnline()).toBe(false);

      await trackedFetch('/y');
      expect(getOnline()).toBe(true);
    });

    it('ignores AbortError — a superseded request is not a connectivity signal', async () => {
      const err = new DOMException('aborted', 'AbortError');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw err;
        }),
      );

      await expect(trackedFetch('/x')).rejects.toBe(err);
      expect(getOnline()).toBe(true);
    });

    it('notifies subscribers only on transitions', async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const events: boolean[] = [];
      subscribeOnline((v) => events.push(v));

      await trackedFetch('/x').catch(() => undefined);
      await trackedFetch('/x').catch(() => undefined);
      await trackedFetch('/x');

      // Two identical "offline" fetches should emit one transition;
      // coming back online is the second.
      expect(events).toEqual([false, true]);
    });
  });

  describe('combined browser + fetch signals', () => {
    it('stays offline while the browser reports offline even if fetches succeed (SW cache hit)', () => {
      // Simulate the browser going offline first.
      window.dispatchEvent(new Event('offline'));
      expect(getOnline()).toBe(false);

      // The SW serves a cached response, so trackedFetch reports success.
      reportFetchSuccess();

      // Combined should still be offline — browser hasn't agreed yet.
      expect(getOnline()).toBe(false);
    });

    it('stays offline while fetches keep failing even if the browser claims online (stuck navigator.onLine)', () => {
      // This is the tunnel case: navigator.onLine is still true but
      // real requests are failing.
      expect(getOnline()).toBe(true);
      reportFetchFailure(new TypeError('Failed to fetch'));
      expect(getOnline()).toBe(false);

      // Spurious 'online' event from the browser — meaningless while
      // real fetches keep failing.
      window.dispatchEvent(new Event('online'));
      expect(getOnline()).toBe(false);
    });

    it('only returns online when both signals agree', () => {
      // Break both signals.
      window.dispatchEvent(new Event('offline'));
      reportFetchFailure(new TypeError('Failed to fetch'));
      expect(getOnline()).toBe(false);

      // Browser alone coming back isn't enough.
      window.dispatchEvent(new Event('online'));
      expect(getOnline()).toBe(false);

      // Fetch recovering too — now both agree.
      reportFetchSuccess();
      expect(getOnline()).toBe(true);
    });

    it('emits only when the combined value actually changes', () => {
      const events: boolean[] = [];
      subscribeOnline((v) => events.push(v));

      // Browser goes offline: combined flips to false.
      window.dispatchEvent(new Event('offline'));
      // Fetch also fails — still offline, no emit.
      reportFetchFailure(new TypeError('Failed to fetch'));
      // Browser comes back — fetch still broken, still offline, no emit.
      window.dispatchEvent(new Event('online'));
      // Fetch recovers — combined flips to true.
      reportFetchSuccess();

      expect(events).toEqual([false, true]);
    });
  });
});
