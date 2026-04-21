import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CloudSyncDebugPanel } from './CloudSyncDebugPanel';
import type { CloudSyncDebugSnapshot } from '../lib/cloudSync';

function snap(overrides: Partial<CloudSyncDebugSnapshot> = {}): CloudSyncDebugSnapshot {
  return {
    running: true,
    username: 'alice',
    lastPushed: { pinned: 0, favorite: 0, hidden: 0, done: 0 },
    pendingCount: { pinned: 0, favorite: 0, hidden: 0, done: 0 },
    push: { inFlight: false, queued: false, timerPending: false },
    lastPull: null,
    lastPush: null,
    ...overrides,
  };
}

describe('<CloudSyncDebugPanel>', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a "not running" state when sync is stopped', () => {
    render(
      <CloudSyncDebugPanel
        getSnapshot={() => snap({ running: false, username: null })}
        subscribe={() => () => {}}
      />,
    );
    expect(screen.getByText(/not running/i)).toBeInTheDocument();
    // Both buttons disabled when we're not running.
    expect(screen.getByTestId('cloud-sync-pull-now')).toBeDisabled();
    expect(screen.getByTestId('cloud-sync-push-now')).toBeDisabled();
  });

  it('shows the signed-in username and pending-count summary', () => {
    render(
      <CloudSyncDebugPanel
        getSnapshot={() =>
          snap({
            pendingCount: { pinned: 2, favorite: 1, hidden: 0, done: 0 },
          })
        }
        subscribe={() => () => {}}
      />,
    );
    expect(screen.getByText(/running as/i)).toBeInTheDocument();
    expect(screen.getByText(/alice/i)).toBeInTheDocument();
    expect(
      screen.getByText(/pinned 2, favorite 1, hidden 0, done 0/i),
    ).toBeInTheDocument();
  });

  it('renders last pull / last push with counts and status', () => {
    const now = Date.now();
    render(
      <CloudSyncDebugPanel
        getSnapshot={() =>
          snap({
            lastPull: {
              at: now - 3000,
              ok: true,
              status: 200,
              counts: { pinned: 3, favorite: 1, hidden: 0, done: 0 },
            },
            lastPush: {
              at: now - 15000,
              ok: false,
              status: 503,
              counts: { pinned: 1, favorite: 0, hidden: 0, done: 0 },
            },
          })
        }
        subscribe={() => () => {}}
      />,
    );
    expect(
      screen.getByText(/GET → 200.*pinned 3, favorite 1, hidden 0, done 0/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/POST → 503.*failed.*pinned 1/i),
    ).toBeInTheDocument();
  });

  it('Pull now calls triggerPull and re-reads the snapshot', async () => {
    const triggerPull = vi.fn().mockResolvedValue(undefined);
    let call = 0;
    const getSnapshot = vi.fn(() => {
      call += 1;
      return snap({
        lastPull:
          call > 1
            ? {
                at: Date.now(),
                ok: true,
                status: 200,
                counts: { pinned: 0, favorite: 0, hidden: 0, done: 0 },
              }
            : null,
      });
    });
    render(
      <CloudSyncDebugPanel
        getSnapshot={getSnapshot}
        subscribe={() => () => {}}
        triggerPull={triggerPull}
      />,
    );
    // Initial render: no last-pull text.
    expect(screen.getByText(/GET: never/i)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByTestId('cloud-sync-pull-now'));

    expect(triggerPull).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByText(/GET → 200/)).toBeInTheDocument();
    });
  });

  it('Push now calls triggerPush and re-reads the snapshot', async () => {
    const triggerPush = vi.fn().mockResolvedValue(undefined);
    const getSnapshot = vi.fn(() =>
      snap({
        pendingCount: { pinned: 1, favorite: 0, hidden: 0, done: 0 },
      }),
    );
    render(
      <CloudSyncDebugPanel
        getSnapshot={getSnapshot}
        subscribe={() => () => {}}
        triggerPush={triggerPush}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId('cloud-sync-push-now'));
    expect(triggerPush).toHaveBeenCalledTimes(1);
  });

  it('re-renders when subscribe fires', () => {
    let listener: (() => void) | null = null;
    let counts = { pinned: 0, favorite: 0, hidden: 0, done: 0 };
    const getSnapshot = () =>
      snap({ pendingCount: { ...counts } });
    const subscribe = (cb: () => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    };
    render(
      <CloudSyncDebugPanel getSnapshot={getSnapshot} subscribe={subscribe} />,
    );
    expect(screen.getByText(/no unpushed changes/i)).toBeInTheDocument();

    counts = { pinned: 5, favorite: 0, hidden: 0, done: 0 };
    act(() => {
      listener?.();
    });
    expect(
      screen.getByText(/pinned 5, favorite 0, hidden 0, done 0/i),
    ).toBeInTheDocument();
  });
});
