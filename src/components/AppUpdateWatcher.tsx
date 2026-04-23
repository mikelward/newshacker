import { useEffect } from 'react';
import { useToast } from '../hooks/useToast';
import { pingServiceWorkerForUpdate } from '../lib/swUpdate';

// Threshold for "came back after a real absence" vs "quick alt-tab".
// Short enough to catch a user who switched apps for a coffee, long
// enough that rapid tab-switching doesn't spam SW update checks.
const RETURN_FROM_HIDDEN_THRESHOLD_MS = 30_000;

interface Props {
  reload?: () => void;
  returnFromHiddenThresholdMs?: number;
}

// Sits inside `ToastProvider` at the app root. Two passive surfaces
// for SW updates that aren't covered by the PTR auto-reload path:
//
// 1. **`controllerchange` → update-available toast.** A new SW has
//    taken control since page load, so the rendered HTML/JS is
//    stale. We nudge the user with a sticky "New version
//    available — Reload" toast. Covers new tabs opened against a
//    deploy-stale SW (tab loads old bundle, new SW claims shortly
//    after, toast appears), and cross-tab propagation (tab A's PTR
//    swaps the SW, tab B's watcher toasts). PTR's own swUpdate
//    handler also observes the event and auto-reloads the tab; in
//    that case the toast paints for a blink before the reload
//    replaces the DOM — acceptable.
// 2. **`visibilitychange` return-from-hidden → passive ping.** When
//    the tab regains focus after a real absence (≥30 s), ping
//    `/sw.js`. If a new SW shipped while the user was away, it
//    activates and the `controllerchange` path above surfaces the
//    toast. No reload, no disruption beyond what the user already
//    expected from returning to the tab.
//
// First-ever-visit guard: if `navigator.serviceWorker.controller`
// was null at mount, suppress *only* the first `controllerchange`
// (the initial install → activate → claim, where the bundle is
// already current). Adopt that new controller as our baseline so
// any later swap — a subsequent deploy claiming the tab — still
// surfaces the toast.
export function AppUpdateWatcher({
  reload,
  returnFromHiddenThresholdMs = RETURN_FROM_HIDDEN_THRESHOLD_MS,
}: Props = {}) {
  const { showToast } = useToast();

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }

    let baselineController = navigator.serviceWorker.controller;

    const onControllerChange = () => {
      const current = navigator.serviceWorker.controller;
      if (baselineController === null) {
        baselineController = current;
        return;
      }
      if (current === baselineController) return;
      showToast({
        message: 'New version available',
        actionLabel: 'Reload',
        onAction: () => {
          if (reload) reload();
          else if (typeof window !== 'undefined') window.location.reload();
        },
        durationMs: Number.POSITIVE_INFINITY,
        groupKey: 'sw-update',
      });
    };

    navigator.serviceWorker.addEventListener(
      'controllerchange',
      onControllerChange,
    );
    return () => {
      navigator.serviceWorker.removeEventListener(
        'controllerchange',
        onControllerChange,
      );
    };
  }, [showToast, reload]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    let hiddenAt = 0;
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      if (document.visibilityState === 'visible' && hiddenAt) {
        const elapsed = Date.now() - hiddenAt;
        hiddenAt = 0;
        if (elapsed >= returnFromHiddenThresholdMs) {
          void pingServiceWorkerForUpdate();
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [returnFromHiddenThresholdMs]);

  return null;
}
