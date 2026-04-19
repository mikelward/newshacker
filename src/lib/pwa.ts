// Thin wrapper around the virtual module exposed by vite-plugin-pwa so
// tests and tooling don't need to know about the virtual import. The SW
// only registers in production builds; in dev it's a no-op because
// devOptions.enabled is false in vite.config.ts.
//
// The plugin runs with registerType: 'prompt', so `onNeedRefresh` fires
// when a new SW has installed and is waiting. The UI wires that to a
// toast with a "Reload" action that calls updateSW(true) — which activates
// the new worker and reloads the page.

export interface PwaHandlers {
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
  onRegisterError?: (error: unknown) => void;
}

export type UpdateSW = (reload?: boolean) => Promise<void>;

export async function registerPwa(handlers: PwaHandlers = {}): Promise<UpdateSW | undefined> {
  if (typeof window === 'undefined') return undefined;
  if (!('serviceWorker' in navigator)) return undefined;
  try {
    const mod = await import('virtual:pwa-register');
    return mod.registerSW({
      immediate: true,
      onNeedRefresh: handlers.onNeedRefresh,
      onOfflineReady: handlers.onOfflineReady,
      onRegisterError: handlers.onRegisterError,
    });
  } catch (err) {
    handlers.onRegisterError?.(err);
    return undefined;
  }
}
