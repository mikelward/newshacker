import { useEffect } from 'react';
import { useToast } from '../hooks/useToast';
import { pingServiceWorkerForUpdate } from '../lib/swUpdate';

// Threshold for "came back after a real absence" vs "quick alt-tab".
// Short enough to catch a user who switched apps for a coffee, long
// enough that rapid tab-switching doesn't spam SW update checks.
const RETURN_FROM_HIDDEN_THRESHOLD_MS = 30_000;

// Sticky flag: set the first time we observe a SW controller on this
// device, never cleared. Used to distinguish "this is the very first
// SW install ever" (suppress the spurious toast) from "controller is
// transiently null at mount but we've installed before" (show the
// toast — this is a real update). The latter is the symptom that
// stranded users on stale bundles after a deploy: a hard-reload
// bypasses the SW, an iOS PWA relaunch sometimes attaches the
// controller a tick late, and Chrome session-restore can do the
// same. In all of those, the next `controllerchange` is the new SW
// claiming a tab that's already running stale code.
//
// Exported for tests so they can target the same key the component
// reads/writes — keeps test fixtures from drifting on a rename.
export const SW_INSTALLED_FLAG = 'newshacker:sw:installed';

interface Props {
  reload?: () => void;
  returnFromHiddenThresholdMs?: number;
}

// Fail open: when storage isn't usable (Safari private mode, disabled
// cookies, quota exceeded), pretend the flag is set so the watcher
// shows the toast on every controllerchange. The alternative — fail
// closed and suppress every controllerchange — would silently
// reintroduce the very stale-bundle bug this flag exists to fix on
// browsers where storage just happens to be off. One spurious toast
// per session on those browsers is the much better failure mode.
function readInstalledFlag(): boolean {
  try {
    return localStorage.getItem(SW_INSTALLED_FLAG) === '1';
  } catch {
    return true;
  }
}

function writeInstalledFlag() {
  try {
    localStorage.setItem(SW_INSTALLED_FLAG, '1');
  } catch {
    // Storage disabled (private mode, quota); readInstalledFlag also
    // returns true on a throw, so the next controllerchange will
    // surface the toast — exactly what we want.
  }
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
// First-ever-install guard: only suppress the toast if we have *no*
// record of ever having seen a controller on this device (the
// `SW_INSTALLED_FLAG` localStorage entry). The previous in-memory
// "controller was null at mount" heuristic also fired on hard
// reloads, Chrome session-restore, and iOS PWA relaunches — all of
// which can produce a transient null controller despite the SW
// being installed long ago — so legitimate updates were getting
// silently swallowed. The flag persists across tabs and sessions,
// so once we've installed once, every subsequent claim is treated
// as a real update.
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
    if (baselineController) writeInstalledFlag();

    const onControllerChange = () => {
      const current = navigator.serviceWorker.controller;
      if (current === baselineController) return;
      if (!readInstalledFlag()) {
        // Truly first-ever install on this device: the bundle we're
        // running was just fetched fresh, the SW that's claiming us
        // precaches the same hashes — no reason to nudge.
        baselineController = current;
        writeInstalledFlag();
        return;
      }
      baselineController = current;
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
