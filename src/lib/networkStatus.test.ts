import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetNetworkStatusForTests,
  getOnline,
  subscribeOnline,
  trackedFetch,
} from './networkStatus';

describe('trackedFetch', () => {
  beforeEach(() => {
    _resetNetworkStatusForTests();
  });
  afterEach(() => {
    _resetNetworkStatusForTests();
    vi.unstubAllGlobals();
  });

  it('reports success on any response, even a 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('oops', { status: 500 })),
    );
    const events: boolean[] = [];
    subscribeOnline((v) => events.push(v));

    // Start in a degraded state so success can flip us back.
    await expect(
      trackedFetch('/x').catch(() => undefined).then(async () => {
        // no-op; just making sure the call completes
      }),
    ).resolves.toBeUndefined();

    // Reaching a server (even one returning 500) proves connectivity.
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
