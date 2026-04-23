import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkForServiceWorkerUpdate } from './swUpdate';

type Listener = () => void;

interface FakeRegistration {
  update: ReturnType<typeof vi.fn>;
  installing: unknown;
  waiting: unknown;
}

function makeServiceWorker(
  registration: FakeRegistration | null,
  initialController: unknown = null,
) {
  const listeners = new Set<Listener>();
  const sw = {
    controller: initialController,
    getRegistration: vi.fn().mockResolvedValue(registration),
    addEventListener: vi.fn((event: string, listener: Listener) => {
      if (event === 'controllerchange') listeners.add(listener);
    }),
    removeEventListener: vi.fn((event: string, listener: Listener) => {
      if (event === 'controllerchange') listeners.delete(listener);
    }),
  };
  return {
    sw,
    fireControllerChange() {
      for (const l of Array.from(listeners)) l();
    },
    setController(next: unknown) {
      sw.controller = next;
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

describe('checkForServiceWorkerUpdate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('is a no-op when serviceWorker is not in navigator', async () => {
    vi.stubGlobal('navigator', {});
    const reload = vi.fn();
    await checkForServiceWorkerUpdate({ reload });
    expect(reload).not.toHaveBeenCalled();
  });

  it('is a no-op when no service worker is registered', async () => {
    const { sw } = makeServiceWorker(null);
    vi.stubGlobal('navigator', { serviceWorker: sw });
    const reload = vi.fn();
    await checkForServiceWorkerUpdate({ reload });
    expect(sw.getRegistration).toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('calls registration.update() but does not reload when no new SW is found', async () => {
    const registration: FakeRegistration = {
      update: vi.fn().mockResolvedValue(undefined),
      installing: null,
      waiting: null,
    };
    const { sw, listenerCount } = makeServiceWorker(registration);
    vi.stubGlobal('navigator', { serviceWorker: sw });
    const reload = vi.fn();
    await checkForServiceWorkerUpdate({ reload });
    expect(registration.update).toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    // Listener + timer were cleaned up — nothing leaking.
    expect(listenerCount()).toBe(0);
  });

  it('attaches the controllerchange listener before calling update()', async () => {
    let listenerAttachedBeforeUpdate = false;
    const sw = {
      controller: null as unknown,
      getRegistration: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    // Listener must be attached before update() is invoked so we can't
    // miss a `controllerchange` fired during the update itself.
    const registration: FakeRegistration = {
      update: vi.fn(() => {
        listenerAttachedBeforeUpdate =
          (sw.addEventListener as ReturnType<typeof vi.fn>).mock.calls.some(
            (call) => call[0] === 'controllerchange',
          );
        return Promise.resolve(undefined);
      }),
      installing: null,
      waiting: null,
    };
    sw.getRegistration = vi.fn().mockResolvedValue(registration);
    vi.stubGlobal('navigator', { serviceWorker: sw });
    await checkForServiceWorkerUpdate({ reload: vi.fn() });
    expect(listenerAttachedBeforeUpdate).toBe(true);
  });

  it('reloads the page once a newly-installed SW takes control', async () => {
    const registration: FakeRegistration = {
      update: vi.fn().mockResolvedValue(undefined),
      installing: { state: 'installing' },
      waiting: null,
    };
    const { sw, fireControllerChange } = makeServiceWorker(registration);
    vi.stubGlobal('navigator', { serviceWorker: sw });
    const reload = vi.fn();
    const promise = checkForServiceWorkerUpdate({ reload, timeoutMs: 5000 });
    // Let the update() microtask settle so the post-update check has
    // run before we fire the event.
    await Promise.resolve();
    await Promise.resolve();
    fireControllerChange();
    await promise;
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads when the controller swapped before update() resolved', async () => {
    // The race Copilot flagged: with skipWaiting + clientsClaim, the
    // new SW can activate and fire `controllerchange` so fast that
    // by the time update() resolves, `installing`/`waiting` are both
    // null. Snapshotting `controller` before + after catches this.
    const oldController = { id: 'old' };
    const newController = { id: 'new' };
    const registration: FakeRegistration = {
      update: vi.fn(async () => {
        // Simulate the swap happening inside the update window.
        setController(newController);
      }),
      installing: null,
      waiting: null,
    };
    const { sw, setController } = makeServiceWorker(registration, oldController);
    vi.stubGlobal('navigator', { serviceWorker: sw });
    const reload = vi.fn();
    await checkForServiceWorkerUpdate({ reload });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload when the new SW never activates within the timeout', async () => {
    vi.useFakeTimers();
    const registration: FakeRegistration = {
      update: vi.fn().mockResolvedValue(undefined),
      installing: { state: 'installing' },
      waiting: null,
    };
    const { sw, listenerCount } = makeServiceWorker(registration);
    vi.stubGlobal('navigator', { serviceWorker: sw });
    const reload = vi.fn();
    const promise = checkForServiceWorkerUpdate({ reload, timeoutMs: 5000 });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5000);
    await promise;
    expect(reload).not.toHaveBeenCalled();
    expect(listenerCount()).toBe(0);
  });

  it('swallows errors from registration.update()', async () => {
    const registration: FakeRegistration = {
      update: vi.fn().mockRejectedValue(new Error('network down')),
      installing: null,
      waiting: null,
    };
    const { sw, listenerCount } = makeServiceWorker(registration);
    vi.stubGlobal('navigator', { serviceWorker: sw });
    const reload = vi.fn();
    await expect(
      checkForServiceWorkerUpdate({ reload }),
    ).resolves.toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
    // Even on a thrown update(), the listener + timer are cleaned up.
    expect(listenerCount()).toBe(0);
  });
});
