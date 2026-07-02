import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onlineManager } from '@tanstack/react-query';
import {
  _resetNetworkStatusForTests,
  CORE_READ_HEDGE_DELAY_MS,
  CORE_READ_TIMEOUT_MS,
  getConnectivityStatus,
  getOnline,
  isRetryableFetchError,
  PROBE_TIMEOUT_MS,
  RECOVERY_PROBE_INTERVAL_MS,
  reportFetchFailure,
  reportFetchSuccess,
  setConnectivityProbeUrl,
  subscribeConnectivityStatus,
  subscribeOnline,
  trackedFetch,
} from './networkStatus';

const PROBE = '/api/me';
const CORE = '/api/items?ids=1';

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value,
  });
}

// A fetch mock whose every call stays pending until the test settles it by
// hand (settle a controlled promise — never a sleep). Honors AbortSignal, so
// the tracker's read cap and probe timeout actually reject the promise.
interface PendingCall {
  url: string;
  init?: RequestInit;
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
}
function controlledFetch() {
  const calls: PendingCall[] = [];
  const fn = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const url = input instanceof Request ? input.url : String(input);
        calls.push({ url, init, resolve, reject });
        const signal = init?.signal;
        signal?.addEventListener('abort', () =>
          reject(signal.reason ?? new DOMException('aborted', 'AbortError')),
        );
      }),
  );
  return { fn, calls };
}

const netError = () => new TypeError('Failed to fetch');
// Drain the microtask queue deterministically under fake timers.
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('networkStatus tracker', () => {
  beforeEach(() => {
    setNavigatorOnline(true);
    _resetNetworkStatusForTests();
  });
  afterEach(() => {
    setNavigatorOnline(true);
    _resetNetworkStatusForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('trackedFetch (no probe configured — legacy mode)', () => {
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
        .mockRejectedValueOnce(netError())
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(trackedFetch('/x')).rejects.toBeInstanceOf(TypeError);
      expect(getOnline()).toBe(false);

      await trackedFetch('/y');
      expect(getOnline()).toBe(true);
    });

    it('flips offline for non-TypeError fetch failures used by browsers and native shells', async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(
          new DOMException('The network connection was lost.', 'NetworkError'),
        )
        .mockRejectedValueOnce(new Error('Network request failed'));
      vi.stubGlobal('fetch', fetchMock);

      await expect(trackedFetch('/dom')).rejects.toBeInstanceOf(DOMException);
      expect(getOnline()).toBe(false);

      reportFetchSuccess();
      expect(getOnline()).toBe(true);

      await expect(trackedFetch('/native')).rejects.toThrow(
        /network request failed/i,
      );
      expect(getOnline()).toBe(false);
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
        .mockRejectedValueOnce(netError())
        .mockRejectedValueOnce(netError())
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

      // Combined should still be offline — the OS signal may only make us
      // more pessimistic; it can never prove we're online, and neither can a
      // cache hit.
      expect(getOnline()).toBe(false);
    });

    it('stays offline while fetches keep failing even if the browser claims online (stuck navigator.onLine)', () => {
      // This is the tunnel case: navigator.onLine is still true but
      // real requests are failing.
      expect(getOnline()).toBe(true);
      reportFetchFailure(netError());
      expect(getOnline()).toBe(false);

      // Spurious 'online' event from the browser — meaningless while
      // real fetches keep failing.
      window.dispatchEvent(new Event('online'));
      expect(getOnline()).toBe(false);
    });

    it('only returns online when both signals agree', () => {
      // Break both signals.
      window.dispatchEvent(new Event('offline'));
      reportFetchFailure(netError());
      expect(getOnline()).toBe(false);

      // Browser alone coming back isn't enough.
      window.dispatchEvent(new Event('online'));
      expect(getOnline()).toBe(false);

      // Fetch recovering too — now both agree.
      reportFetchSuccess();
      expect(getOnline()).toBe(true);
    });

    it('does NOT pause React Query on a transient fetch failure when no probe is configured', () => {
      // Without a probe there is no traffic-free resume path: if a fetch
      // failure paused onlineManager, nothing would ever un-pause it (no
      // browser 'online' event fires when navigator.onLine never flipped),
      // wedging the feed on the loading skeleton. So unconfigured mode keeps
      // pausing on the browser signal only.
      expect(onlineManager.isOnline()).toBe(true);

      reportFetchFailure(netError());

      expect(getOnline()).toBe(false); // pill reacts immediately
      expect(onlineManager.isOnline()).toBe(true); // RQ keeps retrying
    });

    it('pauses React Query when the browser itself reports offline (resumable)', () => {
      // A genuine browser-offline has a matching 'online' event to
      // resume on, so it's safe to pause React Query here.
      expect(onlineManager.isOnline()).toBe(true);

      window.dispatchEvent(new Event('offline'));
      expect(onlineManager.isOnline()).toBe(false);

      window.dispatchEvent(new Event('online'));
      expect(onlineManager.isOnline()).toBe(true);
    });

    it('emits only when the combined value actually changes', () => {
      const events: boolean[] = [];
      subscribeOnline((v) => events.push(v));

      // Browser goes offline: combined flips to false.
      window.dispatchEvent(new Event('offline'));
      // Fetch also fails — still offline, no emit.
      reportFetchFailure(netError());
      // Browser comes back — fetch still broken, still offline, no emit.
      window.dispatchEvent(new Event('online'));
      // Fetch recovers — combined flips to true.
      reportFetchSuccess();

      expect(events).toEqual([false, true]);
    });
  });

  describe('query-layer pausing on evidence (probe configured)', () => {
    it('pauses React Query the moment a real request fails, and the immediate probe resumes it on a transient blip', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      setConnectivityProbeUrl(PROBE);

      reportFetchFailure(netError());
      // Paused immediately — a struggling network must not be retry-stormed.
      expect(onlineManager.isOnline()).toBe(false);
      expect(getOnline()).toBe(false);

      // The offline transition kicks a probe at once; a blip recovers in ~one
      // round trip instead of waiting out the 30s recovery interval.
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        PROBE,
        expect.objectContaining({ method: 'GET', cache: 'no-store' }),
      );
      expect(getOnline()).toBe(true);
      expect(onlineManager.isOnline()).toBe(true);
    });

    it('stays paused while the probe also fails (genuinely offline), without probe-looping', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () => {
        throw netError();
      });
      vi.stubGlobal('fetch', fetchMock);
      setConnectivityProbeUrl(PROBE);

      reportFetchFailure(netError());
      await flush();

      expect(getOnline()).toBe(false);
      expect(onlineManager.isOnline()).toBe(false);
      // Exactly one immediate probe: its own failure must not re-kick another
      // (the recovery interval owns retries) or a dead network would loop
      // probes back-to-back.
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // A second failure while already offline doesn't kick another probe
      // either — one immediate probe per offline transition.
      reportFetchFailure(netError());
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('liveness latch (stops the offline ↔ online flap on SW cache hits)', () => {
    it('does not let a cache-served GET success flip us back online while offline', async () => {
      // The flap: navigator.onLine is stuck true (tunnel), a real request failed
      // → offline, then a Workbox-cache-served GET resolves and trackedFetch
      // reports success, bouncing the pill back online. With a probe configured,
      // an ambiguous GET success must NOT clear the pill.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw netError();
        }),
      );
      setConnectivityProbeUrl(PROBE);
      reportFetchFailure(netError());
      expect(getOnline()).toBe(false);

      // Cache hit (GET, cacheBypassing=false) — suppressed, even before any probe.
      reportFetchSuccess(/* cacheBypassing */ false);
      expect(getOnline()).toBe(false);

      // A genuine cache-bypassing success (an accepted non-GET) does clear it.
      reportFetchSuccess(/* cacheBypassing */ true);
      expect(getOnline()).toBe(true);
    });

    it('treats a non-GET trackedFetch success as cache-bypassing proof of liveness', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw netError();
        }),
      );
      setConnectivityProbeUrl(PROBE);
      reportFetchFailure(netError());
      expect(getOnline()).toBe(false);

      // A POST can't be a Workbox cache hit (runtime caching is GET-only), so an
      // accepted POST proves the origin was reached → clears the pill.
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
      await trackedFetch('/api/vote', { method: 'POST' });
      expect(getOnline()).toBe(true);
    });

    it('treats a GET with a status the SW may not cache as cache-bypassing proof', async () => {
      // Every runtimeCaching rule allows only statuses [0, 200], so a 404 GET
      // must have reached the origin.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw netError();
        }),
      );
      setConnectivityProbeUrl(PROBE);
      reportFetchFailure(netError());
      expect(getOnline()).toBe(false);

      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
      await trackedFetch('/api/whatever');
      expect(getOnline()).toBe(true);
    });

    it('still lets a bare GET success recover when no probe is configured (legacy)', async () => {
      // Unconfigured mode (tests / SSR): without a probe to confirm recovery we
      // must not get stuck offline, so a bare GET success clears the pill.
      reportFetchFailure(netError());
      expect(getOnline()).toBe(false);
      reportFetchSuccess();
      expect(getOnline()).toBe(true);
    });

    it('a probe failure that settles after newer success evidence does not re-latch offline', async () => {
      vi.useFakeTimers();
      const { fn, calls } = controlledFetch();
      vi.stubGlobal('fetch', fn);
      setConnectivityProbeUrl(PROBE);

      // Failure kicks the immediate probe; it hangs.
      reportFetchFailure(netError());
      await flush();
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(PROBE);

      // Newer evidence lands while the probe is still in flight: an accepted
      // non-GET proves we're reachable.
      reportFetchSuccess(/* cacheBypassing */ true);
      expect(getOnline()).toBe(true);

      // The stale probe now fails — it must NOT re-latch us offline.
      calls[0].reject(netError());
      await flush();
      expect(getOnline()).toBe(true);
    });

    it('self-heals via the recovery probe when the network returns', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async (): Promise<Response> => {
        throw netError();
      });
      vi.stubGlobal('fetch', fetchMock);
      setConnectivityProbeUrl(PROBE);

      reportFetchFailure(netError());
      await flush(); // immediate probe fails (call 1)
      expect(getOnline()).toBe(false);

      // First interval probe also fails (call 2) — still offline.
      await vi.advanceTimersByTimeAsync(RECOVERY_PROBE_INTERVAL_MS);
      expect(getOnline()).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // The backend is reachable again; the next interval probe confirms it and
      // clears the pill on its own (no app read needed).
      fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
      await vi.advanceTimersByTimeAsync(RECOVERY_PROBE_INTERVAL_MS);
      expect(getOnline()).toBe(true);
      expect(fetchMock).toHaveBeenLastCalledWith(
        PROBE,
        expect.objectContaining({ method: 'GET', cache: 'no-store' }),
      );

      // Once recovered, the timer stands down.
      await vi.advanceTimersByTimeAsync(RECOVERY_PROBE_INTERVAL_MS * 3);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('keeps re-probing while the network stays down, and a cache hit cannot stop it', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () => {
        throw netError();
      });
      vi.stubGlobal('fetch', fetchMock);
      setConnectivityProbeUrl(PROBE);

      reportFetchFailure(netError());
      await flush(); // immediate probe (call 1)

      // A cache hit can't clear the pill or cancel the probing.
      reportFetchSuccess(/* cacheBypassing */ false);
      expect(getOnline()).toBe(false);

      await vi.advanceTimersByTimeAsync(RECOVERY_PROBE_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(RECOVERY_PROBE_INTERVAL_MS);

      expect(getOnline()).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('does not run a recovery probe while the device itself reports offline', async () => {
      vi.useFakeTimers();
      setConnectivityProbeUrl(PROBE);
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      setNavigatorOnline(false);
      window.dispatchEvent(new Event('offline'));
      expect(getOnline()).toBe(false);

      await vi.advanceTimersByTimeAsync(RECOVERY_PROBE_INTERVAL_MS * 2);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("down (backend-unreachable): 5xx on the core data plane", () => {
    it('labels a core-read 5xx as down — reachable but erroring, not offline', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('oops', { status: 500 })),
      );
      setConnectivityProbeUrl(PROBE);

      await trackedFetch(CORE, undefined, { coreRead: true });

      expect(getConnectivityStatus()).toBe('down');
      // The offline boolean stays true: the device has a network and the
      // origin answered.
      expect(getOnline()).toBe(true);
      // But the query layer is paused so the struggling backend is never
      // retry-stormed.
      expect(onlineManager.isOnline()).toBe(false);
    });

    it('a 5xx from a non-critical endpoint must NOT flip the whole app', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('oops', { status: 500 })),
      );
      setConnectivityProbeUrl(PROBE);

      // Plain trackedFetch — summaries, search, telemetry: not the core data plane.
      await trackedFetch('/api/summary?id=1');

      expect(getConnectivityStatus()).toBe('online');
      expect(onlineManager.isOnline()).toBe(true);
    });

    it('a throw is the ABSENCE of a response — never blames the backend', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw netError();
        }),
      );

      await expect(
        trackedFetch(CORE, undefined, { coreRead: true }),
      ).rejects.toBeInstanceOf(TypeError);

      expect(getConnectivityStatus()).toBe('offline');
    });

    it('offline wins over down when both hold', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('oops', { status: 500 })),
      );
      await trackedFetch(CORE, undefined, { coreRead: true });
      expect(getConnectivityStatus()).toBe('down');

      window.dispatchEvent(new Event('offline'));
      expect(getConnectivityStatus()).toBe('offline');

      window.dispatchEvent(new Event('online'));
      expect(getConnectivityStatus()).toBe('down');
    });

    it('a cache-eligible core-read 200 cannot clear down — it may be the SW cache fallback', async () => {
      // NetworkFirst serves the cached 200 after its 6s window when the real
      // request times out, so a GET 200 proves nothing about the data plane.
      // Same lying-cache rule as the offline latch.
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('oops', { status: 500 }))
        .mockResolvedValueOnce(new Response('[]', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await trackedFetch(CORE, undefined, { coreRead: true });
      expect(getConnectivityStatus()).toBe('down');

      await trackedFetch(CORE, undefined, { coreRead: true });
      expect(getConnectivityStatus()).toBe('down');
    });

    it('a cache-bypassing core-read success clears down', async () => {
      // A status outside the SW's [0, 200] cacheable allowlist must have
      // reached the origin — and a non-5xx answer is the data plane speaking
      // without erroring.
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('oops', { status: 500 }))
        .mockResolvedValueOnce(new Response(null, { status: 404 }));
      vi.stubGlobal('fetch', fetchMock);

      await trackedFetch(CORE, undefined, { coreRead: true });
      expect(getConnectivityStatus()).toBe('down');

      await trackedFetch(CORE, undefined, { coreRead: true });
      expect(getConnectivityStatus()).toBe('online');
    });

    it('a core-read success that started before newer 5xx evidence cannot clear down', async () => {
      vi.useFakeTimers();
      const { fn, calls } = controlledFetch();
      vi.stubGlobal('fetch', fn);

      // Read A starts first (captures the pre-5xx baseline)…
      const a = trackedFetch(`${CORE}&a`, undefined, { coreRead: true });
      // …then read B starts and 500s.
      const b = trackedFetch(`${CORE}&b`, undefined, { coreRead: true });
      await flush();
      expect(calls).toHaveLength(2);
      calls[1].resolve(new Response('oops', { status: 500 }));
      await b;
      expect(getConnectivityStatus()).toBe('down');

      // A settles cache-bypassing (404 — would clear down if fresh) but after
      // B's newer 5xx evidence — reads may still be failing (a load balancer
      // with one bad instance flaps success/500), so the stale success must
      // not unpause reads.
      calls[0].resolve(new Response(null, { status: 404 }));
      await a;
      expect(getConnectivityStatus()).toBe('down');
    });

    it('the rate-bounded recovery probe clears down and unpauses reads', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () => new Response('oops', { status: 500 }));
      vi.stubGlobal('fetch', fetchMock);
      setConnectivityProbeUrl(PROBE);

      await trackedFetch(CORE, undefined, { coreRead: true });
      expect(getConnectivityStatus()).toBe('down');
      expect(onlineManager.isOnline()).toBe(false);

      // Health endpoint answers (any HTTP response counts — here a 200).
      fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
      await vi.advanceTimersByTimeAsync(RECOVERY_PROBE_INTERVAL_MS);

      expect(getConnectivityStatus()).toBe('online');
      expect(onlineManager.isOnline()).toBe(true);
    });

    it('a probe on browser reconnect clears down without waiting out the 30s interval', async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('oops', { status: 500 }))
        .mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      setConnectivityProbeUrl(PROBE);

      await trackedFetch(CORE, undefined, { coreRead: true });
      expect(getConnectivityStatus()).toBe('down');

      // Ride into a tunnel while the backend is down…
      setNavigatorOnline(false);
      window.dispatchEvent(new Event('offline'));
      expect(getConnectivityStatus()).toBe('offline');

      // …and reconnect. `backendDown` is latched with awaitingLiveness false
      // (the 5xx was a successful fetch), so without the reconnect probe the
      // Down pill and paused queries would linger until the next interval
      // tick. Reconnect is rare and user-salient — its probe may clear down.
      setNavigatorOnline(true);
      window.dispatchEvent(new Event('online'));
      await flush();
      expect(getConnectivityStatus()).toBe('online');
      expect(onlineManager.isOnline()).toBe(true);
    });

    it('a probe on focus regain clears down (rare, user-salient)', async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('oops', { status: 500 }))
        .mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      setConnectivityProbeUrl(PROBE);

      await trackedFetch(CORE, undefined, { coreRead: true });
      expect(getConnectivityStatus()).toBe('down');

      window.dispatchEvent(new Event('focus'));
      await flush();
      expect(getConnectivityStatus()).toBe('online');
    });

    it('a probe SUCCESS that settles after newer 5xx evidence must not clear down', async () => {
      vi.useFakeTimers();
      const { fn, calls } = controlledFetch();
      vi.stubGlobal('fetch', fn);
      setConnectivityProbeUrl(PROBE);

      // Enter down.
      const first = trackedFetch(CORE, undefined, { coreRead: true });
      await flush();
      calls[0].resolve(new Response('oops', { status: 500 }));
      await first;
      expect(getConnectivityStatus()).toBe('down');

      // Recovery probe fires and hangs.
      await vi.advanceTimersByTimeAsync(RECOVERY_PROBE_INTERVAL_MS);
      const probeCall = calls.find((c) => c.url === PROBE);
      expect(probeCall).toBeDefined();

      // Newer 5xx evidence lands mid-probe.
      const second = trackedFetch(`${CORE}&again`, undefined, { coreRead: true });
      await flush();
      const reads = calls.filter((c) => c.url !== PROBE);
      reads[reads.length - 1].resolve(new Response('oops', { status: 500 }));
      await second;

      // The probe now succeeds — but health-up ≠ reads-up, and its evidence
      // predates the 5xx. Down must survive, or every slow-500 read's probe
      // would unpause the query layer against a failing backend.
      probeCall!.resolve(new Response(null, { status: 200 }));
      await flush();
      expect(getConnectivityStatus()).toBe('down');
    });

    it('emits down transitions to status subscribers', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('oops', { status: 500 }))
        // 404 = cache-bypassing, non-5xx → clears down (a 200 would be
        // ambiguous; see the SW-cache-fallback test above).
        .mockResolvedValueOnce(new Response(null, { status: 404 }));
      vi.stubGlobal('fetch', fetchMock);

      const events: string[] = [];
      subscribeConnectivityStatus((s) => events.push(s));

      await trackedFetch(CORE, undefined, { coreRead: true });
      await trackedFetch(CORE, undefined, { coreRead: true });

      expect(events).toEqual(['down', 'online']);
    });
  });

  describe('read cap + timeout ambiguity', () => {
    it('a timeout alone never flips the status when no probe is configured', async () => {
      vi.useFakeTimers();
      const { fn, calls } = controlledFetch();
      vi.stubGlobal('fetch', fn);

      const read = trackedFetch(CORE, undefined, { coreRead: true });
      const rejection = expect(read).rejects.toMatchObject({
        name: 'TimeoutError',
      });
      await vi.advanceTimersByTimeAsync(CORE_READ_TIMEOUT_MS);
      await rejection;

      // Ambiguous — the device may be offline or the backend merely slow.
      // Without a probe to disambiguate, we must not guess.
      expect(getConnectivityStatus()).toBe('online');
      expect(calls).toHaveLength(1); // just the read, no probe
    });

    it('hedges a slow read at 3s: the probe fires in parallel and its failure flips us offline in ~hedge + probe', async () => {
      vi.useFakeTimers();
      const { fn, calls } = controlledFetch();
      vi.stubGlobal('fetch', fn);
      setConnectivityProbeUrl(PROBE);

      // Lie-fi: the read hangs rather than fails.
      const read = trackedFetch(CORE, undefined, { coreRead: true });
      const rejection = expect(read).rejects.toMatchObject({
        name: 'TimeoutError',
      });

      // Nothing yet before the hedge point…
      await vi.advanceTimersByTimeAsync(CORE_READ_HEDGE_DELAY_MS - 1);
      expect(calls).toHaveLength(1);
      // …then the hedge fires the probe in parallel with the hanging read.
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(2);
      expect(calls[1].url).toBe(PROBE);
      expect(getConnectivityStatus()).toBe('online'); // no verdict yet

      // The probe also hangs and aborts at its own 5s timeout → genuinely
      // offline at ~hedge + probe (8s), well before cap + probe (~13s).
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
      expect(getConnectivityStatus()).toBe('offline');
      await rejection; // the read itself dies at the cap
    });

    it("a hedge probe that reaches the backend changes nothing and the read keeps its full cap", async () => {
      vi.useFakeTimers();
      const { fn, calls } = controlledFetch();
      vi.stubGlobal('fetch', fn);
      setConnectivityProbeUrl(PROBE);

      const read = trackedFetch(CORE, undefined, { coreRead: true });
      await vi.advanceTimersByTimeAsync(CORE_READ_HEDGE_DELAY_MS);
      expect(calls).toHaveLength(2);
      calls[1].resolve(new Response(null, { status: 200 }));
      await flush();
      expect(getConnectivityStatus()).toBe('online');

      // The read is still allowed its full window and can succeed late.
      await vi.advanceTimersByTimeAsync(CORE_READ_TIMEOUT_MS - CORE_READ_HEDGE_DELAY_MS - 1);
      calls[0].resolve(new Response('[]', { status: 200 }));
      await expect(read).resolves.toBeInstanceOf(Response);
      expect(getConnectivityStatus()).toBe('online');
    });

    it('skips the timeout probe when the hedge probe already proved reachability', async () => {
      vi.useFakeTimers();
      const { fn, calls } = controlledFetch();
      vi.stubGlobal('fetch', fn);
      setConnectivityProbeUrl(PROBE);

      const read = trackedFetch(CORE, undefined, { coreRead: true });
      const rejection = expect(read).rejects.toMatchObject({
        name: 'TimeoutError',
      });
      await vi.advanceTimersByTimeAsync(CORE_READ_HEDGE_DELAY_MS);
      calls[1].resolve(new Response(null, { status: 200 })); // hedge probe answers
      await vi.advanceTimersByTimeAsync(
        CORE_READ_TIMEOUT_MS - CORE_READ_HEDGE_DELAY_MS,
      );
      await rejection;

      // Fresh cache-bypassing proof already landed since the read started, so
      // the timeout fires no second probe.
      expect(calls).toHaveLength(2);
      expect(getConnectivityStatus()).toBe('online');
    });

    it('a probe answering 4xx/5xx still proves reachability — stay online on a timed-out read', async () => {
      vi.useFakeTimers();
      const { fn, calls } = controlledFetch();
      vi.stubGlobal('fetch', fn);
      setConnectivityProbeUrl(PROBE);

      const read = trackedFetch(CORE, undefined, { coreRead: true });
      const rejection = expect(read).rejects.toMatchObject({
        name: 'TimeoutError',
      });
      await vi.advanceTimersByTimeAsync(CORE_READ_HEDGE_DELAY_MS);
      // Even a 500 from the health endpoint proves we reached a server — and
      // a non-core 5xx must not flip us down either.
      calls[1].resolve(new Response('oops', { status: 500 }));
      await vi.advanceTimersByTimeAsync(
        CORE_READ_TIMEOUT_MS - CORE_READ_HEDGE_DELAY_MS,
      );
      await rejection;

      expect(getConnectivityStatus()).toBe('online');
    });

    it('does not cap or hedge writes/auth — only core reads', async () => {
      vi.useFakeTimers();
      const { fn, calls } = controlledFetch();
      vi.stubGlobal('fetch', fn);
      setConnectivityProbeUrl(PROBE);

      // A vote (write) and a login (auth) hang far past hedge and cap.
      const vote = trackedFetch('/api/vote', { method: 'POST' });
      const login = trackedFetch('/api/login', { method: 'POST' });
      await vi.advanceTimersByTimeAsync(CORE_READ_TIMEOUT_MS * 2);

      // No hedge probes fired, no timeout aborts — both still pending.
      expect(calls).toHaveLength(2);
      expect(calls.every((c) => c.url !== PROBE)).toBe(true);
      expect(getConnectivityStatus()).toBe('online');

      calls[0].resolve(new Response('{}', { status: 200 }));
      calls[1].resolve(new Response('{}', { status: 200 }));
      await vote;
      await login;
    });

    it('a caller abort on a capped read is not a connectivity signal', async () => {
      vi.useFakeTimers();
      const { fn } = controlledFetch();
      vi.stubGlobal('fetch', fn);

      const controller = new AbortController();
      const read = trackedFetch(CORE, { signal: controller.signal }, { coreRead: true });
      const rejection = expect(read).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort();
      await rejection;

      expect(getConnectivityStatus()).toBe('online');
    });
  });

  describe("Network Information API ('change' is a trigger, never truth)", () => {
    let connection: EventTarget;

    beforeEach(() => {
      connection = new EventTarget();
      Object.defineProperty(window.navigator, 'connection', {
        configurable: true,
        value: connection,
      });
      _resetNetworkStatusForTests(); // re-wires the listener onto the stub
    });
    afterEach(() => {
      delete (window.navigator as Navigator & { connection?: unknown })
        .connection;
      _resetNetworkStatusForTests();
    });

    it('probes on a connection change and believes only the probe outcome (failure → offline)', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () => {
        throw netError();
      });
      vi.stubGlobal('fetch', fetchMock);
      setConnectivityProbeUrl(PROBE);

      // Nothing in flight, riding into a tunnel: without this trigger the app
      // wouldn't notice until the next user action.
      connection.dispatchEvent(new Event('change'));
      await flush();

      expect(fetchMock).toHaveBeenCalledWith(
        PROBE,
        expect.objectContaining({ method: 'GET', cache: 'no-store' }),
      );
      expect(getConnectivityStatus()).toBe('offline');
    });

    it('a connection change with a healthy probe changes nothing', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      setConnectivityProbeUrl(PROBE);

      connection.dispatchEvent(new Event('change'));
      await flush();

      expect(getConnectivityStatus()).toBe('online');
    });

    it('coalesces a burst of change events to one probe in flight', async () => {
      vi.useFakeTimers();
      const { fn, calls } = controlledFetch();
      vi.stubGlobal('fetch', fn);
      setConnectivityProbeUrl(PROBE);

      connection.dispatchEvent(new Event('change'));
      connection.dispatchEvent(new Event('change'));
      connection.dispatchEvent(new Event('change'));
      await flush();

      expect(calls).toHaveLength(1);
      calls[0].resolve(new Response(null, { status: 200 }));
      await flush();
    });

    it('skips probing while the device already reports offline', async () => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      setConnectivityProbeUrl(PROBE);

      setNavigatorOnline(false);
      window.dispatchEvent(new Event('offline'));
      connection.dispatchEvent(new Event('change'));

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a connection-change probe success must never clear down (machine-chatty trigger)', async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('oops', { status: 500 }))
        .mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      setConnectivityProbeUrl(PROBE);

      await trackedFetch(CORE, undefined, { coreRead: true });
      expect(getConnectivityStatus()).toBe('down');

      // Chrome fires 'change' on mere downlink/RTT estimate shifts — if this
      // could clear down, the query layer would unpause on noise.
      connection.dispatchEvent(new Event('change'));
      await flush();
      expect(getConnectivityStatus()).toBe('down');
    });

    it('a hedge probe success must never clear down either', async () => {
      vi.useFakeTimers();
      const { fn, calls } = controlledFetch();
      vi.stubGlobal('fetch', fn);
      setConnectivityProbeUrl(PROBE);

      // Enter down.
      const first = trackedFetch(CORE, undefined, { coreRead: true });
      await flush();
      calls[0].resolve(new Response('oops', { status: 500 }));
      await first;
      expect(getConnectivityStatus()).toBe('down');

      // A second read hangs; its hedge probe succeeds — health-up ≠ reads-up.
      const second = trackedFetch(`${CORE}&again`, undefined, { coreRead: true });
      await vi.advanceTimersByTimeAsync(CORE_READ_HEDGE_DELAY_MS);
      const probeCall = calls.find((c) => c.url === PROBE);
      expect(probeCall).toBeDefined();
      probeCall!.resolve(new Response(null, { status: 200 }));
      await flush();
      expect(getConnectivityStatus()).toBe('down');

      calls[1].resolve(new Response('[]', { status: 200 }));
      await second;
    });
  });

  describe('retryable-error classification', () => {
    it('retries only statusless network blips, never responses with an HTTP status', () => {
      expect(isRetryableFetchError(new TypeError('Failed to fetch'))).toBe(true);
      expect(
        isRetryableFetchError(new Error('Network request failed')),
      ).toBe(true);
      expect(
        isRetryableFetchError(new DOMException('timed out', 'TimeoutError')),
      ).toBe(true);
      // An HTTP response reached us — re-asking won't change a 4xx and
      // retrying a 5xx storms a struggling backend.
      expect(isRetryableFetchError(new Error('HN API 500: /x'))).toBe(false);
      expect(isRetryableFetchError(new Error('items API 404'))).toBe(false);
      // A caller cancelling says nothing about connectivity.
      expect(
        isRetryableFetchError(new DOMException('aborted', 'AbortError')),
      ).toBe(false);
    });
  });

  describe('React Query integration (offlineFirst + retry)', () => {
    it('recovers a transient trackedFetch failure instead of wedging the query paused (no probe)', async () => {
      // End-to-end reproduction of the home-page "loading forever, empty
      // cells" bug. With networkMode 'offlineFirst' the first attempt
      // fires; feeding fetch evidence into onlineManager without a probe
      // configured would pause the retry with nothing to ever resume it.
      // In unconfigured mode onlineManager tracks the browser signal only,
      // so the retry runs and the query resolves.
      const { QueryClient } = await import('@tanstack/react-query');

      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(netError())
        .mockResolvedValueOnce(
          new Response(JSON.stringify([1, 2, 3]), { status: 200 }),
        );
      vi.stubGlobal('fetch', fetchMock);

      const client = new QueryClient({
        defaultOptions: {
          queries: { networkMode: 'offlineFirst', retry: 1, retryDelay: 0 },
        },
      });

      const result = await client.fetchQuery({
        queryKey: ['storyIds', 'top'],
        queryFn: async () => {
          const res = await trackedFetch('https://example.test/topstories.json');
          return (await res.json()) as number[];
        },
      });

      expect(result).toEqual([1, 2, 3]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      client.clear();
    });

    it('never retries a 5xx: one request, then down + paused (no retry storm)', async () => {
      const { QueryClient } = await import('@tanstack/react-query');

      const fetchMock = vi.fn(async () => new Response('oops', { status: 500 }));
      vi.stubGlobal('fetch', fetchMock);
      setConnectivityProbeUrl(PROBE);

      const client = new QueryClient({
        defaultOptions: {
          queries: {
            networkMode: 'offlineFirst',
            // Mirrors the app-wide default in main.tsx.
            retry: (failureCount, error) =>
              failureCount < 1 && isRetryableFetchError(error),
            retryDelay: 0,
          },
        },
      });

      await expect(
        client.fetchQuery({
          queryKey: ['feedItems', 'top'],
          queryFn: async () => {
            const res = await trackedFetch(CORE, undefined, { coreRead: true });
            if (!res.ok) throw new Error(`items API ${res.status}`);
            return res.json();
          },
        }),
      ).rejects.toThrow('items API 500');

      // Exactly one request — the 500 carried an HTTP status, so no retry.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(getConnectivityStatus()).toBe('down');
      expect(onlineManager.isOnline()).toBe(false);
      client.clear();
    });
  });
});
