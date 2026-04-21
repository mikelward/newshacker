import { useCallback, useEffect, useState } from 'react';
import {
  type CloudSyncDebugSnapshot,
  type LastRequest,
  getCloudSyncDebug,
  pullNow,
  pushNow,
  subscribeCloudSyncDebug,
} from '../lib/cloudSync';
import './CloudSyncDebugPanel.css';

// Live view of the cloudSync singleton's state, for on-device
// debugging of cross-device sync (cf. /debug). Mounted inside
// DebugPage. Re-renders on every pull/push transition via
// subscribeCloudSyncDebug plus a 1s fallback poll (catches timer
// countdowns and "X ago" relative labels refreshing).

function ago(at: number | undefined, now: number): string {
  if (!at) return 'never';
  const delta = Math.max(0, Math.round((now - at) / 1000));
  if (delta < 1) return 'just now';
  if (delta < 60) return `${delta} s ago`;
  const mins = Math.round(delta / 60);
  return mins === 1 ? '1 min ago' : `${mins} min ago`;
}

function formatCounts(
  counts: Record<'pinned' | 'favorite' | 'ignored', number> | undefined,
): string {
  if (!counts) return '—';
  return `pinned ${counts.pinned}, favorite ${counts.favorite}, ignored ${counts.ignored}`;
}

function describeLast(
  label: 'GET' | 'POST',
  r: LastRequest | null,
  now: number,
): string {
  if (!r) return `${label}: never`;
  const status = r.status !== undefined ? String(r.status) : 'network fail';
  const outcome = r.ok ? 'ok' : 'failed';
  const statusPart = r.ok
    ? `${label} → ${status}`
    : `${label} → ${status}${r.error ? ` · ${r.error}` : ''}`;
  const countsPart = r.counts ? ` · ${formatCounts(r.counts)}` : '';
  return `${statusPart} · ${outcome}${countsPart} · ${ago(r.at, now)}`;
}

function badgeFor(r: LastRequest | null): 'ok' | 'warn' | 'off' {
  if (!r) return 'off';
  return r.ok ? 'ok' : 'warn';
}

interface PanelProps {
  // Injection seams for tests; default to real module state.
  getSnapshot?: () => CloudSyncDebugSnapshot;
  subscribe?: (cb: () => void) => () => void;
  triggerPull?: () => Promise<void>;
  triggerPush?: () => Promise<void>;
}

export function CloudSyncDebugPanel({
  getSnapshot = getCloudSyncDebug,
  subscribe = subscribeCloudSyncDebug,
  triggerPull = pullNow,
  triggerPush = pushNow,
}: PanelProps = {}) {
  const [snapshot, setSnapshot] = useState<CloudSyncDebugSnapshot>(() =>
    getSnapshot(),
  );
  const [now, setNow] = useState<number>(() => Date.now());
  const [busy, setBusy] = useState<'pull' | 'push' | null>(null);

  const refresh = useCallback(() => {
    setSnapshot(getSnapshot());
    setNow(Date.now());
  }, [getSnapshot]);

  useEffect(() => {
    const unsubscribe = subscribe(refresh);
    const interval = window.setInterval(refresh, 1000);
    return () => {
      unsubscribe();
      window.clearInterval(interval);
    };
  }, [subscribe, refresh]);

  const onPull = useCallback(async () => {
    setBusy('pull');
    try {
      await triggerPull();
    } finally {
      setBusy(null);
      refresh();
    }
  }, [triggerPull, refresh]);

  const onPush = useCallback(async () => {
    setBusy('push');
    try {
      await triggerPush();
    } finally {
      setBusy(null);
      refresh();
    }
  }, [triggerPush, refresh]);

  const pending =
    snapshot.pendingCount.pinned +
    snapshot.pendingCount.favorite +
    snapshot.pendingCount.ignored;

  return (
    <section className="cloud-sync-debug" data-testid="cloud-sync-debug">
      <h2 className="debug-page__heading">Sync client</h2>
      <dl className="debug-page__list">
        <div>
          <dt>Status</dt>
          <dd>
            {snapshot.running ? (
              <>
                running as <code>{snapshot.username ?? '—'}</code>
              </>
            ) : (
              <em>not running (signed out)</em>
            )}
          </dd>
        </div>
        <div>
          <dt>Pending</dt>
          <dd>
            {pending === 0
              ? 'no unpushed changes'
              : formatCounts(snapshot.pendingCount)}
          </dd>
        </div>
        <div>
          <dt>Push</dt>
          <dd>
            {snapshot.push.inFlight
              ? 'in flight'
              : snapshot.push.queued
                ? 'queued'
                : snapshot.push.timerPending
                  ? 'debounced'
                  : 'idle'}
          </dd>
        </div>
      </dl>

      <ul className="cloud-sync-debug__requests">
        <li className="cloud-sync-debug__request">
          <span
            className="debug-page__badge"
            data-state={badgeFor(snapshot.lastPull)}
            aria-hidden="true"
          />
          <span className="cloud-sync-debug__request-label">Last pull</span>
          <span className="cloud-sync-debug__request-detail">
            {describeLast('GET', snapshot.lastPull, now)}
          </span>
        </li>
        <li className="cloud-sync-debug__request">
          <span
            className="debug-page__badge"
            data-state={badgeFor(snapshot.lastPush)}
            aria-hidden="true"
          />
          <span className="cloud-sync-debug__request-label">Last push</span>
          <span className="cloud-sync-debug__request-detail">
            {describeLast('POST', snapshot.lastPush, now)}
          </span>
        </li>
      </ul>

      <p className="debug-page__actions">
        <button
          type="button"
          className="debug-page__refresh"
          onClick={onPull}
          disabled={busy !== null || !snapshot.running}
          data-testid="cloud-sync-pull-now"
        >
          {busy === 'pull' ? 'Pulling…' : 'Pull now'}
        </button>{' '}
        <button
          type="button"
          className="debug-page__refresh"
          onClick={onPush}
          disabled={busy !== null || !snapshot.running}
          data-testid="cloud-sync-push-now"
        >
          {busy === 'push' ? 'Pushing…' : 'Push now'}
        </button>
      </p>
    </section>
  );
}
