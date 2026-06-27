// Shared core for the single-value, localStorage-backed, cross-tab-synced reading
// preferences (theme / font size / home feed, …). Each was a hand-rolled copy of
// the same shape: read-with-default-and-validate, write (clearing the key when the
// value IS the default so the baseline CSS/route represents it), an optional DOM
// side effect, and a CustomEvent so other tabs/components re-read. This collapses
// that core into one place; each pref stays a thin config + its own metadata
// (labels, options, extra helpers).
//
// Pair with `usePersistentValue(store)` (src/hooks/usePersistentValue.ts) to read
// the value reactively.

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

export interface PersistentValueConfig<T> {
  storageKey: string;
  /** Custom event dispatched on every set; also the event the hook subscribes to
   * (alongside `storage` for cross-tab writes). */
  changeEvent: string;
  defaultValue: T;
  /** Validate a stored string into T, or return undefined to fall back to the
   * default (covers a missing/corrupt/legacy value). */
  parse: (raw: string) => T | undefined;
  /** Serialize T for storage. Defaults to the value itself for string-enum prefs. */
  serialize?: (value: T) => string;
  /** When the value equals defaultValue, REMOVE the key instead of writing it —
   * the baseline already represents the default (e.g. medium font = no attribute,
   * system theme = no attribute). Default true; set false to always persist. */
  clearOnDefault?: boolean;
  /** Side effect to run on set and on cross-tab sync, before the change event —
   * e.g. applying a `data-*` attribute to <html>. Idempotent by contract. */
  onApply?: (value: T) => void;
  /** Key under `CustomEvent.detail` carrying the new value, preserving each pref's
   * existing detail shape (e.g. `{ theme }`, `{ fontSize }`). */
  detailKey: string;
}

export interface PersistentValue<T> {
  get(): T;
  set(value: T): void;
  /** Subscribe to changes (same-tab event + cross-tab `storage`); re-applies
   * `onApply` on sync so a cross-tab write repaints this tab too. For
   * useSyncExternalStore. Returns an unsubscribe fn. */
  subscribe(onChange: () => void): () => void;
}

export function createPersistentValue<T>(
  config: PersistentValueConfig<T>,
): PersistentValue<T> {
  const {
    storageKey,
    changeEvent,
    defaultValue,
    parse,
    serialize,
    clearOnDefault = true,
    onApply,
    detailKey,
  } = config;

  function get(): T {
    if (!hasWindow()) return defaultValue;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw === null) return defaultValue;
      const parsed = parse(raw);
      return parsed === undefined ? defaultValue : parsed;
    } catch {
      return defaultValue;
    }
  }

  function set(value: T): void {
    if (!hasWindow()) return;
    try {
      if (clearOnDefault && value === defaultValue) {
        window.localStorage.removeItem(storageKey);
      } else {
        window.localStorage.setItem(
          storageKey,
          serialize ? serialize(value) : String(value),
        );
      }
    } catch {
      // quota or privacy-mode failures are non-fatal
    }
    onApply?.(value);
    window.dispatchEvent(
      new CustomEvent(changeEvent, { detail: { [detailKey]: value } }),
    );
  }

  function subscribe(onChange: () => void): () => void {
    if (!hasWindow()) return () => {};
    const handler = () => {
      // A cross-tab `storage` write applied the value in the OTHER tab only, so
      // repaint here too. Same-tab `changeEvent` already applied it in set(), but
      // onApply is idempotent so re-running is harmless.
      onApply?.(get());
      onChange();
    };
    window.addEventListener(changeEvent, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(changeEvent, handler);
      window.removeEventListener('storage', handler);
    };
  }

  return { get, set, subscribe };
}
