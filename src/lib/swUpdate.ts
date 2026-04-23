// Kick the browser into re-fetching the service worker script and, if a
// newer build is out there, reload the tab once the new SW takes
// control.
//
// Why PTR triggers this: the browser normally only re-checks `/sw.js`
// on a full page navigation. Our custom PTR (with
// `overscroll-behavior-y: contain` on the wrapper) overrides the
// browser's native "swipe down to reload" in regular tabs, and
// installed standalone PWAs have no reload UI at all — so a session
// parked on one SPA route can sit on a stale bundle until the user
// closes and reopens the tab. That's the failure mode that made
// Vercel preview testing after a force-push unreliable. Tying the
// SW update check to the refresh gesture the user already makes
// means "latest stories" and "latest app" stay coupled, without
// adding a prompt or toast (SPEC rejected 'prompt' mode earlier
// because updates stranded on devices whose users never tapped it).
//
// With `vite-plugin-pwa`'s `registerType: 'autoUpdate'` (skipWaiting +
// clientsClaim), a newly-installed SW immediately claims this tab;
// we listen for the resulting `controllerchange` as the cue to
// reload so the user actually sees the new HTML/JS, not just the
// new SW serving old rendered output. If nothing's changed,
// `registration.update()` is a cheap conditional GET against
// `/sw.js` — no reload, no spinner delay beyond the round-trip.
const CONTROLLER_CHANGE_TIMEOUT_MS = 5000;

interface Options {
  // Injected for tests — production uses window.location.reload().
  reload?: () => void;
  // Injected for tests — bounds how long we wait for the new SW to
  // activate before giving up on the auto-reload. 5 s is long
  // enough to cover ordinary mobile-data install latency but short
  // enough that a wedged install doesn't pin the PTR spinner
  // indefinitely.
  timeoutMs?: number;
}

function defaultReload() {
  if (typeof window !== 'undefined') window.location.reload();
}

export async function checkForServiceWorkerUpdate(
  { reload = defaultReload, timeoutMs = CONTROLLER_CHANGE_TIMEOUT_MS }: Options = {},
): Promise<void> {
  if (typeof navigator === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return;

    // Arm the observer *before* calling update() and snapshot the
    // controller so we can't miss a fast swap. With skipWaiting +
    // clientsClaim, a new SW can reach `active` and fire
    // `controllerchange` before control returns from
    // `registration.update()`, which would leave both
    // `installing`/`waiting` null by the time we inspect them —
    // and an `addEventListener` attached after the fact would
    // never see the event. Snapshotting `controller` gives us a
    // belt-and-braces post-check for the same race.
    const priorController = navigator.serviceWorker.controller;
    let settled = false;
    let resolveActivated!: (value: boolean) => void;
    const activatedPromise = new Promise<boolean>((resolve) => {
      resolveActivated = resolve;
    });
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('controllerchange', onChange);
      resolveActivated(value);
    };
    const onChange = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    navigator.serviceWorker.addEventListener('controllerchange', onChange);

    try {
      await registration.update();
      const currentController = navigator.serviceWorker.controller;
      if (
        priorController &&
        currentController &&
        currentController !== priorController
      ) {
        // The swap already happened; either the event fired before
        // our listener was reached by the event loop, or we're
        // observing a silent activation that preceded this call.
        finish(true);
      } else if (!registration.installing && !registration.waiting) {
        // Nothing pending and no swap — don't pin the spinner for
        // the full timeout window.
        finish(false);
      }
    } catch {
      // `update()` itself failed (network blip, DNS hiccup, browser
      // throttling repeated update calls). No reload.
      finish(false);
    }

    if (await activatedPromise) reload();
  } catch {
    // Outer guard for anything we didn't anticipate — must never
    // surface as a PTR failure; the feed refresh is the real work.
  }
}

// Passive counterpart: fire `registration.update()` and forget. No
// waiting, no reload — intended for triggers where the user hasn't
// asked for a reload (visibility change, focus return). If the check
// finds a newer SW, the `AppUpdateWatcher` elsewhere in the tree
// picks it up via `controllerchange` and surfaces the update-available
// toast instead.
export async function pingServiceWorkerForUpdate(): Promise<void> {
  if (typeof navigator === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update();
  } catch {
    // A transient failure re-checking the SW script must never
    // surface to the user — passive trigger, no spinner to unwind.
  }
}
