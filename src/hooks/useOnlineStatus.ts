import { useSyncExternalStore } from 'react';
import { getOnline, subscribeOnline } from '../lib/networkStatus';

// Backed by `networkStatus`, which combines `navigator.onLine` /
// online-offline window events with real fetch-failure signals so the
// "Offline" pill flips as soon as a request fails, not whenever the OS
// eventually notices the radio dropped. See src/lib/networkStatus.ts.
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribeOnline, getOnline, getOnline);
}
