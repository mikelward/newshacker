import { onlineManager } from '@tanstack/react-query';

// `navigator.onLine` on mobile lags badly behind what users perceive as
// "offline" — stepping into a tunnel can leave it stuck at `true` for
// tens of seconds, because the OS only flips it once the radio has
// fully given up. We can do better: every fetch the app makes is a
// probe for whether we can reach the network right now. Route those
// through this tracker so the offline indicator reacts the instant a
// real request fails, instead of waiting for the OS to notice.

type Listener = (online: boolean) => void;

function initialOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine;
}

let currentOnline: boolean = initialOnline();
const listeners = new Set<Listener>();

function emit() {
  for (const fn of listeners) fn(currentOnline);
  // Keep React Query's own onlineManager in sync so paused queries
  // resume when we reconnect (belt-and-braces with networkMode:
  // 'offlineFirst' — that mode prevents hanging, this keeps
  // refetch-on-reconnect working).
  onlineManager.setOnline(currentOnline);
}

function setOnline(next: boolean) {
  if (currentOnline === next) return;
  currentOnline = next;
  emit();
}

export function getOnline(): boolean {
  return currentOnline;
}

export function subscribeOnline(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function reportFetchSuccess() {
  setOnline(true);
}

export function reportFetchFailure(err: unknown) {
  if (!isNetworkError(err)) return;
  setOnline(false);
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
    // treat it as evidence we're online. HTTP-level errors get surfaced
    // by the caller the same way they always did.
    reportFetchSuccess();
    return res;
  } catch (err) {
    reportFetchFailure(err);
    throw err;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => setOnline(true));
  window.addEventListener('offline', () => setOnline(false));
}

// Tests need to rehydrate module state after overriding
// navigator.onLine or clearing listeners between cases.
export function _resetNetworkStatusForTests() {
  listeners.clear();
  currentOnline = initialOnline();
}
