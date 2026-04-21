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
  return navigator.onLine;
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
  // Keep React Query's own onlineManager in sync so paused queries
  // resume when we reconnect (belt-and-braces with networkMode:
  // 'offlineFirst' — that mode prevents hanging, this keeps
  // refetch-on-reconnect working).
  onlineManager.setOnline(next);
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
  // fetch throws TypeError for all network-layer failures: DNS,
  // unreachable host, dropped connection, CORS preflight fail. Any of
  // those reasonably mean "not online right now".
  if (err instanceof TypeError) return true;
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
  emitIfChanged();
}

function handleBrowserOffline() {
  if (!browserOnline) return;
  browserOnline = false;
  emitIfChanged();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', handleBrowserOnline);
  window.addEventListener('offline', handleBrowserOffline);
}

// Tests need to rehydrate module state after overriding
// navigator.onLine or clearing listeners between cases.
export function _resetNetworkStatusForTests() {
  listeners.clear();
  browserOnline = initialBrowserOnline();
  fetchOnline = true;
  lastEmitted = combined();
}
