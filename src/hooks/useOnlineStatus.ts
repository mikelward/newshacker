import { useSyncExternalStore } from 'react';
import {
  getConnectivityStatus,
  getOnline,
  subscribeConnectivityStatus,
  subscribeOnline,
  type ConnectivityStatus,
} from '../lib/networkStatus';

// Backed by `networkStatus`, which combines `navigator.onLine` /
// online-offline window events with real fetch-failure signals so the
// "Offline" pill flips as soon as a request fails, not whenever the OS
// eventually notices the radio dropped. See src/lib/networkStatus.ts.
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribeOnline, getOnline, getOnline);
}

// Tri-state view over the same tracker: 'offline' (no network / requests
// throw), 'down' (the backend answered a 5xx on the core data plane —
// reachable but erroring), or 'online'. Prefer this when the UI should tell
// "you have no connection" apart from "the service is having trouble".
export function useConnectivityStatus(): ConnectivityStatus {
  return useSyncExternalStore(
    subscribeConnectivityStatus,
    getConnectivityStatus,
    getConnectivityStatus,
  );
}
