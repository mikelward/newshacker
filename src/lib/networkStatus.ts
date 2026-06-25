import { onlineManager } from '@tanstack/react-query';

// `navigator.onLine` on mobile lags badly behind what users perceive as
// "offline" — stepping into a tunnel can leave it stuck at `true` for
// tens of seconds, because the OS only flips it once the radio has
// fully given up. We can do better: every fetch the app makes is a
// probe for whether we can reach the network right now. Route those
// through this tracker so the offline indicator reacts the instant a
// real request fails, instead of waiting for the OS to notice.
//
// We keep two independent signals and AND them: either one reporting
// offline means offline. That way a successful SW-served fetch while
// the browser says offline doesn't falsely flip the pill back on, and
// a spurious navigator.onLine=true while every real request is failing
// doesn't either. Both have to agree "online" before we consider
// ourselves online.

type Listener = (online: boolean) => void;

function initialBrowserOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  // `navigator.onLine` is `undefined` under the node test environment
  // (navigator exists, the property doesn't). Treat anything that isn't
  // an explicit `false` as online so we never feed `undefined` into
  // `onlineManager.setOnline`, which would pause every query.
  return navigator.onLine !== false;
}

let browserOnline: boolean = initialBrowserOnline();
let fetchOnline: boolean = true;

let lastEmitted: boolean = browserOnline && fetchOnline;
const listeners = new Set<Listener>();

function combined(): boolean {
  return browserOnline && fetchOnline;
}

function emitIfChanged() {
  const next = combined();
  if (next === lastEmitted) return;
  lastEmitted = next;
  for (const fn of listeners) fn(next);
}

// React Query's onlineManager gates retry/pause behavior, and with
// `networkMode: 'offlineFirst'` a query that fails its first attempt
// has its *retries* paused while onlineManager reports offline. We
// deliberately drive onlineManager from the *browser* signal only —
// NOT the combined fetch-failure signal.
//
// Why: `fetchOnline` flips false the instant a single request throws a
// TypeError (a flaky radio, one slow Firebase read on open). If that
// fed onlineManager, the retry that would have recovered the blip gets
// paused — and because `navigator.onLine` never actually flipped in
// that case, there's no browser 'online' event to ever un-pause it. The
// feed wedges on the loading skeleton until a manual refresh. The
// browser signal, by contrast, always has a matching 'online' event to
// resume on, so pausing on it is safe. Transient fetch failures are
// left to React Query's own retry/backoff, which is exactly what
// recovers them. The header pill still reacts to fetch failures via the
// combined signal above — that's UI-only and doesn't pause queries.
function syncOnlineManager() {
  onlineManager.setOnline(browserOnline);
}

// --- Liveness probe (stops the "offline ↔ online" flapping) ---------------
//
// A Workbox-cache-served GET that resolves looks like a successful fetch, so
// `trackedFetch` reports it as success and flips us back "online" — even while
// the device is genuinely offline. Reads (e.g. /api/summary, NetworkFirst) then
// bounce the pill online↔offline on every cache hit. To stop that we keep an
// explicit "awaiting liveness" flag: once a real request fails, only a
// *cache-bypassing* success may clear it — a non-GET the server accepted, or a
// liveness probe that reached an endpoint the SW never caches.
//
// The probe URL is injected by the app at boot (`setConnectivityProbeUrl`); we
// use `/api/me`, a dependency-free origin-reachability check (reads the session
// cookie, no Redis/HN round-trip) that is NOT in the service worker's
// runtimeCaching, so Workbox always lets it hit the network (and we add
// `cache: 'no-store'` for the HTTP cache). Unset (tests / SSR) → no probing, and
// a bare GET success clears the pill as before, so we can never get stuck offline.
let probeUrl: string | null = null;
// True once a request has failed and we haven't re-confirmed reachability with a
// cache-bypassing success. While set (and a probe is configured), an ambiguous
// (cache-eligible GET) success can't clear the pill — that's the flap fix.
let awaitingLiveness = false;
// Bumped on every cache-bypassing success (probe success, or an accepted
// non-GET). A probe failure only flips us offline if no such success landed
// since it started, so an overlapping stale probe can't relatch us offline.
let livenessSeq = 0;
const PROBE_TIMEOUT_MS = 5_000;
// Once offline, no app read fires to notice recovery (a user reading cached
// content issues none), so we re-probe on an interval until a cache-bypassing
// success confirms we're back. Cheap: one tiny GET every 30s, only while in
// doubt — and while genuinely offline it fails without ever reaching the server.
const RECOVERY_PROBE_INTERVAL_MS = 30_000;
let recoveryTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Register the liveness-probe endpoint (called by the app at boot). Pass `null`
 * to disable probing (tests / SSR), in which case a bare GET success clears the
 * offline pill as before.
 */
export function setConnectivityProbeUrl(u: string | null) {
  probeUrl = u;
}

export function getOnline(): boolean {
  return combined();
}

export function subscribeOnline(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Report a successful fetch. `cacheBypassing` marks responses that prove the
 * backend was genuinely reachable — i.e. cannot have been served from the
 * Workbox cache (a non-GET request, or the liveness probe). Only those may clear
 * the offline pill once we're awaiting liveness confirmation.
 */
export function reportFetchSuccess(cacheBypassing = false) {
  if (cacheBypassing) {
    livenessSeq++;
    awaitingLiveness = false;
    updateRecoveryProbe();
  }
  if (fetchOnline) return;
  // While awaiting liveness confirmation (and a probe is configured to provide
  // it), a plain GET success may be a Workbox cache hit that proves nothing —
  // don't let it flap us back online. Only a cache-bypassing success (above)
  // clears it. In unconfigured mode (no probe) we keep the legacy behavior so we
  // can't get stuck offline.
  if (!cacheBypassing && awaitingLiveness && probeUrl != null) return;
  fetchOnline = true;
  emitIfChanged();
}

export function reportFetchFailure(err: unknown) {
  if (!isNetworkError(err)) return;
  goOffline();
}

function goOffline() {
  // A failure means we can no longer trust the network is reachable — start (or
  // keep) re-probing until a cache-bypassing success proves otherwise.
  awaitingLiveness = true;
  updateRecoveryProbe();
  if (!fetchOnline) return;
  fetchOnline = false;
  emitIfChanged();
}

/**
 * Actively confirm the backend is reachable right now, bypassing the service
 * worker (`/api/status` isn't in runtimeCaching, plus `cache: 'no-store'`). Any
 * HTTP response — even a 4xx/5xx — proves we reached a server. A failure flips us
 * offline unless a cache-bypassing success landed since this probe started (which
 * makes the failure stale). Returns true iff the backend answered. Unconfigured
 * (no probe URL) returns true.
 */
async function confirmBackendReachable(): Promise<boolean> {
  if (probeUrl == null) return true;
  const baselineSeq = livenessSeq;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(probeUrl, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    reportFetchSuccess(/* cacheBypassing */ true);
    return true;
  } catch {
    if (livenessSeq === baselineSeq) goOffline();
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Run the recovery probe exactly while we're awaiting liveness, the device
 * itself is online (no point probing when the radio is down — that's the user's
 * fix), and a probe endpoint is configured. Idempotent. */
function updateRecoveryProbe() {
  if (awaitingLiveness && browserOnline && probeUrl != null) startRecoveryProbe();
  else stopRecoveryProbe();
}

function startRecoveryProbe() {
  if (recoveryTimer != null) return;
  recoveryTimer = setInterval(() => {
    void confirmBackendReachable();
  }, RECOVERY_PROBE_INTERVAL_MS);
}

function stopRecoveryProbe() {
  if (recoveryTimer == null) return;
  clearInterval(recoveryTimer);
  recoveryTimer = null;
}

/** Returning focus to a tab is the moment to re-check — probe at once rather than
 * waiting out the interval. No-op unless we're awaiting liveness and the device
 * claims a connection. */
function handleRegainedFocus() {
  if (!awaitingLiveness || !browserOnline) return;
  void confirmBackendReachable();
}

function isNetworkError(err: unknown): boolean {
  // AbortError is a caller cancelling the request (React Query does
  // this when a query is superseded), not a signal about connectivity.
  if (err instanceof DOMException && err.name === 'AbortError') return false;
  if (err instanceof Error && err.name === 'AbortError') return false;
  if (err instanceof DOMException && err.name === 'NetworkError') return true;
  // fetch throws TypeError for all network-layer failures: DNS,
  // unreachable host, dropped connection, CORS preflight fail. Some
  // runtimes surface the same failures as DOMException/Error names or
  // messages instead, so match the common cross-browser strings too.
  // Any of those reasonably mean "not online right now".
  if (err instanceof TypeError) return true;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes('failed to fetch') ||
      msg.includes('fetch failed') ||
      msg.includes('load failed') ||
      msg.includes('networkerror') ||
      msg.includes('network request failed') ||
      msg.includes('network connection was lost') ||
      msg.includes('internet connection appears to be offline')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The request method, across the `Request | string | URL` + init shapes fetch
 * accepts. Used only to tell cache-eligible GETs from cache-bypassing requests.
 */
function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

export async function trackedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    const res = await fetch(input, init);
    // Any HTTP response — even a 500 — proves we reached a server, so
    // treat it as evidence the fetch side is healthy. The browser may
    // still disagree (e.g. just after firing an 'offline' event while
    // the SW served a cache hit), and in that case we stay offline
    // until both signals line up. A non-GET response additionally counts as
    // cache-bypassing liveness proof (Workbox runtime caching is GET-only, so a
    // POST always reached the origin); a GET might be a cache hit, so it isn't
    // trusted as liveness evidence — that's what the probe is for.
    reportFetchSuccess(methodOf(input, init) !== 'GET');
    return res;
  } catch (err) {
    reportFetchFailure(err);
    throw err;
  }
}

function handleBrowserOnline() {
  if (browserOnline) return;
  browserOnline = true;
  // Reconnecting while still awaiting liveness resumes the probe (it was idle
  // while the device was offline).
  updateRecoveryProbe();
  syncOnlineManager();
  emitIfChanged();
}

function handleBrowserOffline() {
  if (!browserOnline) return;
  browserOnline = false;
  // Device offline → "find a connection" is the user's fix; stand down the probe
  // until the radio is back.
  updateRecoveryProbe();
  syncOnlineManager();
  emitIfChanged();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', handleBrowserOnline);
  window.addEventListener('offline', handleBrowserOffline);
  // Returning to a tab that's showing offline re-checks reachability at once.
  window.addEventListener('focus', handleRegainedFocus);
  syncOnlineManager();
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') handleRegainedFocus();
  });
}

// Tests need to rehydrate module state after overriding
// navigator.onLine or clearing listeners between cases.
export function _resetNetworkStatusForTests() {
  listeners.clear();
  stopRecoveryProbe();
  browserOnline = initialBrowserOnline();
  fetchOnline = true;
  lastEmitted = combined();
  probeUrl = null;
  awaitingLiveness = false;
  livenessSeq = 0;
  syncOnlineManager();
}
