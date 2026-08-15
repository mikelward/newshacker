import { useRef, useSyncExternalStore } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudSyncDebugPanel } from '../components/CloudSyncDebugPanel';
import { LoadingState } from '../components/States';
import { HnFavoritesSyncDebugPanel } from '../components/HnFavoritesSyncDebugPanel';
import { buildCommitTime } from '../lib/buildInfo';
import { formatTimeAgo } from '../lib/format';
import {
  getPersistCacheStats,
  getPersistRestoreFailure,
} from '../lib/idbPersister';
import './DebugPage.css';

function formatChars(chars: number): string {
  if (chars >= 1024 * 1024) return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
  if (chars >= 1024) return `${Math.round(chars / 1024)} KB`;
  return `${chars} B`;
}

function parseBuildTime(iso: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface ServiceStatus {
  configured: boolean;
  reachable?: boolean;
  latencyMs?: number;
}

// `sync` is optional to stay forward-compatible with older deployments
// that haven't rolled out the extended /api/status shape yet. The UI
// falls back to the Redis status when it's missing.
interface StatusResponse {
  region: string | null;
  build: string | null;
  services: {
    gemini: ServiceStatus;
    jina: ServiceStatus;
    redis: ServiceStatus;
    sync?: ServiceStatus;
  };
}

async function fetchStatus(signal?: AbortSignal): Promise<StatusResponse> {
  const res = await fetch('/api/status', { signal });
  if (!res.ok) {
    throw new Error(`Status endpoint returned ${res.status}`);
  }
  return (await res.json()) as StatusResponse;
}

function formatServiceLine(status: ServiceStatus): string {
  if (!status.configured) return 'not configured';
  if (status.reachable === undefined) return 'configured';
  if (status.reachable) {
    const latency =
      status.latencyMs !== undefined ? ` · ${status.latencyMs} ms` : '';
    return `configured · reachable${latency}`;
  }
  return 'configured · unreachable';
}

function serviceBadgeState(status: ServiceStatus): 'ok' | 'warn' | 'off' {
  if (!status.configured) return 'off';
  if (status.reachable === false) return 'warn';
  return 'ok';
}

export function DebugPage() {
  // Module state written at boot, so a plain read is enough — there is
  // nothing to subscribe to that could change while this page is open.
  const restoreFailure = getPersistRestoreFailure();
  const queryClient = useQueryClient();
  const queryCache = queryClient.getQueryCache();
  // Re-render whenever the census below could have changed: a query
  // entering or leaving the cache. Family counts only move on
  // added/removed, so the far chattier per-fetch 'updated' events cause
  // no render churn. The subscription only forces renders — the census
  // (and the persist counters read next, which any render refreshes)
  // recompute in render as before.
  const censusVersionRef = useRef(0);
  useSyncExternalStore(
    (onStoreChange) =>
      queryCache.subscribe((event) => {
        if (event.type === 'added' || event.type === 'removed') {
          censusVersionRef.current += 1;
          onStoreChange();
        }
      }),
    () => censusVersionRef.current,
  );
  const cacheStats = getPersistCacheStats();
  // Live query-cache census by key family. After boot the hydrated cache
  // holds everything the persisted blob restored, so this is what answers
  // "what is the blob full of?" — the per-comment entries (7-day gcTime,
  // one query per comment ever rendered) are the expected top family on
  // a long-lived profile. Computed on render; /debug is an operator
  // surface and a few thousand map lookups are nothing next to the
  // restore cost being diagnosed.
  const familyCounts = new Map<string, number>();
  for (const query of queryCache.getAll()) {
    const family = String(query.queryKey[0]);
    familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
  }
  const families = [...familyCounts.entries()].sort((a, b) => b[1] - a[1]);
  const totalQueries = families.reduce((sum, [, n]) => sum + n, 0);
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['debug-status'],
    queryFn: ({ signal }) => fetchStatus(signal),
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  return (
    <article className="debug-page">
      <h1 className="debug-page__title">Debug</h1>

      {/* Boot-time, once per session, and outside the /api/status gate
          on purpose: a device whose persisted cache won't restore is
          exactly the one that may not be able to load status either. */}
      {restoreFailure && (
        <p className="debug-page__alert" role="status">
          Cache restore failed (<code>{restoreFailure.error}</code>) — the
          persisted cache was discarded and refetched.
        </p>
      )}

      {/* Local-only, so rendered outside the /api/status gate like the
          restore alert: the boot cost being diagnosed here exists whether
          or not the status endpoint answers. */}
      <h2 className="debug-page__heading">Persisted cache</h2>
      <dl className="debug-page__list">
        <div>
          <dt>Restore</dt>
          <dd>
            {/* Presence keys on restoredChars, not restoreMs: the restore
                is timed even when it finds nothing, so a fresh profile
                would otherwise read "0 ms" instead of saying no blob
                existed. */}
            {cacheStats.restoredChars !== null ? (
              <>
                {cacheStats.restoreMs !== null
                  ? `${cacheStats.restoreMs} ms`
                  : 'restored'}
                <span className="debug-page__muted">
                  {' '}
                  · {formatChars(cacheStats.restoredChars)} blob
                </span>
              </>
            ) : (
              <em>no persisted cache found</em>
            )}
          </dd>
        </div>
        <div>
          <dt>Snapshots</dt>
          <dd>
            {cacheStats.persistCount} written this session
            {cacheStats.lastPersistChars !== null && (
              <span className="debug-page__muted">
                {' '}
                · last {formatChars(cacheStats.lastPersistChars)}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Queries</dt>
          <dd>
            {totalQueries}
            {families.length > 0 && (
              <span className="debug-page__muted">
                {' '}
                (
                {families
                  .slice(0, 6)
                  .map(([family, count]) => `${family}: ${count}`)
                  .join(', ')}
                {families.length > 6 ? ', …' : ''})
              </span>
            )}
          </dd>
        </div>
      </dl>

      {isLoading ? (
        <LoadingState showLabel label="Loading status…" />
      ) : isError || !data ? (
        <p role="alert">
          Could not load status.{' '}
          <button
            type="button"
            className="debug-page__refresh"
            onClick={() => refetch()}
          >
            Retry
          </button>
        </p>
      ) : (
        <>
          <h2 className="debug-page__heading">Deployment</h2>
          <dl className="debug-page__list">
            <div>
              <dt>Region</dt>
              <dd>{data.region ?? <em>unknown</em>}</dd>
            </div>
            <div>
              <dt>Build</dt>
              <dd>
                {data.build ? (
                  <code>{data.build.slice(0, 7)}</code>
                ) : (
                  <em>unknown</em>
                )}
              </dd>
            </div>
            <div>
              <dt>Built</dt>
              <dd>
                {(() => {
                  const built = parseBuildTime(buildCommitTime);
                  if (!built) return <em>unknown</em>;
                  return (
                    <>
                      <time dateTime={built.toISOString()}>
                        {built.toLocaleString()}
                      </time>{' '}
                      <span className="debug-page__muted">
                        ({formatTimeAgo(Math.floor(built.getTime() / 1000))}{' '}
                        ago)
                      </span>
                    </>
                  );
                })()}
              </dd>
            </div>
          </dl>

          <h2 className="debug-page__heading">Services</h2>
          <ul className="debug-page__services">
            {(
              [
                ['Gemini', data.services.gemini],
                ['Jina', data.services.jina],
                ['Redis', data.services.redis],
                // Sync uses the same Redis store; report it separately
                // so the /debug UI makes the "sync will work" signal
                // explicit instead of requiring the user to infer it.
                ['Sync', data.services.sync ?? data.services.redis],
              ] as const
            ).map(([label, status]) => (
              <li key={label} className="debug-page__service">
                <span
                  className="debug-page__badge"
                  data-state={serviceBadgeState(status)}
                  aria-hidden="true"
                />
                <span className="debug-page__service-name">{label}</span>
                <span className="debug-page__service-detail">
                  {formatServiceLine(status)}
                </span>
              </li>
            ))}
          </ul>

          <p className="debug-page__actions">
            <button
              type="button"
              className="debug-page__refresh"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              {isFetching ? 'Refreshing…' : 'Refresh'}
            </button>
          </p>

          <CloudSyncDebugPanel />

          <HnFavoritesSyncDebugPanel />
        </>
      )}

      <p className="debug-page__back">
        <Link to="/top">← Back to Top</Link>
      </p>
    </article>
  );
}
