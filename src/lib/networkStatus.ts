import { onlineManager } from '@tanstack/react-query';

// `navigator.onLine` on mobile lags badly behind what users perceive as
// "offline" — stepping into a tunnel can leave it stuck at `true` for
// tens of seconds (sometimes it never flips, and it can flicker),
// because the OS only updates it once the radio has fully given up. We
// can do better: every fetch the app makes is a probe for whether we
// can reach the network right now. Route those through this tracker so
// the offline indicator reacts the instant a real request fails,
// instead of waiting for the OS to notice.
//
// We keep two independent signals and AND them: either one reporting
// offline means offline; both must agree before we show online. The OS
// signal may only make us MORE pessimistic — it can never prove we're
// online. That way a successful SW-served fetch while the browser says
// offline doesn't falsely flip the pill back on, and a spurious
// navigator.onLine=true while every real request is failing doesn't
// either.
//
// On top of the offline axis we track a third state, `down`
// (backend-unreachable): the backend answered a **5xx on the core data
// plane** — proof it is reachable but erroring. A thrown fetch is the
// ABSENCE of a response and never blames the backend (that's
// `offline`); a 5xx from a non-critical endpoint (summaries, telemetry)
// never flips the whole app.
export type ConnectivityStatus = 'online' | 'offline' | 'down';

type StatusListener = (status: ConnectivityStatus) => void;

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
// The backend answered a 5xx on the core data plane: reachable but erroring.
// Independent of the offline axis — see `currentStatus`.
let backendDown = false;

const listeners = new Set<StatusListener>();

function currentStatus(): ConnectivityStatus {
  // Offline wins: a device with no network can't tell whether the backend is
  // erroring, and "you are offline" is the actionable message.
  if (!browserOnline || !fetchOnline) return 'offline';
  return backendDown ? 'down' : 'online';
}

let lastEmitted: ConnectivityStatus = currentStatus();

/** Re-sync onlineManager and notify listeners iff the status changed. Every
 * state mutation funnels through here. */
function update() {
  syncOnlineManager();
  const next = currentStatus();
  if (next === lastEmitted) return;
  lastEmitted = next;
  for (const fn of listeners) fn(next);
}

// React Query's onlineManager gates retry/pause behavior: with
// `networkMode: 'offlineFirst'` a query that fails its first attempt has its
// *retries* paused while onlineManager reports offline.
//
// While we are not fully online — offline by evidence OR the backend is down —
// we pause the query layer so a struggling backend is never retry-stormed.
// Pausing on evidence is only safe because the probe machinery guarantees a
// resume path that needs no app traffic: an immediate probe on the offline
// transition, the 30s recovery interval, focus/visibility probes, and browser
// 'online' events. Without a configured probe (tests / SSR) that guarantee is
// gone — a paused retry could wedge forever, since no fetch runs while paused
// so nothing could ever clear the latch — so we fall back to pausing on the
// browser signal only, which always has a matching 'online' event to resume on.
function syncOnlineManager() {
  onlineManager.setOnline(
    probeUrl != null ? currentStatus() === 'online' : browserOnline,
  );
}

// --- Liveness probe (stops the "offline ↔ online" flapping) ---------------
//
// Service-worker cache hits lie: a Workbox-cache-served GET that resolves looks
// like a successful fetch, so `trackedFetch` would report it as success and flip
// us back "online" — even while the device is genuinely offline. Reads then
// bounce the pill online↔offline on every cache hit while riding a tunnel with
// a warm cache. To stop that we keep an explicit "awaiting liveness" latch:
// once a real request fails, only a *cache-bypassing* success may clear it — a
// non-GET the server accepted (the Cache API is GET-only), a response with a
// status the SW is not allowed to cache, or a liveness probe that reached an
// endpoint the SW never caches.
//
// The probe URL is injected by the app at boot (`setConnectivityProbeUrl`); we
// use `/api/me`, a dependency-free origin-reachability check (reads the session
// cookie, no Redis/HN round-trip — never touches a database, so it stays up
// while the data plane fails) that is NOT in the service worker's
// runtimeCaching, so Workbox always lets it hit the network (and we add
// `cache: 'no-store'` for the HTTP cache). Any HTTP response — even a 4xx/5xx —
// proves reachability. Unset (tests / SSR) → no probing, and a bare GET success
// clears the pill as before, so we can never get stuck offline.
let probeUrl: string | null = null;
// True once a request has failed and we haven't re-confirmed reachability with a
// cache-bypassing success. While set (and a probe is configured), an ambiguous
// (cache-eligible GET) success can't clear the pill — that's the flap fix.
let awaitingLiveness = false;
// Bumped on every cache-bypassing success (probe success, an accepted non-GET,
// or a non-cacheable-status response). A probe failure only flips us offline if
// no such success landed since it started, so an overlapping stale probe can't
// relatch us offline.
let livenessSeq = 0;
// Bumped on every core-data-plane 5xx. Stale-guards `down` in both directions:
// a probe success that started before newer 5xx evidence landed must not clear
// the down state (health-up ≠ reads-up — the health endpoint stays up while the
// data plane fails), and a core-read success that started before newer 5xx
// evidence must not either.
let downSeq = 0;
// Bumped by `_resetNetworkStatusForTests` so fire-and-forget probes started in
// a previous test can never mutate the freshly-reset state when they settle.
let generation = 0;

export const PROBE_TIMEOUT_MS = 5_000;
// Once offline (or down), no app read fires to notice recovery — the query
// layer is paused and a user reading cached content issues nothing — so we
// re-probe on an interval until a cache-bypassing success confirms we're back.
// Cheap: one tiny GET every 30s, only while in doubt — and while genuinely
// offline it fails without ever reaching the server.
export const RECOVERY_PROBE_INTERVAL_MS = 30_000;
// Core reads are capped: past this we abort them with a TimeoutError. The cap
// sits just above the service worker's NetworkFirst cache-fallback window (6s,
// see vite.config.ts) so the SW gets its chance to answer from cache before we
// give up, and the hedge sits below both. Keep hedge < SW window < cap — the
// ordering is regression-guarded in vite.config.test.ts.
export const CORE_READ_TIMEOUT_MS = 8_000;
// Lie-fi (bars at zero, radio not given up) makes requests hang rather than
// fail, so without a hedge the first offline evidence waits out cap + probe
// (~13s). Hedging at 3s means the pill flips in ~hedge + probe (~8s) instead.
export const CORE_READ_HEDGE_DELAY_MS = 3_000;

let recoveryTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Register the liveness-probe endpoint (called by the app at boot). Pass `null`
 * to disable probing (tests / SSR), in which case a bare GET success clears the
 * offline pill as before and onlineManager tracks the browser signal only.
 */
export function setConnectivityProbeUrl(u: string | null) {
  probeUrl = u;
  update();
}

/** Back-compat boolean: are we NOT offline? `down` still reports true here —
 * the device has a network and the origin is reachable; only the data plane is
 * erroring. Use `getConnectivityStatus` when the distinction matters. */
export function getOnline(): boolean {
  return browserOnline && fetchOnline;
}

export function getConnectivityStatus(): ConnectivityStatus {
  return currentStatus();
}

export function subscribeConnectivityStatus(fn: StatusListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Boolean adapter over `subscribeConnectivityStatus`: notifies only when the
 * offline boolean actually changes (an online↔down transition is invisible). */
export function subscribeOnline(fn: (online: boolean) => void): () => void {
  let last = getOnline();
  return subscribeConnectivityStatus(() => {
    const now = getOnline();
    if (now === last) return;
    last = now;
    fn(now);
  });
}

/**
 * Report a successful fetch. `cacheBypassing` marks responses that prove the
 * backend was genuinely reachable — i.e. cannot have been served from the
 * Workbox cache (a non-GET request, a status the SW may not cache, or the
 * liveness probe). Only those may clear the offline pill once we're awaiting
 * liveness confirmation.
 */
export function reportFetchSuccess(cacheBypassing = false) {
  if (cacheBypassing) {
    livenessSeq++;
    awaitingLiveness = false;
    updateRecoveryProbe();
  }
  if (fetchOnline) {
    update();
    return;
  }
  // While awaiting liveness confirmation (and a probe is configured to provide
  // it), a plain GET success may be a Workbox cache hit that proves nothing —
  // don't let it flap us back online. Only a cache-bypassing success (above)
  // clears it. In unconfigured mode (no probe) we keep the legacy behavior so we
  // can't get stuck offline.
  if (!cacheBypassing && awaitingLiveness && probeUrl != null) return;
  fetchOnline = true;
  update();
}

export function reportFetchFailure(err: unknown) {
  if (!isNetworkError(err)) return;
  goOffline();
}

function goOffline(fromProbe = false) {
  // A failure means we can no longer trust the network is reachable — start (or
  // keep) re-probing until a cache-bypassing success proves otherwise.
  awaitingLiveness = true;
  updateRecoveryProbe();
  const transitioned = fetchOnline;
  fetchOnline = false;
  // A transient blip (one flaky radio hiccup) and a real dead zone look
  // identical at the moment of failure — and since going offline pauses the
  // query layer, no app traffic will disambiguate them. Ask the probe right
  // away: a blip recovers in ~one round trip instead of waiting out the 30s
  // interval. Probe failures must not re-kick (the recovery interval owns
  // retries) or a dead network would loop probes back-to-back.
  if (transitioned && !fromProbe && browserOnline && probeUrl != null) {
    void runProbe(false);
  }
  update();
}

// --- Down (backend-unreachable) --------------------------------------------

function reportCoreReadServerError() {
  downSeq++;
  if (backendDown) return;
  backendDown = true;
  updateRecoveryProbe();
  update();
}

/** Clear `down` only if no newer 5xx evidence landed since `baselineDown` was
 * captured — a success that raced a fresher failure is stale (rule: never let
 * an out-of-order success unpause reads against a failing backend). */
function clearBackendDown(baselineDown: number) {
  if (!backendDown || downSeq !== baselineDown) return;
  backendDown = false;
  updateRecoveryProbe();
  update();
}

// --- Probe machinery --------------------------------------------------------

let probeInFlight: Promise<boolean> | null = null;

/**
 * Fire (or join) the liveness probe. Coalesces: while one probe is in flight,
 * every additional trigger — a connection-change burst, a second hedged read —
 * returns the same promise instead of stacking requests.
 *
 * `mayClearDown` is true only for the deliberately rate-bounded re-tests (the
 * 30s recovery interval and focus/visibility regain). Machine-chatty triggers
 * (hedges, connection-change events, the offline-transition kick) must never
 * clear `down`: Chrome fires connection 'change' on mere downlink/RTT estimate
 * shifts, and health-up ≠ reads-up.
 */
function runProbe(mayClearDown: boolean): Promise<boolean> {
  if (probeUrl == null) return Promise.resolve(true);
  if (probeInFlight != null) return probeInFlight;
  const p = probe(probeUrl, mayClearDown).finally(() => {
    if (probeInFlight === p) probeInFlight = null;
  });
  probeInFlight = p;
  return p;
}

async function probe(url: string, mayClearDown: boolean): Promise<boolean> {
  const gen = generation;
  const baselineLiveness = livenessSeq;
  const baselineDown = downSeq;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (generation !== gen) return true;
    // Any HTTP response — even a 4xx/5xx — proves we reached a server.
    reportFetchSuccess(/* cacheBypassing */ true);
    if (mayClearDown) clearBackendDown(baselineDown);
    return true;
  } catch {
    // Stale-guard: if a cache-bypassing success landed since this probe
    // started, the failure predates it — don't re-latch offline.
    if (generation === gen && livenessSeq === baselineLiveness) {
      goOffline(/* fromProbe */ true);
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Run the recovery probe exactly while we're in doubt (awaiting liveness or
 * the backend is down), the device itself is online (no point probing when the
 * radio is down — that's the user's fix), and a probe endpoint is configured.
 * Idempotent. */
function updateRecoveryProbe() {
  const inDoubt = awaitingLiveness || backendDown;
  if (inDoubt && browserOnline && probeUrl != null) startRecoveryProbe();
  else stopRecoveryProbe();
}

function startRecoveryProbe() {
  if (recoveryTimer != null) return;
  recoveryTimer = setInterval(() => {
    // The interval is one of the two rate-bounded triggers allowed to clear
    // `down` and unpause reads. (If it happens to coalesce into an in-flight
    // machine-chatty probe, `down` survives this tick — the next one clears it.)
    void runProbe(/* mayClearDown */ true);
  }, RECOVERY_PROBE_INTERVAL_MS);
}

function stopRecoveryProbe() {
  if (recoveryTimer == null) return;
  clearInterval(recoveryTimer);
  recoveryTimer = null;
}

/** Returning focus to a tab is the moment to re-check — probe at once rather
 * than waiting out the interval. Rare and user-salient, so this trigger is also
 * allowed to clear `down`. No-op unless we're in doubt and the device claims a
 * connection. */
function handleRegainedFocus() {
  if (!(awaitingLiveness || backendDown) || !browserOnline) return;
  void runProbe(/* mayClearDown */ true);
}

// --- Network Information API (a trigger, never truth) -----------------------
//
// With nothing in flight, entering a tunnel goes unnoticed until the next user
// action — there is no failed request to learn from. `navigator.connection`'s
// 'change' event (Android Chrome; absent on iOS Safari, hence the feature
// detection) closes that no-traffic gap. The OS's opinion is ONLY a cue to
// gather real evidence — we fire a probe and believe its outcome, never the
// event itself.
function handleConnectionChange() {
  // Device already reports offline: we're already pessimistic, nothing to learn.
  if (!browserOnline) return;
  if (probeUrl == null) return;
  // Coalesced by runProbe (bursts share one in-flight probe). Never allowed to
  // clear `down` — Chrome fires 'change' on mere downlink/RTT estimate shifts.
  void runProbe(/* mayClearDown */ false);
}

let connectionTarget: EventTarget | null = null;
function wireConnectionListener() {
  const connection =
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & { connection?: unknown }).connection
      : undefined;
  const next = connection instanceof EventTarget ? connection : null;
  if (next === connectionTarget) return;
  connectionTarget?.removeEventListener('change', handleConnectionChange);
  connectionTarget = next;
  connectionTarget?.addEventListener('change', handleConnectionChange);
}

// --- Error classification ----------------------------------------------------

function isNetworkError(err: unknown): boolean {
  // AbortError is a caller cancelling the request (React Query does
  // this when a query is superseded), not a signal about connectivity.
  if (err instanceof DOMException && err.name === 'AbortError') return false;
  if (err instanceof Error && err.name === 'AbortError') return false;
  // Our own read cap aborts with a TimeoutError, and a timeout is AMBIGUOUS —
  // the device may be offline or the backend merely slow — so it never flips
  // the status by itself (the probe decides; see coreReadFetch).
  if (isTimeoutError(err)) return false;
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

function isTimeoutError(err: unknown): boolean {
  return (
    (err instanceof DOMException || err instanceof Error) &&
    err.name === 'TimeoutError'
  );
}

/**
 * Should an automatic retry follow this error? Only true statusless network
 * blips (and our own ambiguous read timeouts) qualify — never a response that
 * carried an HTTP status: a 4xx won't change on retry, and retrying a 5xx
 * storms a backend that just told us it's struggling. Aborts aren't errors at
 * all from a connectivity standpoint.
 */
export function isRetryableFetchError(err: unknown): boolean {
  return isNetworkError(err) || isTimeoutError(err);
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

// Every runtimeCaching rule in vite.config.ts sets
// `cacheableResponse: { statuses: [0, 200] }`, and the browser HTTP cache also
// only stores successes — so a GET that came back with any other status must
// have reached the origin. Non-GETs always bypass the Cache API (it's GET-only).
function couldBeCacheHit(method: string, status: number): boolean {
  return method === 'GET' && (status === 200 || status === 0);
}

// --- Tracked fetch ------------------------------------------------------------

export interface TrackedFetchOptions {
  /**
   * Marks a core data-plane read (feed id lists, items — the content without
   * which the app is empty). Core reads get the read cap + hedged liveness
   * probe, and a 5xx flips the tracker to 'down'. Leave unset for everything
   * else: a 5xx from a non-critical endpoint (summaries, search, telemetry)
   * must NOT flip the whole app, and writes/auth/long-running calls must never
   * be capped or hedged.
   */
  coreRead?: boolean;
}

export async function trackedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: TrackedFetchOptions,
): Promise<Response> {
  if (opts?.coreRead) return coreReadFetch(input, init);
  try {
    const res = await fetch(input, init);
    // Any HTTP response — even a 500 — proves we reached a server, so treat it
    // as evidence the fetch side is healthy. The browser may still disagree
    // (e.g. just after firing an 'offline' event while the SW served a cache
    // hit), and in that case we stay offline until both signals line up. A
    // response that can't have come from a cache (non-GET, or a status the SW
    // may not store) additionally counts as cache-bypassing liveness proof; a
    // 200 GET might be a cache hit, so it isn't trusted as liveness evidence —
    // that's what the probe is for. Deliberately no 5xx→down here: only the
    // core data plane may flip the whole app.
    reportFetchSuccess(!couldBeCacheHit(methodOf(input, init), res.status));
    return res;
  } catch (err) {
    reportFetchFailure(err);
    throw err;
  }
}

async function coreReadFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const baselineDown = downSeq;
  const baselineLiveness = livenessSeq;
  const controller = new AbortController();
  let timedOut = false;
  const callerSignal = init?.signal ?? null;
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener('abort', onCallerAbort);
  }
  const capTimer = setTimeout(() => {
    timedOut = true;
    controller.abort(
      new DOMException(
        `Core read timed out after ${CORE_READ_TIMEOUT_MS}ms`,
        'TimeoutError',
      ),
    );
  }, CORE_READ_TIMEOUT_MS);
  // The hedge: if the read is still unsettled after 3s, fire the liveness probe
  // IN PARALLEL with the still-hanging read. Lie-fi makes requests hang rather
  // than fail; without this, the first offline evidence waits out cap + probe.
  // A probe that reaches the backend changes nothing and the read keeps its
  // full cap.
  const hedgeTimer = setTimeout(() => {
    if (browserOnline && probeUrl != null) void runProbe(false);
  }, CORE_READ_HEDGE_DELAY_MS);
  try {
    const res = await fetch(input, { ...init, signal: controller.signal });
    if (res.status >= 500) {
      // The backend answered — reachable but erroring on the data plane. That's
      // 'down', never 'offline' (a 5xx also can't be a SW cache hit, so it
      // doubles as cache-bypassing reachability proof).
      reportCoreReadServerError();
      reportFetchSuccess(/* cacheBypassing */ true);
    } else {
      const cacheBypassing = !couldBeCacheHit(methodOf(input, init), res.status);
      // Only cache-bypassing proof may clear `down`, same rule as the offline
      // latch: a GET 200 here may be the SW's NetworkFirst cache fallback
      // (served after its 6s window while the real request timed out), which
      // proves nothing about the data plane. Ambiguous successes leave the
      // rate-bounded recovery probe to do the optimistic clear.
      if (cacheBypassing) clearBackendDown(baselineDown);
      reportFetchSuccess(cacheBypassing);
    }
    return res;
  } catch (err) {
    if (timedOut) {
      // A timeout is AMBIGUOUS — offline and merely-slow look identical — so
      // never flip the status on it alone. Probe instead: any HTTP response
      // (even 4xx/5xx) proves reachability → stay online; only a probe that
      // also fails means genuinely offline. Skip it when fresh cache-bypassing
      // proof already landed since this read started (e.g. the hedge probe
      // settled), or when we're already offline (the recovery interval owns
      // re-tests).
      if (fetchOnline && livenessSeq === baselineLiveness) void runProbe(false);
      throw err;
    }
    reportFetchFailure(err);
    throw err;
  } finally {
    clearTimeout(capTimer);
    clearTimeout(hedgeTimer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

// --- Browser signal wiring -----------------------------------------------------

function handleBrowserOnline() {
  if (browserOnline) return;
  browserOnline = true;
  // Reconnecting while still in doubt resumes the recovery interval (it was
  // idle while the device was offline) — and probes at once, so a genuine
  // reconnect clears the pill in ~one round trip instead of up to 30s. The
  // event itself proves nothing (only evidence flips us online), hence the
  // probe rather than trusting it. Like focus regain, a browser reconnect is
  // rare and user-salient — not machine-chatty — so its probe is also allowed
  // to clear `down` (otherwise a tunnel ride while the backend was down would
  // keep reads paused for up to a full interval after connectivity returned).
  updateRecoveryProbe();
  if (awaitingLiveness || backendDown) {
    void runProbe(/* mayClearDown */ backendDown);
  }
  update();
}

function handleBrowserOffline() {
  if (!browserOnline) return;
  browserOnline = false;
  // Device offline → "find a connection" is the user's fix; stand down the probe
  // until the radio is back.
  updateRecoveryProbe();
  update();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', handleBrowserOnline);
  window.addEventListener('offline', handleBrowserOffline);
  // Returning to a tab that's showing offline/down re-checks reachability at once.
  window.addEventListener('focus', handleRegainedFocus);
  wireConnectionListener();
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
  generation++;
  browserOnline = initialBrowserOnline();
  fetchOnline = true;
  backendDown = false;
  probeUrl = null;
  awaitingLiveness = false;
  livenessSeq = 0;
  downSeq = 0;
  probeInFlight = null;
  lastEmitted = currentStatus();
  wireConnectionListener();
  syncOnlineManager();
}
