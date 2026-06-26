import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  AppUpdateWatcher,
  SW_INSTALLED_FLAG,
  resetInstalledFlagWriteFailureForTests,
} from './AppUpdateWatcher';
import { ToastProvider } from './Toast';

vi.mock('../lib/swUpdate', () => ({
  pingServiceWorkerForUpdate: vi.fn().mockResolvedValue(undefined),
}));
import { pingServiceWorkerForUpdate } from '../lib/swUpdate';

interface Handles {
  sw: {
    controller: unknown;
    addEventListener: (e: string, l: EventListener) => void;
    removeEventListener: (e: string, l: EventListener) => void;
  };
  fireControllerChange: (next?: unknown) => void;
}

function stubServiceWorker(initialController: unknown): Handles {
  // Real EventTarget so the dispatched event flows through React via
  // the normal microtask machinery — manually invoking listeners
  // inside act() fought with the concurrent scheduler.
  const target = new EventTarget();
  const sw = {
    controller: initialController,
    addEventListener: (event: string, listener: EventListener) =>
      target.addEventListener(event, listener),
    removeEventListener: (event: string, listener: EventListener) =>
      target.removeEventListener(event, listener),
  };
  vi.stubGlobal('navigator', {
    ...window.navigator,
    serviceWorker: sw,
  });
  return {
    sw,
    fireControllerChange(next?: unknown) {
      if (next !== undefined) sw.controller = next;
      act(() => {
        target.dispatchEvent(new Event('controllerchange'));
      });
    },
  };
}

function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

describe('<AppUpdateWatcher>', () => {
  beforeEach(() => {
    // Each test starts on a fresh "this device has never installed
    // the SW" baseline so the install-suppression behavior is
    // deterministic.
    localStorage.removeItem(SW_INSTALLED_FLAG);
    // Clear the module-level write-failure latch so a test that tripped
    // it doesn't leave the watcher permanently failing open for the next.
    resetInstalledFlagWriteFailureForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    localStorage.removeItem(SW_INSTALLED_FLAG);
    // Reset visibilityState so a test that flipped it to 'hidden'
    // doesn't leak into the next. Using defineProperty directly
    // (no event dispatch) to avoid firing a visibilitychange at an
    // already-unmounted tree.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
  });

  it('shows a sticky update-available toast on controllerchange', () => {
    const { fireControllerChange } = stubServiceWorker({ id: 'old' });
    render(
      <ToastProvider>
        <AppUpdateWatcher reload={vi.fn()} />
      </ToastProvider>,
    );
    expect(screen.queryByText(/new version available/i)).toBeNull();
    fireControllerChange({ id: 'new' });
    expect(screen.getByText(/new version available/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /reload/i }),
    ).toBeInTheDocument();
  });

  it('calls the reload fn when the toast action is tapped', () => {
    const { fireControllerChange } = stubServiceWorker({ id: 'old' });
    const reload = vi.fn();
    render(
      <ToastProvider>
        <AppUpdateWatcher reload={reload} />
      </ToastProvider>,
    );
    fireControllerChange({ id: 'new' });
    fireEvent.click(screen.getByRole('button', { name: /reload/i }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('suppresses the toast on a first-ever SW activation (no prior controller)', () => {
    // Truly fresh visit: no SW was controlling the page at mount. The
    // initial install → activate → claim fires controllerchange too,
    // but the bundle is already current — no reason to nudge.
    const { fireControllerChange } = stubServiceWorker(null);
    render(
      <ToastProvider>
        <AppUpdateWatcher reload={vi.fn()} />
      </ToastProvider>,
    );
    fireControllerChange({ id: 'new' });
    expect(screen.queryByText(/new version available/i)).toBeNull();
  });

  it('still toasts on a later SW swap after a fresh-visit initial activation', () => {
    // Regression: the first-visit guard must only suppress the *first*
    // controllerchange (the initial install). A later deploy that
    // claims this tab should still surface the toast.
    const { fireControllerChange } = stubServiceWorker(null);
    render(
      <ToastProvider>
        <AppUpdateWatcher reload={vi.fn()} />
      </ToastProvider>,
    );
    fireControllerChange({ id: 'initial' });
    expect(screen.queryByText(/new version available/i)).toBeNull();
    fireControllerChange({ id: 'redeploy' });
    expect(screen.getByText(/new version available/i)).toBeInTheDocument();
  });

  it('toasts when controller is null at mount but the SW has been installed before', () => {
    // The bug that stranded users on stale bundles: on a hard-reload
    // (Cmd/Ctrl+Shift+R), Chrome session-restore, or an iOS PWA
    // relaunch, `navigator.serviceWorker.controller` can read null at
    // mount even though the SW was installed long ago. The previous
    // in-memory "null at mount" heuristic suppressed the next
    // controllerchange — i.e. the new SW claiming the stale tab —
    // and the user kept running old code until they refreshed enough
    // times for the browser to background-update again.
    localStorage.setItem(SW_INSTALLED_FLAG, '1');
    const { fireControllerChange } = stubServiceWorker(null);
    render(
      <ToastProvider>
        <AppUpdateWatcher reload={vi.fn()} />
      </ToastProvider>,
    );
    fireControllerChange({ id: 'new' });
    expect(screen.getByText(/new version available/i)).toBeInTheDocument();
  });

  it('fails open when localStorage is unavailable (Safari private mode etc.)', () => {
    // If readInstalledFlag returned `false` on a thrown getItem, the
    // watcher would treat the device as never-installed and suppress
    // *every* controllerchange — silently reintroducing the stale-tab
    // bug on browsers that disable storage. Verify the failure mode
    // is "show the toast" instead.
    const broken: Storage = {
      getItem: () => {
        throw new Error('SecurityError: localStorage disabled');
      },
      setItem: () => {
        throw new Error('SecurityError: localStorage disabled');
      },
      // No-op so the afterEach `removeItem(SW_INSTALLED_FLAG)` cleanup
      // doesn't throw before vitest restores the real localStorage.
      // The component never calls these — this test only exercises
      // getItem/setItem on the readInstalledFlag/writeInstalledFlag
      // path.
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };
    vi.stubGlobal('localStorage', broken);
    const { fireControllerChange } = stubServiceWorker(null);
    render(
      <ToastProvider>
        <AppUpdateWatcher reload={vi.fn()} />
      </ToastProvider>,
    );
    fireControllerChange({ id: 'new' });
    expect(screen.getByText(/new version available/i)).toBeInTheDocument();
    // Vitest's `unstubGlobals: true` restores the real localStorage
    // between tests automatically — no manual cleanup needed.
  });

  it('fails open on the first claim when localStorage reads work but writes are rejected (quota exceeded)', () => {
    // Safari quota-exceeded (and some private modes) answer getItem but
    // throw on setItem. With controller=null at mount — the documented
    // hard-reload / iOS-relaunch / session-restore case — the very first
    // controllerchange is the real update for an already-installed SW, yet
    // it enters the first-install branch (the flag never persisted, so
    // getItem returns null). writeInstalledFlag() then fails; the watcher
    // must fail open and toast on *this* claim, not suppress it and only
    // recover on a hypothetical second claim in the same JS lifetime —
    // every reload would otherwise swallow the real update.
    const store = new Map<string, string>();
    const writeRejecting: Storage = {
      getItem: (key) => store.get(key) ?? null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: (key) => {
        store.delete(key);
      },
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    };
    vi.stubGlobal('localStorage', writeRejecting);
    const { fireControllerChange } = stubServiceWorker(null);
    render(
      <ToastProvider>
        <AppUpdateWatcher reload={vi.fn()} />
      </ToastProvider>,
    );
    // First and only claim: write is rejected → fail open → toast now.
    fireControllerChange({ id: 'first' });
    expect(screen.getByText(/new version available/i)).toBeInTheDocument();
  });

  it('persists the installed flag once a controller is observed at mount', () => {
    // First mount with a controller already in place writes the flag,
    // so a subsequent session that mounts with controller=null is
    // recognized as "we've installed before" and toasts on the next
    // claim.
    stubServiceWorker({ id: 'ctrl' });
    const { unmount } = render(
      <ToastProvider>
        <AppUpdateWatcher reload={vi.fn()} />
      </ToastProvider>,
    );
    expect(localStorage.getItem(SW_INSTALLED_FLAG)).toBe('1');
    unmount();
  });

  it('pings the SW when the tab returns from hidden after the threshold', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T08:00:00Z'));
    stubServiceWorker({ id: 'ctrl' });
    render(
      <ToastProvider>
        <AppUpdateWatcher
          reload={vi.fn()}
          returnFromHiddenThresholdMs={30_000}
        />
      </ToastProvider>,
    );
    setVisibility('hidden');
    vi.setSystemTime(new Date('2026-04-23T08:01:00Z'));
    setVisibility('visible');
    expect(pingServiceWorkerForUpdate).toHaveBeenCalledTimes(1);
  });

  it('pings on first return when the tab was restored already-hidden', () => {
    // Session restore of a background tab: visibility is already 'hidden'
    // at mount, so no `hidden` visibilitychange ever fires for the watcher
    // to record. Seeding hiddenAt from the current state means the first
    // `visible` after a real absence still pings instead of being skipped.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T08:00:00Z'));
    stubServiceWorker({ id: 'ctrl' });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    render(
      <ToastProvider>
        <AppUpdateWatcher
          reload={vi.fn()}
          returnFromHiddenThresholdMs={30_000}
        />
      </ToastProvider>,
    );
    vi.setSystemTime(new Date('2026-04-23T08:01:00Z'));
    setVisibility('visible');
    expect(pingServiceWorkerForUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not ping the SW on a quick alt-tab', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T08:00:00Z'));
    stubServiceWorker({ id: 'ctrl' });
    render(
      <ToastProvider>
        <AppUpdateWatcher
          reload={vi.fn()}
          returnFromHiddenThresholdMs={30_000}
        />
      </ToastProvider>,
    );
    setVisibility('hidden');
    vi.setSystemTime(new Date('2026-04-23T08:00:10Z'));
    setVisibility('visible');
    expect(pingServiceWorkerForUpdate).not.toHaveBeenCalled();
  });

  it('pings the SW periodically while the tab stays visible', () => {
    vi.useFakeTimers();
    stubServiceWorker({ id: 'ctrl' });
    render(
      <ToastProvider>
        <AppUpdateWatcher reload={vi.fn()} periodicCheckMs={1000} />
      </ToastProvider>,
    );
    // Visible at mount, no navigation/PTR — only the periodic timer drives it.
    expect(pingServiceWorkerForUpdate).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(pingServiceWorkerForUpdate).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(pingServiceWorkerForUpdate).toHaveBeenCalledTimes(2);
  });

  it('pauses the periodic ping while hidden and resumes on return', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T08:00:00Z'));
    stubServiceWorker({ id: 'ctrl' });
    render(
      <ToastProvider>
        <AppUpdateWatcher
          reload={vi.fn()}
          periodicCheckMs={1000}
          returnFromHiddenThresholdMs={30_000}
        />
      </ToastProvider>,
    );
    setVisibility('hidden');
    // A hidden tab spends no bandwidth — the interval is torn down, so even
    // several periods' worth of elapsed time fires no ping.
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(pingServiceWorkerForUpdate).not.toHaveBeenCalled();
    // Back in view well under the return-from-hidden threshold, so that path
    // stays silent; only the re-armed periodic timer should ping.
    setVisibility('visible');
    expect(pingServiceWorkerForUpdate).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(pingServiceWorkerForUpdate).toHaveBeenCalledTimes(1);
  });

  it('stops the periodic ping after unmount', () => {
    vi.useFakeTimers();
    stubServiceWorker({ id: 'ctrl' });
    const { unmount } = render(
      <ToastProvider>
        <AppUpdateWatcher reload={vi.fn()} periodicCheckMs={1000} />
      </ToastProvider>,
    );
    unmount();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(pingServiceWorkerForUpdate).not.toHaveBeenCalled();
  });

  it('cleans up listeners on unmount', () => {
    const { fireControllerChange } = stubServiceWorker({ id: 'ctrl' });
    const { unmount } = render(
      <ToastProvider>
        <AppUpdateWatcher reload={vi.fn()} />
      </ToastProvider>,
    );
    unmount();
    fireControllerChange({ id: 'new' });
    expect(screen.queryByText(/new version available/i)).toBeNull();
  });
});
