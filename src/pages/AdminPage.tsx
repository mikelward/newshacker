import { Link, Navigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ME_QUERY_KEY, useAuth } from '../hooks/useAuth';
import './AdminPage.css';

// Mirrors api/admin.ts AdminResponse. Kept local so we don't reach
// across the src/api boundary (api/*.ts files aren't source-shared).
interface ServiceProbe {
  configured: boolean;
  reachable?: boolean;
  latencyMs?: number;
}

interface JinaAccount {
  configured: boolean;
  reachable?: boolean;
  httpStatus?: number;
  regularBalance?: number | null;
  totalBalance?: number | null;
  threshold?: number | null;
  raw?: unknown;
}

interface AdminResponse {
  username: string;
  region: string | null;
  build: string | null;
  services: {
    gemini: ServiceProbe;
    jina: JinaAccount;
    redis: ServiceProbe;
  };
}

interface ForbiddenPayload {
  error?: string;
  reason?: string;
  signedInAs?: string;
  // Populated for `not_logged_in` / `hn_status_*` so the operator
  // can see what HN actually returned to the server-side probe.
  hnStatus?: number;
  hnSnippet?: string;
}

async function fetchAdmin(signal?: AbortSignal): Promise<AdminResponse> {
  const res = await fetch('/api/admin', { signal });
  if (res.status === 401) throw new AdminError('unauthenticated', 401);
  if (res.status === 403) {
    let payload: ForbiddenPayload = {};
    try {
      payload = (await res.json()) as ForbiddenPayload;
    } catch {
      // Non-JSON 403 — fall through with an empty payload.
    }
    throw new AdminError('forbidden', 403, payload);
  }
  if (res.status === 503) {
    let payload: ForbiddenPayload = {};
    try {
      payload = (await res.json()) as ForbiddenPayload;
    } catch {
      // ignore
    }
    throw new AdminError('unavailable', 503, payload);
  }
  if (!res.ok) throw new AdminError(`http_${res.status}`, res.status);
  return (await res.json()) as AdminResponse;
}

class AdminError extends Error {
  readonly status: number;
  readonly payload: ForbiddenPayload;
  constructor(kind: string, status: number, payload: ForbiddenPayload = {}) {
    super(kind);
    this.name = 'AdminError';
    this.status = status;
    this.payload = payload;
  }
}

// Human-facing explanation of a 403 reason. Deliberately terse — the
// page is only ever seen by the operator debugging their own access.
function forbiddenMessage(payload: ForbiddenPayload): string {
  const who = payload.signedInAs ? ` as ${payload.signedInAs}` : '';
  switch (payload.reason) {
    case 'admin_user_mismatch':
      return `You are signed in${who}, but this page is only available to the site operator. If you are the operator, set the ADMIN_USERNAME environment variable to match your HN username.`;
    case 'not_logged_in':
      return 'Hacker News does not consider this session logged in. Try signing out and signing back in.';
    case 'timeout':
      return 'Timed out verifying your session with Hacker News. Try again in a moment.';
    case 'unreachable':
      return 'Could not reach Hacker News to verify your session. Try again in a moment.';
    default:
      if (payload.reason?.startsWith('hn_status_')) {
        return `Hacker News returned an unexpected response (${payload.reason.replace('hn_status_', 'HTTP ')}) while verifying your session.`;
      }
      return 'This page is only available to the site operator.';
  }
}

function serviceBadge(state: 'ok' | 'warn' | 'off'): JSX.Element {
  return <span className="admin-page__badge" data-state={state} aria-hidden="true" />;
}

function probeState(p: ServiceProbe): 'ok' | 'warn' | 'off' {
  if (!p.configured) return 'off';
  if (p.reachable === false) return 'warn';
  return 'ok';
}

function probeDetail(p: ServiceProbe): string {
  if (!p.configured) return 'not configured';
  if (p.reachable === undefined) return 'configured';
  if (p.reachable) {
    const latency = p.latencyMs !== undefined ? ` · ${p.latencyMs} ms` : '';
    return `configured · reachable${latency}`;
  }
  return 'configured · unreachable';
}

function jinaState(j: JinaAccount): 'ok' | 'warn' | 'off' {
  if (!j.configured) return 'off';
  if (j.reachable === false) return 'warn';
  // Below the operator-configured threshold counts as warn so the
  // dot turns orange even if everything else is healthy.
  if (
    typeof j.threshold === 'number' &&
    typeof j.totalBalance === 'number' &&
    j.totalBalance <= j.threshold
  ) {
    return 'warn';
  }
  return 'ok';
}

function jinaDetail(j: JinaAccount): string {
  if (!j.configured) return 'not configured';
  if (j.reachable === false) {
    return j.httpStatus
      ? `configured · unreachable (HTTP ${j.httpStatus})`
      : 'configured · unreachable';
  }
  // Tri-state: only claim "reachable" when the server actually says
  // so. `undefined` means the probe didn't run (or the response
  // shape is older than this client) — don't paint it green.
  if (j.reachable === true) return 'configured · reachable';
  return 'configured';
}

function formatAmount(n: number | null | undefined): string {
  if (n === undefined) return 'unavailable';
  if (n === null) return 'unknown';
  // The dashboard displays raw token counts without currency — the
  // "wallet" values are Jina API tokens, not dollars. Keep the
  // locale-aware thousands separator so large balances are
  // readable.
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function AdminPage() {
  const auth = useAuth();
  const client = useQueryClient();
  const location = useLocation();

  // Don't even attempt to fetch until we know the user is logged in —
  // an anonymous fetch would get a 401 and flash an error panel before
  // we redirect. Running the query conditionally avoids that.
  const enabled = auth.isAuthenticated;
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['admin-status'],
    queryFn: ({ signal }) => fetchAdmin(signal),
    enabled,
    // `staleTime: 0` so a manual refresh always refetches; the
    // default `gcTime` (~5 min) lets `/tuning` paint from cache
    // when the operator navigates between the two pages without
    // burning a second HN round-trip.
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (auth.isLoading) {
    return (
      <article className="admin-page">
        <h1 className="admin-page__title">Admin</h1>
        <p aria-busy="true">Loading…</p>
      </article>
    );
  }

  if (!auth.isAuthenticated) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname }}
      />
    );
  }

  // `useAuth` caches /api/me for up to an hour, so the client can
  // still think it's authenticated after the server-side session
  // cookie has expired or been cleared. When /api/admin returns 401
  // ("Not authenticated"), treat that as authoritative: clear the
  // cached "me" and bounce to /login. Otherwise the user would be
  // stuck on a generic "could not load" error.
  if (error instanceof AdminError && error.status === 401) {
    client.setQueryData(ME_QUERY_KEY, null);
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname }}
      />
    );
  }

  // The server is the authority on who counts as admin (ADMIN_USERNAME
  // env var, defaults to mikelward). A client-side username check would
  // be cosmetic only — real access control happens in /api/admin. But
  // surfacing a clean "forbidden" page is nicer than a raw error panel
  // when a logged-in non-admin lands here.
  if (
    error instanceof AdminError &&
    (error.status === 403 || error.status === 503)
  ) {
    const { reason, hnStatus, hnSnippet } = error.payload;
    const showHnDiagnostic =
      reason === 'not_logged_in' || reason?.startsWith('hn_status_');
    return (
      <article className="admin-page">
        <h1 className="admin-page__title">Admin</h1>
        <p role="alert">{forbiddenMessage(error.payload)}</p>
        {showHnDiagnostic && (hnStatus !== undefined || hnSnippet) ? (
          <details className="admin-page__details">
            <summary>What Hacker News returned</summary>
            {hnStatus !== undefined ? (
              <p>
                HTTP <code>{hnStatus}</code>
              </p>
            ) : null}
            {hnSnippet ? (
              <pre className="admin-page__raw">{hnSnippet}</pre>
            ) : null}
          </details>
        ) : null}
        <p className="admin-page__back">
          <Link to="/top">← Back to Top</Link>
        </p>
      </article>
    );
  }

  return (
    <article className="admin-page">
      <h1 className="admin-page__title">Admin</h1>
      <p className="admin-page__intro">
        Operator dashboard. Not linked from the app UI for other users;
        access is checked server-side on every request.
      </p>

      {isLoading ? (
        <p aria-busy="true">Loading status…</p>
      ) : isError || !data ? (
        <p role="alert">
          Could not load admin status.{' '}
          <button
            type="button"
            className="admin-page__refresh"
            onClick={() => refetch()}
          >
            Retry
          </button>
        </p>
      ) : (
        <>
          <h2 className="admin-page__heading">Identity</h2>
          <dl className="admin-page__list">
            <div>
              <dt>Signed in as</dt>
              <dd>
                <code>{data.username}</code>
              </dd>
            </div>
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

          <h2 className="admin-page__heading">Gemini</h2>
          <div className="admin-page__service-row">
            {serviceBadge(probeState(data.services.gemini))}
            <span className="admin-page__service-name">Gemini</span>
            <span className="admin-page__service-detail">
              {probeDetail(data.services.gemini)}
            </span>
          </div>
          <p className="admin-page__note">
            Google does not expose per-API-key quota or billing over the
            public API.{' '}
            <a
              href="https://aistudio.google.com/app/apikey"
              target="_blank"
              rel="noreferrer noopener"
            >
              Open Google AI Studio
            </a>{' '}
            to see usage and billing.
          </p>

          <h2 className="admin-page__heading">Jina</h2>
          <div className="admin-page__service-row">
            {serviceBadge(jinaState(data.services.jina))}
            <span className="admin-page__service-name">Jina</span>
            <span className="admin-page__service-detail">
              {jinaDetail(data.services.jina)}
            </span>
          </div>
          {data.services.jina.configured &&
          data.services.jina.reachable === true ? (
            <dl className="admin-page__list">
              <div>
                <dt>Total balance</dt>
                <dd data-testid="admin-jina-total-balance">
                  {formatAmount(data.services.jina.totalBalance)}
                </dd>
              </div>
              <div>
                <dt>Regular balance</dt>
                <dd data-testid="admin-jina-regular-balance">
                  {formatAmount(data.services.jina.regularBalance)}
                </dd>
              </div>
              <div>
                <dt>Alert threshold</dt>
                <dd data-testid="admin-jina-threshold">
                  {formatAmount(data.services.jina.threshold)}
                </dd>
              </div>
            </dl>
          ) : null}
          {data.services.jina.raw !== undefined ? (
            <details className="admin-page__details">
              <summary>Raw response from Jina</summary>
              <pre className="admin-page__raw">
                {JSON.stringify(data.services.jina.raw, null, 2)}
              </pre>
            </details>
          ) : null}
          <p className="admin-page__note">
            Balance comes from Jina's undocumented dashboard backend —
            if numbers look wrong, cross-check against the{' '}
            <a
              href="https://jina.ai/api-dashboard/"
              target="_blank"
              rel="noreferrer noopener"
            >
              Jina dashboard
            </a>
            .
          </p>

          <h2 className="admin-page__heading">Redis (Upstash)</h2>
          <div className="admin-page__service-row">
            {serviceBadge(probeState(data.services.redis))}
            <span className="admin-page__service-name">Redis</span>
            <span className="admin-page__service-detail">
              {probeDetail(data.services.redis)}
            </span>
          </div>

          <p className="admin-page__actions">
            <button
              type="button"
              className="admin-page__refresh"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              {isFetching ? 'Refreshing…' : 'Refresh'}
            </button>
          </p>
        </>
      )}

      <h2 className="admin-page__heading">Hot threshold tuning</h2>
      <p>
        <Link to="/tuning">Open the threshold tuning view →</Link>
      </p>
      <p className="admin-page__note">
        Score, age, and comment count for the first time you pinned
        or hid each story, with an interactive expression + slider
        preview for the <code>isHotStory</code> rule.
      </p>

      <p className="admin-page__back">
        <Link to="/top">← Back to Top</Link>
      </p>
    </article>
  );
}
