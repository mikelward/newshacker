// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHUNK_RELOAD_KEY,
  ENTRY_RELOAD_KEY,
  clearChunkReloadBudget,
  clearEntryReloadBudget,
  installStaleChunkRecovery,
  isChunkLoadError,
  isHashedAssetElement,
  reloadOnce,
} from './staleEntryRecovery';

// Minimal in-memory Storage stand-in — the real one isn't in the node env,
// and injecting it keeps every test deterministic (no shared sessionStorage
// leaking across cases).
class MapStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

// A Storage whose writes always throw — models private-mode / quota-exceeded /
// disabled storage. Reads work; the write is what fails.
const throwingStorage: Storage = {
  length: 0,
  clear() {},
  getItem() {
    return null;
  },
  key() {
    return null;
  },
  removeItem() {},
  setItem() {
    throw new Error('storage blocked');
  },
};

// removeItem throws — models storage that went away mid-session.
const throwingStorageRemove: Storage = {
  ...throwingStorage,
  removeItem() {
    throw new Error('gone');
  },
};

// Records listeners so tests can invoke them with synthetic events instead of
// depending on the node env's DOM event dispatch.
class FakeTarget implements EventTarget {
  handlers = new Map<string, EventListener[]>();
  addEventListener(type: string, cb: EventListenerOrEventListenerObject | null): void {
    if (typeof cb !== 'function') return;
    const list = this.handlers.get(type) ?? [];
    list.push(cb);
    this.handlers.set(type, list);
  }
  removeEventListener(
    type: string,
    cb: EventListenerOrEventListenerObject | null,
  ): void {
    const list = this.handlers.get(type);
    if (!list || typeof cb !== 'function') return;
    this.handlers.set(
      type,
      list.filter((h) => h !== cb),
    );
  }
  dispatchEvent(): boolean {
    return true;
  }
  fire(type: string, event: Record<string, unknown>): void {
    for (const h of this.handlers.get(type) ?? []) h(event as unknown as Event);
  }
}

describe('isChunkLoadError', () => {
  it('matches the common cross-browser chunk-load signatures', () => {
    const messages = [
      'Failed to fetch dynamically imported module: https://x/assets/a-1.js',
      'error loading dynamically imported module',
      'Importing a module script failed.',
      "Expected a JavaScript module script but the server responded with a MIME type of \"text/html\".",
      'ChunkLoadError: Loading chunk 3 failed.',
      'boom while loading /assets/index-abc.js',
    ];
    for (const m of messages) {
      expect(isChunkLoadError(m)).toBe(true);
      expect(isChunkLoadError(new Error(m))).toBe(true);
      expect(isChunkLoadError({ message: m })).toBe(true);
    }
  });

  it('ignores unrelated errors and empty reasons', () => {
    expect(isChunkLoadError('TypeError: x is not a function')).toBe(false);
    expect(isChunkLoadError(new Error('network request failed'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError(42)).toBe(false);
  });
});

describe('isHashedAssetElement', () => {
  it('is true for a script/link under the hashed-assets dir', () => {
    expect(
      isHashedAssetElement({
        tagName: 'SCRIPT',
        src: 'https://newshacker.app/assets/index-abc.js',
      } as unknown as EventTarget),
    ).toBe(true);
    expect(
      isHashedAssetElement({
        tagName: 'LINK',
        href: 'https://newshacker.app/assets/index-abc.css',
      } as unknown as EventTarget),
    ).toBe(true);
  });

  it('is false for other elements, other paths, and missing urls', () => {
    expect(
      isHashedAssetElement({
        tagName: 'IMG',
        src: 'https://newshacker.app/assets/x.png',
      } as unknown as EventTarget),
    ).toBe(false);
    expect(
      isHashedAssetElement({
        tagName: 'SCRIPT',
        src: 'https://newshacker.app/registerSW.js',
      } as unknown as EventTarget),
    ).toBe(false);
    expect(
      isHashedAssetElement({ tagName: 'SCRIPT', src: '' } as unknown as EventTarget),
    ).toBe(false);
    expect(isHashedAssetElement(null)).toBe(false);
  });
});

describe('reloadOnce — the one-shot budget', () => {
  it('reloads exactly once per budget key, then no-ops', () => {
    const storage = new MapStorage();
    const reload = vi.fn();
    expect(reloadOnce(ENTRY_RELOAD_KEY, { storage, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    // Budget spent — a second failure in the same session does not reload.
    expect(reloadOnce(ENTRY_RELOAD_KEY, { storage, reload })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(ENTRY_RELOAD_KEY)).toBe('1');
  });

  it('fails closed when storage is unavailable (never reloads)', () => {
    const reload = vi.fn();
    expect(reloadOnce(ENTRY_RELOAD_KEY, { storage: null, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('fails closed when the write throws (never reloads)', () => {
    const reload = vi.fn();
    expect(
      reloadOnce(ENTRY_RELOAD_KEY, { storage: throwingStorage, reload }),
    ).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('the two budgets are distinct', () => {
  it('spending the entry budget leaves the chunk budget armed and vice versa', () => {
    const storage = new MapStorage();
    const reload = vi.fn();
    reloadOnce(ENTRY_RELOAD_KEY, { storage, reload });
    // Chunk budget is still armed even though the entry budget is spent.
    expect(reloadOnce(CHUNK_RELOAD_KEY, { storage, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(storage.getItem(ENTRY_RELOAD_KEY)).toBe('1');
    expect(storage.getItem(CHUNK_RELOAD_KEY)).toBe('1');
  });

  it('clearEntryReloadBudget leaves the chunk budget untouched', () => {
    const storage = new MapStorage();
    storage.setItem(ENTRY_RELOAD_KEY, '1');
    storage.setItem(CHUNK_RELOAD_KEY, '1');
    clearEntryReloadBudget(storage);
    expect(storage.getItem(ENTRY_RELOAD_KEY)).toBeNull();
    expect(storage.getItem(CHUNK_RELOAD_KEY)).toBe('1');
  });

  it('clearChunkReloadBudget leaves the entry budget untouched', () => {
    const storage = new MapStorage();
    storage.setItem(ENTRY_RELOAD_KEY, '1');
    storage.setItem(CHUNK_RELOAD_KEY, '1');
    clearChunkReloadBudget(storage);
    expect(storage.getItem(CHUNK_RELOAD_KEY)).toBeNull();
    expect(storage.getItem(ENTRY_RELOAD_KEY)).toBe('1');
  });

  it('clear helpers swallow storage errors', () => {
    expect(() => clearEntryReloadBudget(throwingStorageRemove)).not.toThrow();
    expect(() => clearChunkReloadBudget(throwingStorageRemove)).not.toThrow();
  });
});

describe('installStaleChunkRecovery — global listeners', () => {
  let target: FakeTarget;
  let storage: MapStorage;
  let reload = vi.fn();

  beforeEach(() => {
    target = new FakeTarget();
    storage = new MapStorage();
    reload = vi.fn();
  });

  function install() {
    return installStaleChunkRecovery({ target, storage, reload });
  }

  it('registers all three listeners and cleanup removes them', () => {
    const cleanup = install();
    expect(target.handlers.get('vite:preloadError')).toHaveLength(1);
    expect(target.handlers.get('unhandledrejection')).toHaveLength(1);
    expect(target.handlers.get('error')).toHaveLength(1);
    cleanup();
    expect(target.handlers.get('vite:preloadError')).toHaveLength(0);
    expect(target.handlers.get('unhandledrejection')).toHaveLength(0);
    expect(target.handlers.get('error')).toHaveLength(0);
  });

  it('vite:preloadError preventDefaults and reloads once', () => {
    install();
    const preventDefault = vi.fn();
    target.fire('vite:preloadError', { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(CHUNK_RELOAD_KEY)).toBe('1');
    // Second preload error in the same session — budget spent, no reload.
    target.fire('vite:preloadError', { preventDefault });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('unhandledrejection reloads only for a chunk-load reason', () => {
    install();
    target.fire('unhandledrejection', {
      reason: new Error('TypeError: not a chunk'),
    });
    expect(reload).not.toHaveBeenCalled();
    target.fire('unhandledrejection', {
      reason: new Error('Failed to fetch dynamically imported module: /assets/a.js'),
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('capture error reloads for a hashed-asset script but not other targets', () => {
    install();
    target.fire('error', {
      target: { tagName: 'IMG', src: 'https://x/assets/pic.png' },
    });
    expect(reload).not.toHaveBeenCalled();
    target.fire('error', {
      target: { tagName: 'SCRIPT', src: 'https://x/assets/index-abc.js' },
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
