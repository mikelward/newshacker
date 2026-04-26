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

// Mirrors api/admin-stats.ts StatsResponse — kept local per the same
// "no cross-boundary imports" convention as AdminResponse above.
type CardResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

interface CacheHitsValue {
  windowSeconds: number;
  byOutcome: Record<string, number>;
}
interface TokensValue {
  windowSeconds: number;
  geminiTotalTokens: number;
  jinaTokens: number;
}
interface FailuresValue {
  windowSeconds: number;
  byReason: { reason: string; count: number }[];
}
interface RateLimitValue {
  windowSeconds: number;
  count: number;
}
interface WarmCronValue {
  windowSeconds: number;
  lastRun: {
    tISO: string;
    durationMs: number | null;
    processed: number | null;
    storyCount: number | null;
  } | null;
}

interface StatsResponse {
  configured: boolean;
  axiom: { tokenConfigured: boolean; dataset: string | null };
  cards: {
    cacheHits: CardResult<CacheHitsValue>;
    tokens: CardResult<TokensValue>;
    failures: CardResult<FailuresValue>;
    rateLimit: CardResult<RateLimitValue>;
    warmCron: CardResult<WarmCronValue>;
  } | null;
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

async function fetchAdminStats(signal?: AbortSignal): Promise<StatsResponse> {
  const res = await fetch('/api/admin-stats', { signal });
  if (!res.ok) {
    // Auth errors are surfaced through the primary /api/admin fetch's
    // gate; if the analytics endpoint disagrees we treat it as a soft
    // failure so the rest of the page still renders.
    throw new Error(`http_${res.status}`);
  }
  return (await res.json()) as StatsResponse;
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

function formatWindow(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const d = seconds / 86_400;
    return d === 1 ? 'last 24h' : `last ${d}d`;
  }
  if (seconds % 3_600 === 0) {
    const h = seconds / 3_600;
    return h === 1 ? 'last hour' : `last ${h}h`;
  }
  return `last ${seconds}s`;
}

function formatInteger(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatRelativeTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const seconds = Math.max(0, Math.round((now - t) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Cache-hit ratio: served-without-Gemini-call ÷ total. `cached` is
// the only outcome that actually returns from the warm cache;
// `generated` cost a Gemini call. `rate_limited` and `error` aren't
// successful serves either — they're in the denominator only because
// "the cache helped on N % of the work the endpoint did" is the
// metric the operator wants. Returns null when the bucket was empty
// (no work happened in the window).
function cacheHitRate(byOutcome: Record<string, number>): number | null {
  const total = Object.values(byOutcome).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const cached = byOutcome.cached ?? 0;
  return cached / total;
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function StatsCardError({ reason }: { reason: string }): JSX.Element {
  // Operator-facing — the prefix lets a glance distinguish "Axiom
  // returned a 4xx" (we configured it wrong) from "Axiom is
  // unreachable" (their problem) from "we timed out" (slow query).
  return (
    <p className="admin-page__stats-error" role="status">
      Unavailable: <code>{reason}</code>
    </p>
  );
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

interface AnalyticsSectionProps {
  stats: StatsResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  onRefetch: () => void;
}

function AnalyticsSection(props: AnalyticsSectionProps): JSX.Element {
  const { stats, isLoading, isError, isFetching, onRefetch } = props;
  if (isLoading) {
    return <p aria-busy="true">Loading analytics…</p>;
  }
  if (isError || !stats) {
    return (
      <p role="alert">
        Could not load analytics.{' '}
        <button
          type="button"
          className="admin-page__refresh"
          onClick={onRefetch}
        >
          Retry
        </button>
      </p>
    );
  }
  if (!stats.configured) {
    // The token+dataset env vars aren't both set on this deployment.
    // Tell the operator the exact missing piece so they don't have
    // to grep `/api/status` to find out.
    const missing: string[] = [];
    if (!stats.axiom.tokenConfigured) missing.push('AXIOM_API_TOKEN');
    if (!stats.axiom.dataset) missing.push('AXIOM_DATASET');
    return (
      <p
        className="admin-page__stats-not-configured"
        data-testid="admin-stats-not-configured"
      >
        Analytics not configured. Set{' '}
        {missing.map((m, i) => (
          <span key={m}>
            {i > 0 ? ' and ' : ''}
            <code>{m}</code>
          </span>
        ))}{' '}
        in the Vercel project env vars and redeploy.
      </p>
    );
  }
  const c = stats.cards!;
  return (
    <div className="admin-page__stats-grid">
      <CacheHitsCard result={c.cacheHits} />
      <TokensCard result={c.tokens} />
      <FailuresCard result={c.failures} />
      <RateLimitCard result={c.rateLimit} />
      <WarmCronCard result={c.warmCron} />
      <p className="admin-page__actions">
        <button
          type="button"
          className="admin-page__refresh"
          onClick={onRefetch}
          disabled={isFetching}
        >
          {isFetching ? 'Refreshing…' : 'Refresh analytics'}
        </button>
      </p>
    </div>
  );
}

function CacheHitsCard({
  result,
}: {
  result: CardResult<CacheHitsValue>;
}): JSX.Element {
  return (
    <section className="admin-page__stats-card" data-testid="admin-stats-cache-hits">
      <h3 className="admin-page__stats-title">Cache hits</h3>
      <p className="admin-page__stats-window">
        summary + comments-summary, {result.ok ? formatWindow(result.value.windowSeconds) : 'last hour'}
      </p>
      {result.ok ? (
        <CacheHitsBody value={result.value} />
      ) : (
        <StatsCardError reason={result.reason} />
      )}
    </section>
  );
}

function CacheHitsBody({ value }: { value: CacheHitsValue }): JSX.Element {
  const total = Object.values(value.byOutcome).reduce((a, b) => a + b, 0);
  if (total === 0) {
    return <p className="admin-page__stats-empty">No requests in this window.</p>;
  }
  const rate = cacheHitRate(value.byOutcome);
  // Stable display order — keeps the visual block from reshuffling
  // every refresh as outcomes change rank.
  const order = ['cached', 'generated', 'rate_limited', 'error'];
  const known = new Set(order);
  const extras = Object.keys(value.byOutcome).filter((k) => !known.has(k));
  const rows = [...order, ...extras]
    .filter((k) => value.byOutcome[k] !== undefined)
    .map((k) => ({ outcome: k, count: value.byOutcome[k] }));
  return (
    <>
      <p
        className="admin-page__stats-headline"
        data-testid="admin-stats-cache-hits-rate"
      >
        {rate === null ? '—' : formatPercent(rate)} hit rate
      </p>
      <dl className="admin-page__stats-list">
        {rows.map((r) => (
          <div key={r.outcome}>
            <dt>{r.outcome}</dt>
            <dd>{formatInteger(r.count)}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function TokensCard({
  result,
}: {
  result: CardResult<TokensValue>;
}): JSX.Element {
  return (
    <section className="admin-page__stats-card" data-testid="admin-stats-tokens">
      <h3 className="admin-page__stats-title">Token spend</h3>
      <p className="admin-page__stats-window">
        Gemini + Jina, {result.ok ? formatWindow(result.value.windowSeconds) : 'last 24h'}
      </p>
      {result.ok ? (
        <dl className="admin-page__stats-list">
          <div>
            <dt>Gemini total</dt>
            <dd data-testid="admin-stats-gemini-tokens">
              {formatInteger(result.value.geminiTotalTokens)}
            </dd>
          </div>
          <div>
            <dt>Jina</dt>
            <dd data-testid="admin-stats-jina-tokens">
              {formatInteger(result.value.jinaTokens)}
            </dd>
          </div>
        </dl>
      ) : (
        <StatsCardError reason={result.reason} />
      )}
    </section>
  );
}

function FailuresCard({
  result,
}: {
  result: CardResult<FailuresValue>;
}): JSX.Element {
  return (
    <section className="admin-page__stats-card" data-testid="admin-stats-failures">
      <h3 className="admin-page__stats-title">Top failure reasons</h3>
      <p className="admin-page__stats-window">
        outcome=error, {result.ok ? formatWindow(result.value.windowSeconds) : 'last 24h'}
      </p>
      {result.ok ? (
        result.value.byReason.length === 0 ? (
          <p className="admin-page__stats-empty">No errors in this window.</p>
        ) : (
          <dl className="admin-page__stats-list">
            {result.value.byReason.map((r) => (
              <div key={r.reason}>
                <dt>{r.reason}</dt>
                <dd>{formatInteger(r.count)}</dd>
              </div>
            ))}
          </dl>
        )
      ) : (
        <StatsCardError reason={result.reason} />
      )}
    </section>
  );
}

function RateLimitCard({
  result,
}: {
  result: CardResult<RateLimitValue>;
}): JSX.Element {
  return (
    <section className="admin-page__stats-card" data-testid="admin-stats-rate-limit">
      <h3 className="admin-page__stats-title">Rate-limited</h3>
      <p className="admin-page__stats-window">
        outcome=rate_limited,{' '}
        {result.ok ? formatWindow(result.value.windowSeconds) : 'last hour'}
      </p>
      {result.ok ? (
        <p
          className="admin-page__stats-headline"
          data-testid="admin-stats-rate-limit-count"
        >
          {formatInteger(result.value.count)}
        </p>
      ) : (
        <StatsCardError reason={result.reason} />
      )}
    </section>
  );
}

function WarmCronCard({
  result,
}: {
  result: CardResult<WarmCronValue>;
}): JSX.Element {
  return (
    <section className="admin-page__stats-card" data-testid="admin-stats-warm-cron">
      <h3 className="admin-page__stats-title">Warm cron — last run</h3>
      <p className="admin-page__stats-window">
        warm-run,{' '}
        {result.ok ? formatWindow(result.value.windowSeconds) : 'last 6h'}
      </p>
      {result.ok ? (
        result.value.lastRun === null ? (
          <p className="admin-page__stats-empty">
            No <code>warm-run</code> log lines in this window. Check the
            cron schedule.
          </p>
        ) : (
          <dl className="admin-page__stats-list">
            <div>
              <dt>When</dt>
              <dd data-testid="admin-stats-warm-cron-when">
                {formatRelativeTime(result.value.lastRun.tISO, Date.now())}
              </dd>
            </div>
            <div>
              <dt>Stories</dt>
              <dd data-testid="admin-stats-warm-cron-stories">
                {result.value.lastRun.storyCount === null
                  ? '—'
                  : formatInteger(result.value.lastRun.storyCount)}
              </dd>
            </div>
            <div>
              <dt>Processed</dt>
              <dd>
                {result.value.lastRun.processed === null
                  ? '—'
                  : formatInteger(result.value.lastRun.processed)}
              </dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>
                {result.value.lastRun.durationMs === null
                  ? '—'
                  : `${formatInteger(result.value.lastRun.durationMs)} ms`}
              </dd>
            </div>
          </dl>
        )
      ) : (
        <StatsCardError reason={result.reason} />
      )}
    </section>
  );
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

  // Analytics rollup. Independent of the primary /api/admin fetch so
  // a slow Axiom never blocks the service-health cards. We only enable
  // the query once the primary call has confirmed the operator is
  // authorized — otherwise an unauthenticated visitor would burn a
  // server-side HN round-trip on the analytics endpoint too.
  const statsEnabled = enabled && !!data;
  const {
    data: statsData,
    isLoading: statsLoading,
    isError: statsIsError,
    refetch: refetchStats,
    isFetching: statsFetching,
  } = useQuery({
    queryKey: ['admin-stats'],
    queryFn: ({ signal }) => fetchAdminStats(signal),
    enabled: statsEnabled,
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

          <h2 className="admin-page__heading">Analytics</h2>
          <p className="admin-page__note">
            Aggregated from the structured logs Vercel forwards into
            Axiom. Each card runs an independent query; one card
            failing does not affect the others.
          </p>
          <AnalyticsSection
            stats={statsData}
            isLoading={statsLoading}
            isError={statsIsError}
            isFetching={statsFetching}
            onRefetch={() => refetchStats()}
          />
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
