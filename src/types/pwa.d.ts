// Ambient declarations for vite-plugin-pwa's virtual modules. The plugin
// ships its own /client types, but we import lazily via `import('virtual:pwa-register')`
// so declaring it here lets tsc resolve the symbol without pulling the
// plugin's /client module into the app's type surface.
declare module 'virtual:pwa-register' {
  export interface RegisterSWOptions {
    immediate?: boolean;
    onNeedRefresh?: () => void;
    onOfflineReady?: () => void;
    onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void;
    onRegisteredSW?: (swScriptUrl: string, registration: ServiceWorkerRegistration | undefined) => void;
    onRegisterError?: (error: unknown) => void;
  }

  export function registerSW(options?: RegisterSWOptions): (reload?: boolean) => Promise<void>;
}
