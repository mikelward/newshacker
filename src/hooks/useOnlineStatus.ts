import { useEffect, useState } from 'react';

// `navigator.onLine` is only a hint — it's true whenever the OS reports any
// network, even one that can't reach us — but it's enough to switch UX
// between "probably online" and "definitely offline", and it lets us stop
// issuing writes that would queue up and fail. Real reachability gets
// confirmed or denied by the next fetch.
function readOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine;
}

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(readOnline);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    // Re-sync on mount in case we missed an event between render and effect.
    setOnline(readOnline());
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return online;
}
