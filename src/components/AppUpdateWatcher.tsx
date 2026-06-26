import { useEffect } from 'react';
import { useToast } from '../hooks/useToast';
import { pingServiceWorkerForUpdate } from '../lib/swUpdate';

// Threshold for "came back after a real absence" vs "quick alt-tab".
// Short enough to catch a user who switched apps for a coffee, long
// enough that rapid tab-switching doesn't spam SW update checks.
const RETURN_FROM_HIDDEN_THRESHOLD_MS = 30_000;

// How often a *continuously-foregrounded* tab re-checks `/sw.js`. The
// browser only re-fetches the SW script on navigation, and our other
// triggers are gestural (PTR) or transitional (visibilitychange-after-≥30s) —
// none of which fire for a tab left open and in view (an installed PWA, or
// a desktop tab parked on one route). Without a periodic check such a tab
// can sit on a stale build indefinitely after a deploy. A conditional GET
// against the tiny `/sw.js` every 30 min is negligible bandwidth, and pings
// pause entirely while hidden, so a backgrounded tab costs nothing. Any
// update found surfaces through the same `controllerchange` → toast path.
const PERIODIC_UPDATE_CHECK_MS = 30 * 60_000;

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
  // Injected for tests — how often a continuously-visible tab re-checks
  // `/sw.js`. Production uses PERIODIC_UPDATE_CHECK_MS (30 min).
  periodicCheckMs?: number;
}

// Tracks a localStorage write that failed at runtime even though reads
// keep working. Safari's quota-exceeded state (and some private modes)
// rejects setItem while still answering getItem — so writeInstalledFlag()
// throws-and-swallows, the flag never persists, and getItem keeps
// returning null. Without this memory, readInstalledFlag() would report
// `false` on every controllerchange, the first-ever-install guard would
// fire forever, and real updates would be suppressed — the exact opposite
// of the fail-open behavior this flag exists to guarantee. Remembering the
// failure here lets readInstalledFlag() fail open instead.
let installedFlagWriteFailed = false;

// Resets the in-memory write-failure latch. Exported for tests so each
// case starts from a clean fail-open baseline; not used by the component.
// (Fast-refresh doesn't apply to a test-only helper, so the rule's
// component-only-export warning is a false positive here.)
// eslint-disable-next-line react-refresh/only-export-components
export function resetInstalledFlagWriteFailureForTests() {
  installedFlagWriteFailed = false;
}

// Fail open: when storage isn't usable (Safari private mode, disabled
// cookies, quota exceeded), pretend the flag is set so the watcher
// shows the toast on every controllerchange. The alternative — fail
// closed and suppress every controllerchange — would silently
// reintroduce the very stale-bundle bug this flag exists to fix on
// browsers where storage just happens to be off. One spurious toast
// per session on those browsers is the much better failure mode.
function readInstalledFlag(): boolean {
  if (installedFlagWriteFailed) return true;
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
    // Storage rejected the write (private mode, quota exceeded). If reads
    // still work, getItem would keep returning null and readInstalledFlag
    // would report `false` forever; latch the failure so reads fail open.
    // The caller in the first-install branch also checks this latch
    // directly so the *current* claim fails open too, not just future
    // ones — exactly what we want.
    installedFlagWriteFailed = true;
  }
}

// Sits inside `ToastProvider` at the app root. Three passive surfaces
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
// 3. **Periodic passive ping while visible.** A tab kept open and in
//    view but never navigated/PTR'd (installed PWA, or a parked
//    desktop tab) would otherwise never re-check `/sw.js`. A 30 min
//    `registration.update()` while visible (paused while hidden)
//    bounds how long such a tab can sit on a stale build; a found
//    update surfaces via the same `controllerchange` toast.
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
  periodicCheckMs = PERIODIC_UPDATE_CHECK_MS,
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
      baselineController = current;
      if (!readInstalledFlag()) {
        // No record of a prior install on this device. Try to record this
        // claim as the first one and suppress the spurious toast — the
        // bundle we're running was just fetched fresh, the SW claiming us
        // precaches the same hashes, no reason to nudge. But only suppress
        // if the write actually sticks: if storage rejects it (reads work,
        // writes throw), we can never persist the flag and so can't tell a
        // first install from a real update on the next load. Fail open on
        // *this* claim — suppressing it would silently swallow the real
        // update on every reload in that environment, which is the bug the
        // flag exists to prevent.
        writeInstalledFlag();
        if (!installedFlagWriteFailed) return;
      }
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
    // Seed from the current state. If the tab is restored already-hidden
    // (session restore of a background tab), no `hidden` visibilitychange
    // fires after we attach the listener, so without this seed hiddenAt
    // would stay 0 and the first `visible` event would skip the ping even
    // after a long real absence.
    let hiddenAt = document.visibilityState === 'hidden' ? Date.now() : 0;
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

  useEffect(() => {
    if (typeof document === 'undefined') return;
    // Periodic `/sw.js` re-check for a tab that's open and in view but never
    // navigates or pulls-to-refresh — the gap the gestural/transitional
    // triggers don't cover. Runs only while visible (a hidden tab can't show
    // the resulting toast and shouldn't spend bandwidth), so the interval is
    // torn down on hide and re-armed on show. A found update flows through the
    // `controllerchange` → toast path above; no reload is forced here.
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const sync = () => {
      if (document.visibilityState === 'visible') {
        if (timer === null) {
          timer = setInterval(() => void pingServiceWorkerForUpdate(), periodicCheckMs);
        }
      } else {
        stop();
      }
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', sync);
    };
  }, [periodicCheckMs]);

  return null;
}
