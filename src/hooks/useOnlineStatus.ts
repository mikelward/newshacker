import { useEffect, useState } from 'react';
import { getOnline, subscribeOnline } from '../lib/networkStatus';

// Backed by `networkStatus`, which combines `navigator.onLine` /
// online-offline window events with real fetch-failure signals so the
// "Offline" pill flips as soon as a request fails, not whenever the OS
// eventually notices the radio dropped. See src/lib/networkStatus.ts.
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(getOnline);

  useEffect(() => {
    const unsubscribe = subscribeOnline(setOnline);
    // Re-sync on mount in case the tracker updated between render and
    // effect.
    setOnline(getOnline());
    return unsubscribe;
  }, []);

  return online;
}
