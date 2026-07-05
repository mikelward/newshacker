// Stale-entry / stale-chunk recovery — a one-shot, loop-safe auto-reload that
// mirrors what a manual refresh does when a deploy leaves a client referencing
// a content-hashed asset that no longer exists.
//
// The bug: after a new build deploys, the service worker can briefly serve the
// *previous* build's precached `index.html`, which references that build's
// content-hashed entry (`/assets/index-<oldhash>.js`). The old hash is gone
// from the current deployment, so the entry module fails to load — and because
// it's the *entry itself* that failed, no React is alive to catch it and the
// page paints blank until a manual refresh pulls the current `index.html`.
//
// Recovery uses TWO disjoint sessionStorage budgets so it can never loop:
//   - `nh:entry-reload`  — the entry `<script>`/`<link>` failing to load. Armed
//     by the INLINE boot guard in `index.html` (which must run before the entry
//     module, so it can't import this file — it hard-codes the same literals).
//     Cleared at the top of the entry module (`main.tsx`); reaching that clear
//     proves the entry loaded, which re-arms the budget for a later upgrade in
//     the same session. A permanently-broken entry never reaches the clear, so
//     the single reload stands — loop-safe.
//   - `nh:chunk-reload`  — post-boot dynamic-import / lazy-route / preload
//     failures. Cleared only when a lazy route mounts successfully (NOT on
//     boot — clearing on boot would loop the reload for a genuinely-gone
//     chunk, since the entry always boots fine). See `clearChunkReloadBudget`.
//
// Both budgets fail closed: if sessionStorage is unavailable (private mode,
// storage disabled), we DON'T reload — an un-recordable reload could loop.

// Path prefix (under Vite `base: '/'`) where content-hashed build assets live.
// A script/link load failure for a URL under this dir after a deploy means the
// hash is gone from the current build — the stale-index-references-old-hash
// race. Kept in lockstep with the inline boot guard in `index.html`, which
// hard-codes the same literal because it runs before this module can load.
export const HASHED_ASSETS_PATH = '/assets/';

// Disjoint sessionStorage budgets — see the module header. These strings are
// also hard-coded in the inline boot guard (`ENTRY_RELOAD_KEY`) and must match.
export const ENTRY_RELOAD_KEY = 'nh:entry-reload';
export const CHUNK_RELOAD_KEY = 'nh:chunk-reload';

// Returns sessionStorage only if it's actually usable. Property access itself
// throws in some privacy modes ("The operation is insecure"), and a disabled
// store can throw on read/write, so probe with a real round-trip and treat any
// failure as "no storage" — callers fail closed on null.
function safeSessionStorage(): Storage | null {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) return null;
    const probe = '__nh_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

function defaultReload(): void {
  if (typeof globalThis.location !== 'undefined') globalThis.location.reload();
}

export interface ReloadDeps {
  // Injected for tests — production reads sessionStorage / location.
  storage?: Storage | null;
  reload?: () => void;
}

// Guarded one-shot reload against a single budget key. Returns true iff it
// actually triggered a reload. Fail-closed: no usable storage → no reload
// (an un-recordable reload would loop). Budget already spent → no reload.
export function reloadOnce(key: string, deps: ReloadDeps = {}): boolean {
  const storage =
    deps.storage !== undefined ? deps.storage : safeSessionStorage();
  if (!storage) return false;
  try {
    if (storage.getItem(key) !== null) return false;
    storage.setItem(key, '1');
  } catch {
    return false;
  }
  (deps.reload ?? defaultReload)();
  return true;
}

// Clears the entry budget. Called at the very top of the app entry module —
// reaching it proves the entry loaded, so a *later* stale-entry failure in the
// same session can re-arm and reload once more. Leaves the chunk budget alone.
export function clearEntryReloadBudget(storage?: Storage | null): void {
  const s = storage !== undefined ? storage : safeSessionStorage();
  try {
    s?.removeItem(ENTRY_RELOAD_KEY);
  } catch {
    /* storage went away between probe and write — nothing to clear */
  }
}

// Clears the chunk budget. Wire this to a lazy route's successful mount (NOT to
// boot — a genuinely-gone chunk would reload → boot fine → clear → re-fail →
// loop). Leaves the entry budget alone. Exported for the lazy-route success
// path; the app has no code-split routes today, so it is currently only a
// forward-compatible seam plus the target of the "budgets stay disjoint" tests.
export function clearChunkReloadBudget(storage?: Storage | null): void {
  const s = storage !== undefined ? storage : safeSessionStorage();
  try {
    s?.removeItem(CHUNK_RELOAD_KEY);
  } catch {
    /* storage went away between probe and write — nothing to clear */
  }
}

// Recognizes the shapes a "content-hashed module/chunk failed to load" error
// takes across browsers and Vite's own preload helper: a rejected dynamic
// import, a module fetched with the wrong MIME type (the HTML-as-JS worst
// case), or an error whose text names the hashed-assets dir.
export function isChunkLoadError(reason: unknown): boolean {
  const msg =
    typeof reason === 'string'
      ? reason
      : reason instanceof Error
        ? `${reason.name}: ${reason.message}`
        : reason && typeof reason === 'object' && 'message' in reason
          ? String((reason as { message: unknown }).message)
          : '';
  if (!msg) return false;
  return (
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) || // Safari
    /Expected a JavaScript(?:-or-Wasm)? module script/i.test(msg) || // MIME
    /ChunkLoadError/i.test(msg) ||
    msg.includes(HASHED_ASSETS_PATH)
  );
}

// True when the failing resource is a <script> or <link> whose URL is under the
// hashed-assets dir — the capture-'error' signature of a stale hashed asset.
// Font/image assets also live under the dir but don't load via script/link
// elements, so restricting to those two tags keeps this precise.
export function isHashedAssetElement(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: string; src?: string; href?: string };
  if (el.tagName !== 'SCRIPT' && el.tagName !== 'LINK') return false;
  const url = el.src || el.href || '';
  if (!url) return false;
  try {
    const base =
      typeof globalThis.location !== 'undefined'
        ? globalThis.location.href
        : 'http://localhost/';
    return new URL(url, base).pathname.startsWith(HASHED_ASSETS_PATH);
  } catch {
    return url.includes(HASHED_ASSETS_PATH);
  }
}

export interface InstallDeps extends ReloadDeps {
  // Injected for tests — production listens on the real window.
  target?: EventTarget;
}

// Installs the post-boot recovery listeners on `window`:
//   - `vite:preloadError` — Vite's own preload-failure event; preventDefault
//     (so it doesn't reach the default throw) and reload once.
//   - `unhandledrejection` — a rejected dynamic import that nothing awaited;
//     reload once only when the reason matches a chunk-load signature.
//   - capture-phase `error` — a dynamically-injected hashed-asset script/link
//     failing to load; reload once.
// All three share the single `nh:chunk-reload` budget, so at most one reload
// fires per session until a lazy route clears it. Returns a cleanup that
// removes every listener.
export function installStaleChunkRecovery(deps: InstallDeps = {}): () => void {
  const target: EventTarget =
    deps.target ?? (globalThis as unknown as { window: Window }).window;
  const reloadDeps: ReloadDeps = { storage: deps.storage, reload: deps.reload };

  const onPreloadError = (event: Event) => {
    event.preventDefault();
    reloadOnce(CHUNK_RELOAD_KEY, reloadDeps);
  };
  const onRejection = (event: Event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    if (isChunkLoadError(reason)) reloadOnce(CHUNK_RELOAD_KEY, reloadDeps);
  };
  const onError = (event: Event) => {
    if (isHashedAssetElement(event.target)) {
      reloadOnce(CHUNK_RELOAD_KEY, reloadDeps);
    }
  };

  target.addEventListener('vite:preloadError', onPreloadError);
  target.addEventListener('unhandledrejection', onRejection);
  target.addEventListener('error', onError, true);

  return () => {
    target.removeEventListener('vite:preloadError', onPreloadError);
    target.removeEventListener('unhandledrejection', onRejection);
    target.removeEventListener('error', onError, true);
  };
}
