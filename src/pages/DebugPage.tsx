import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import './DebugPage.css';

interface ServiceStatus {
  configured: boolean;
  reachable?: boolean;
  latencyMs?: number;
}

interface StatusResponse {
  region: string | null;
  build: string | null;
  services: {
    gemini: ServiceStatus;
    jina: ServiceStatus;
    redis: ServiceStatus;
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
      <p className="debug-page__hint">
        Operator-visibility snapshot of which third-party services the
        current deployment is configured for and whether the Redis
        cache is reachable from this region.
      </p>

      {isLoading ? (
        <p aria-busy="true">Loading status…</p>
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
          </dl>

          <h2 className="debug-page__heading">Services</h2>
          <ul className="debug-page__services">
            {(
              [
                ['Gemini', data.services.gemini],
                ['Jina', data.services.jina],
                ['Redis', data.services.redis],
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
        </>
      )}

      <p className="debug-page__back">
        <Link to="/top">← Back to Top</Link>
      </p>
    </article>
  );
}
