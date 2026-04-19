import { useEffect, useRef } from 'react';
import { useToast } from '../hooks/useToast';
import { registerPwa, type UpdateSW } from '../lib/pwa';

// Mount-once component that registers the service worker and surfaces a
// non-blocking toast when a new build is waiting to activate. The toast
// action calls updateSW(true), which skips the waiting worker and reloads.
// Lives inside <ToastProvider>, so it has access to useToast().
export function PwaUpdateToast() {
  const { showToast } = useToast();
  const updateRef = useRef<UpdateSW | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const promise = registerPwa({
      onNeedRefresh: () => {
        const reload = updateRef.current;
        showToast({
          message: 'New version available.',
          actionLabel: 'Reload',
          onAction: () => {
            if (reload) reload(true);
          },
          durationMs: 30_000,
          groupKey: 'pwa-update',
        });
      },
      onRegisterError: (err) => {
        console.warn('SW registration failed', err);
      },
    });
    promise.then((update) => {
      if (cancelled) return;
      updateRef.current = update;
    });
    return () => {
      cancelled = true;
    };
  }, [showToast]);

  return null;
}
