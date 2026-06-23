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

export function getOnline(): boolean {
  return combined();
}

export function subscribeOnline(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function reportFetchSuccess() {
  if (fetchOnline) return;
  fetchOnline = true;
  emitIfChanged();
}

export function reportFetchFailure(err: unknown) {
  if (!isNetworkError(err)) return;
  if (!fetchOnline) return;
  fetchOnline = false;
  emitIfChanged();
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
    // until both signals line up.
    reportFetchSuccess();
    return res;
  } catch (err) {
    reportFetchFailure(err);
    throw err;
  }
}

function handleBrowserOnline() {
  if (browserOnline) return;
  browserOnline = true;
  syncOnlineManager();
  emitIfChanged();
}

function handleBrowserOffline() {
  if (!browserOnline) return;
  browserOnline = false;
  syncOnlineManager();
  emitIfChanged();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', handleBrowserOnline);
  window.addEventListener('offline', handleBrowserOffline);
  syncOnlineManager();
}

// Tests need to rehydrate module state after overriding
// navigator.onLine or clearing listeners between cases.
export function _resetNetworkStatusForTests() {
  listeners.clear();
  browserOnline = initialBrowserOnline();
  fetchOnline = true;
  lastEmitted = combined();
  syncOnlineManager();
}
