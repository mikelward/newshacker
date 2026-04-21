import { useEffect, useState } from 'react';
import { getHnFavoritesSyncDebug } from '../lib/hnFavoritesSync';
import './CloudSyncDebugPanel.css';

// Lightweight read-only view of the HN-favorites sync singleton,
// shown alongside CloudSyncDebugPanel on /debug. Polls every second —
// we don't ship a subscribe() on the sync module yet because the
// running/queue counts only change on bootstrap, enqueue, or worker
// tick, each of which is an event the user is waiting for a visible
// confirmation of.

function ago(at: number | undefined, now: number): string {
  if (!at) return 'never';
  const delta = Math.max(0, Math.round((now - at) / 1000));
  if (delta < 1) return 'just now';
  if (delta < 60) return `${delta} s ago`;
  const mins = Math.round(delta / 60);
  return mins === 1 ? '1 min ago' : `${mins} min ago`;
}

export function HnFavoritesSyncDebugPanel() {
  const [snapshot, setSnapshot] = useState(() => getHnFavoritesSyncDebug());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      setSnapshot(getHnFavoritesSyncDebug());
      setNow(Date.now());
    }, 1_000);
    return () => clearInterval(id);
  }, []);

  const bootstrapLine = snapshot.lastBootstrap
    ? `${snapshot.lastBootstrap.ok ? 'ok' : 'failed'}${
        snapshot.lastBootstrap.status !== undefined
          ? ` (${snapshot.lastBootstrap.status})`
          : ''
      }${
        snapshot.lastBootstrap.idsAdded !== undefined
          ? ` · ${snapshot.lastBootstrap.idsAdded} added`
          : ''
      }${
        snapshot.lastBootstrap.error
          ? ` · ${snapshot.lastBootstrap.error}`
          : ''
      } · ${ago(snapshot.lastBootstrap.at, now)}`
    : 'never';

  const workerLine = snapshot.lastWorkerAttempt
    ? `${snapshot.lastWorkerAttempt.action} #${snapshot.lastWorkerAttempt.id} → ${
        snapshot.lastWorkerAttempt.ok ? 'ok' : 'failed'
      }${
        snapshot.lastWorkerAttempt.status !== undefined
          ? ` (${snapshot.lastWorkerAttempt.status})`
          : ''
      }${
        snapshot.lastWorkerAttempt.error
          ? ` · ${snapshot.lastWorkerAttempt.error}`
          : ''
      } · ${ago(snapshot.lastWorkerAttempt.at, now)}`
    : 'never';

  return (
    <section className="cloud-sync-debug">
      <h2 className="debug-page__heading">HN favorites sync</h2>
      <dl className="debug-page__list">
        <div>
          <dt>Status</dt>
          <dd>
            {snapshot.running
              ? snapshot.stalledOnAuth
                ? 'running · stalled on auth'
                : snapshot.bootstrapped
                  ? 'running · bootstrapped'
                  : 'running · bootstrap pending'
              : 'not running (not signed in)'}
          </dd>
        </div>
        <div>
          <dt>User</dt>
          <dd>{snapshot.username ?? <em>—</em>}</dd>
        </div>
        <div>
          <dt>Queue</dt>
          <dd>{snapshot.queueLength} pending</dd>
        </div>
        <div>
          <dt>Last bootstrap</dt>
          <dd>{bootstrapLine}</dd>
        </div>
        <div>
          <dt>Last worker action</dt>
          <dd>{workerLine}</dd>
        </div>
      </dl>
    </section>
  );
}
