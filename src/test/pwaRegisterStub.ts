// Stub for `virtual:pwa-register` used only under vitest, where we skip
// the VitePWA plugin that normally provides the virtual module. The real
// plugin exports a `registerSW(options)` factory that returns an updater
// callback; the stub returns a no-op updater so tests that touch the
// registration path can proceed without a service worker runtime.
export function registerSW(): () => Promise<void> {
  return () => Promise.resolve();
}
