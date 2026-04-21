import { useEffect } from 'react';
import { startCloudSync, stopCloudSync } from '../lib/cloudSync';
import { useAuth } from './useAuth';

// Wire the cloudSync module to auth state. Mount this once near the
// app root — it kicks off a pull + push loop for the signed-in user
// and tears it down on logout or user switch.
export function useCloudSync(): void {
  const { user } = useAuth();
  const username = user?.username ?? null;

  useEffect(() => {
    if (!username) {
      stopCloudSync();
      return;
    }
    void startCloudSync(username);
    return () => {
      stopCloudSync();
    };
  }, [username]);
}
