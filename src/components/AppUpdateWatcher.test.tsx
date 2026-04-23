import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AppUpdateWatcher } from './AppUpdateWatcher';
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
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
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
