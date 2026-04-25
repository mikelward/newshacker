import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  clearLocalEvents,
  exportLocalEvents,
  getLocalEvents,
  type TelemetryEvent,
} from '../lib/telemetry';

// Server response shape — kept local since `api/*.ts` source isn't
// shared into the client. Mirrors `handleTelemetryEvents`'s body.
// `user` is the per-user bucket (events from any env where the
// caller was logged in). `anon` is the preview-only anonymous
// dumping ground.
interface TelemetryEventsResponse {
  user: TelemetryEvent[];
  anon: TelemetryEvent[];
}

interface TaggedEvent extends TelemetryEvent {
  source: 'user' | 'anon' | 'local';
}

async function fetchTelemetryEvents(
  signal?: AbortSignal,
): Promise<TelemetryEventsResponse> {
  const res = await fetch('/api/admin-telemetry-events', { signal });
  if (!res.ok) {
    throw new Error(`telemetry fetch failed: HTTP ${res.status}`);
  }
  return (await res.json()) as TelemetryEventsResponse;
}

function ageHoursAtAction(e: TelemetryEvent): number {
  return Math.max(0, e.eventTime / 1000 - e.time) / 3600;
}

// Plain percentile (linear interpolation). Returns `NaN` when the
// input is empty so callers can skip rendering rather than display
// a misleading 0.
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

interface Stats {
  count: number;
  scoreP25: number;
  scoreMedian: number;
  scoreP75: number;
  ageP25: number;
  ageMedian: number;
  ageP75: number;
}

function summarize(events: TelemetryEvent[]): Stats {
  const scores = events.map((e) => e.score).sort((a, b) => a - b);
  const ages = events.map(ageHoursAtAction).sort((a, b) => a - b);
  return {
    count: events.length,
    scoreP25: percentile(scores, 25),
    scoreMedian: percentile(scores, 50),
    scoreP75: percentile(scores, 75),
    ageP25: percentile(ages, 25),
    ageMedian: percentile(ages, 50),
    ageP75: percentile(ages, 75),
  };
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

// Scatter dimensions — kept tiny so the page stays compact and the
// SVG renders cleanly on a phone. The point is "eyeball the
// distribution", not "publication-quality chart".
const SCATTER_W = 480;
const SCATTER_H = 280;
const PADDING = 36;

interface ScatterProps {
  events: TaggedEvent[];
}

function Scatter({ events }: ScatterProps) {
  if (events.length === 0) {
    return (
      <p className="admin-page__note" data-testid="threshold-scatter-empty">
        No events recorded yet. Pin or hide a story on a feed to start
        collecting data.
      </p>
    );
  }
  // Cap the y-axis at 99th percentile of scores so a runaway 5000-
  // point story doesn't squash the rest of the dots into a single
  // pixel at the bottom. The cap is generous enough that everyday
  // front-page items stay on-scale.
  const scoresAsc = events.map((e) => e.score).sort((a, b) => a - b);
  const yMax = Math.max(50, percentile(scoresAsc, 99));
  // X axis is age at action in hours; cap at 48h so the same logic
  // applies for old back-pinned stories without distorting recent
  // ones.
  const xMax = 48;

  const xScale = (h: number): number => {
    const clamped = Math.min(h, xMax);
    return PADDING + (clamped / xMax) * (SCATTER_W - PADDING * 2);
  };
  const yScale = (s: number): number => {
    const clamped = Math.min(s, yMax);
    return SCATTER_H - PADDING - (clamped / yMax) * (SCATTER_H - PADDING * 2);
  };

  // Reference lines for the existing thresholds in src/lib/format.ts
  // — score >= 100, score >= 40 + age < 2 h. Eyeballable against
  // the dots.
  const yScore100 = yScale(100);
  const yScore40 = yScale(40);
  const x2h = xScale(2);

  return (
    <svg
      viewBox={`0 0 ${SCATTER_W} ${SCATTER_H}`}
      width="100%"
      role="img"
      aria-label="Pin and hide events plotted by score and age"
      data-testid="threshold-scatter"
    >
      {/* axes */}
      <line
        x1={PADDING}
        y1={SCATTER_H - PADDING}
        x2={SCATTER_W - PADDING}
        y2={SCATTER_H - PADDING}
        stroke="currentColor"
        strokeOpacity="0.4"
      />
      <line
        x1={PADDING}
        y1={PADDING}
        x2={PADDING}
        y2={SCATTER_H - PADDING}
        stroke="currentColor"
        strokeOpacity="0.4"
      />
      {/* current thresholds: dashed reference lines */}
      <line
        x1={PADDING}
        y1={yScore100}
        x2={SCATTER_W - PADDING}
        y2={yScore100}
        stroke="var(--nh-orange, #ff6600)"
        strokeOpacity="0.5"
        strokeDasharray="4 3"
      />
      <line
        x1={PADDING}
        y1={yScore40}
        x2={x2h}
        y2={yScore40}
        stroke="var(--nh-orange, #ff6600)"
        strokeOpacity="0.5"
        strokeDasharray="4 3"
      />
      <line
        x1={x2h}
        y1={yScore40}
        x2={x2h}
        y2={SCATTER_H - PADDING}
        stroke="var(--nh-orange, #ff6600)"
        strokeOpacity="0.5"
        strokeDasharray="4 3"
      />
      {/* axis labels */}
      <text
        x={PADDING}
        y={SCATTER_H - 6}
        fontSize="10"
        fill="currentColor"
      >
        0 h
      </text>
      <text
        x={SCATTER_W - PADDING - 18}
        y={SCATTER_H - 6}
        fontSize="10"
        fill="currentColor"
      >
        {xMax} h
      </text>
      <text
        x={4}
        y={SCATTER_H - PADDING}
        fontSize="10"
        fill="currentColor"
      >
        0
      </text>
      <text x={4} y={PADDING + 4} fontSize="10" fill="currentColor">
        {Math.round(yMax)}
      </text>
      {/* points */}
      {events.map((e, i) => {
        const cx = xScale(ageHoursAtAction(e));
        const cy = yScale(e.score);
        // Pin = green-ish (success), hide = red-ish (rejection).
        const fill = e.action === 'pin' ? '#3a8a3a' : '#c14545';
        return (
          <circle
            key={`${e.source}-${e.eventTime}-${e.id}-${i}`}
            cx={cx}
            cy={cy}
            r={3}
            fill={fill}
            fillOpacity="0.7"
          />
        );
      })}
    </svg>
  );
}

export function HotThresholdTuning() {
  const [exportText, setExportText] = useState<string | null>(null);
  const [localBumper, setLocalBumper] = useState(0);

  // Server-side fetch. We tolerate failure here — the local mirror
  // is the fallback view, and the operator's first visit may
  // legitimately get a 503 (Redis unconfigured on a fresh preview).
  const { data: server, isLoading: serverLoading, error: serverError } =
    useQuery({
      queryKey: ['admin-telemetry-events'],
      queryFn: ({ signal }) => fetchTelemetryEvents(signal),
      staleTime: 0,
      gcTime: 0,
      refetchOnWindowFocus: false,
      retry: false,
    });

  const tagged: TaggedEvent[] = useMemo(() => {
    const out: TaggedEvent[] = [];
    if (server) {
      // Defensive: a server-side schema mismatch (e.g. an old
      // bundle hitting a new endpoint, or a shape regression)
      // shouldn't crash the page. Default missing arrays to [].
      const userArr = Array.isArray(server.user) ? server.user : [];
      const anonArr = Array.isArray(server.anon) ? server.anon : [];
      for (const e of userArr) out.push({ ...e, source: 'user' });
      for (const e of anonArr) out.push({ ...e, source: 'anon' });
    }
    // The local ring buffer shadows the server bucket the local
    // device wrote to (so events appear twice — once via server,
    // once via local — until we dedup). Use eventTime+id as a
    // dedup key; events that match on both are the same logical
    // record landing through both paths.
    const seen = new Set(out.map((e) => `${e.eventTime}|${e.id}|${e.action}`));
    // localBumper retriggers the read after Clear / Export buttons.
    void localBumper;
    for (const e of getLocalEvents()) {
      const key = `${e.eventTime}|${e.id}|${e.action}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...e, source: 'local' });
    }
    return out;
  }, [server, localBumper]);

  const pinEvents = useMemo(
    () => tagged.filter((e) => e.action === 'pin'),
    [tagged],
  );
  const hideEvents = useMemo(
    () => tagged.filter((e) => e.action === 'hide'),
    [tagged],
  );
  const pinStats = useMemo(() => summarize(pinEvents), [pinEvents]);
  const hideStats = useMemo(() => summarize(hideEvents), [hideEvents]);

  const handleExport = useCallback(() => {
    setExportText(exportLocalEvents());
  }, []);
  const handleClearLocal = useCallback(() => {
    clearLocalEvents();
    setLocalBumper((n) => n + 1);
  }, []);

  return (
    <section data-testid="hot-threshold-tuning">
      <h2 className="admin-page__heading">Hot threshold tuning</h2>
      <p className="admin-page__intro">
        Score and age (at action time) for the first time you pinned or
        hid each story. Use the distributions to decide whether{' '}
        <code>HOT_MIN_SCORE_*</code> and <code>HOT_RECENT_WINDOW_HOURS</code>{' '}
        in <code>src/lib/format.ts</code> match the stories you actually
        engage with. Server records — your per-user bucket
        (<code>user</code>, populated from any environment where you were
        logged in) and the preview-only anonymous bucket (<code>anon</code>) —
        are merged with any local-only records below; local records
        survive a <code>503</code> from the server endpoint.
      </p>

      {serverLoading ? (
        <p aria-busy="true">Loading telemetry…</p>
      ) : serverError ? (
        <p className="admin-page__note" role="alert">
          Could not reach the telemetry endpoint
          {serverError instanceof Error ? `: ${serverError.message}` : '.'}{' '}
          Showing local-only data.
        </p>
      ) : null}

      <Scatter events={tagged} />

      <h3 className="admin-page__heading">Pinned ({pinStats.count})</h3>
      {pinStats.count > 0 ? (
        <dl className="admin-page__list" data-testid="pin-stats">
          <div>
            <dt>Score (P25 / median / P75)</dt>
            <dd>
              {formatNumber(pinStats.scoreP25)} /{' '}
              {formatNumber(pinStats.scoreMedian)} /{' '}
              {formatNumber(pinStats.scoreP75)}
            </dd>
          </div>
          <div>
            <dt>Age in hours (P25 / median / P75)</dt>
            <dd>
              {formatNumber(pinStats.ageP25)} /{' '}
              {formatNumber(pinStats.ageMedian)} /{' '}
              {formatNumber(pinStats.ageP75)}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="admin-page__note">No pin events recorded yet.</p>
      )}

      <h3 className="admin-page__heading">Hidden ({hideStats.count})</h3>
      {hideStats.count > 0 ? (
        <dl className="admin-page__list" data-testid="hide-stats">
          <div>
            <dt>Score (P25 / median / P75)</dt>
            <dd>
              {formatNumber(hideStats.scoreP25)} /{' '}
              {formatNumber(hideStats.scoreMedian)} /{' '}
              {formatNumber(hideStats.scoreP75)}
            </dd>
          </div>
          <div>
            <dt>Age in hours (P25 / median / P75)</dt>
            <dd>
              {formatNumber(hideStats.ageP25)} /{' '}
              {formatNumber(hideStats.ageMedian)} /{' '}
              {formatNumber(hideStats.ageP75)}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="admin-page__note">No hide events recorded yet.</p>
      )}

      <p className="admin-page__note">
        Current thresholds (for comparison):{' '}
        <code>score ≥ 100</code> at any age, OR{' '}
        <code>score ≥ 40</code> with age <code>&lt; 2 h</code>. Tighten
        if pin scores cluster well above 100; loosen if you regularly
        pin stories that aren't matching the predicate.
      </p>

      <p className="admin-page__actions">
        <button
          type="button"
          className="admin-page__refresh"
          onClick={handleExport}
        >
          Export local JSON
        </button>{' '}
        <button
          type="button"
          className="admin-page__refresh"
          onClick={handleClearLocal}
        >
          Clear local buffer
        </button>
      </p>
      {exportText !== null ? (
        <details className="admin-page__details" open>
          <summary>Local telemetry export</summary>
          <pre className="admin-page__raw" data-testid="threshold-export">
            {exportText}
          </pre>
        </details>
      ) : null}
    </section>
  );
}
