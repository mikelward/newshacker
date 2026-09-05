import { useEffect } from 'react';
import { useToast } from '../hooks/useToast';
import {
  subscribeStorageFailure,
  type StorageFailureKind,
} from '../lib/storageHealth';

// Short because it is a toast, and because the user's next move is the same
// whatever the detail: the reason is the only part they can act on.
const MESSAGE: Record<StorageFailureKind, string> = {
  quota: 'Error saving – out of storage',
  denied: 'Error saving – storage blocked',
  unknown: 'Error saving',
};

// Sits inside `ToastProvider` at the app root, like `AppUpdateWatcher`: a
// passive listener with nothing to render. The store cannot show a toast
// itself — it is a plain module with no React in it, and it is read from
// `useSyncExternalStore`, where a render-time side effect would be a bug — so
// it reports the refusal and this turns it into something the user sees.
//
// `storageHealth` decides WHETHER to speak (once per kind per session, and only
// for a condition rather than a blip); this decides how it reads.
export function StorageFailureWatcher() {
  const { showToast } = useToast();

  useEffect(
    () =>
      subscribeStorageFailure((kind) => {
        showToast({ message: MESSAGE[kind], groupKey: 'storage-failure' });
      }),
    [showToast],
  );

  return null;
}
