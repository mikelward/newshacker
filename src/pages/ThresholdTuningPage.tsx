import { useCallback, useMemo, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ME_QUERY_KEY, useAuth } from '../hooks/useAuth';
import { useHotFeedItems } from '../hooks/useHotFeedItems';
import { usePinnedStories } from '../hooks/usePinnedStories';
import { useDoneStories } from '../hooks/useDoneStories';
import { useHiddenStories } from '../hooks/useHiddenStories';
import { StoryListImpl } from '../components/StoryList';
import type { RowFlag } from '../components/StoryListItem';
import {
  HOT_BIG_DESCENDANTS,
  HOT_BIG_SCORE,
  HOT_MIN_DESCENDANTS,
  HOT_MIN_VELOCITY,
  isHotStory,
} from '../lib/format';
import {
  clearLocalEvents,
  exportLocalEvents,
  getLocalEvents,
  type TelemetryEvent,
} from '../lib/telemetry';
import './AdminPage.css';

// Re-uses the AdminPage CSS module — same `admin-page__*` class
// vocabulary so /tuning visually reads as a sibling of /admin
// without dragging in a parallel set of styles.

interface TelemetryEventsResponse {
  user: TelemetryEvent[];
  anon: TelemetryEvent[];
}

interface TaggedEvent extends TelemetryEvent {
  source: 'user' | 'anon' | 'local';
}

// `/api/admin` is the auth gate. We piggyback on its existing
// HN-round-trip + admin-username check rather than building a
// second one. Same query key as AdminPage so both pages read and
// write the same React Query entry — with the default `gcTime`
// (~5 min) below, navigating from one page to the other paints
// from cache instead of re-running the HN round-trip.
interface AdminGateResponse {
  username: string;
}

class GateError extends Error {
  readonly status: number;
  readonly payload: { reason?: string; signedInAs?: string };
  constructor(message: string, status: number, payload: { reason?: string; signedInAs?: string } = {}) {
    super(message);
    this.name = 'GateError';
    this.status = status;
    this.payload = payload;
  }
}

async function fetchAdminGate(signal?: AbortSignal): Promise<AdminGateResponse> {
  const res = await fetch('/api/admin', { signal });
  if (res.status === 401) throw new GateError('unauthenticated', 401);
  if (res.status === 403 || res.status === 503) {
    let payload = {};
    try {
      payload = await res.json();
    } catch {
      // ignore
    }
    throw new GateError(`http_${res.status}`, res.status, payload);
  }
  if (!res.ok) throw new GateError(`http_${res.status}`, res.status);
  return (await res.json()) as AdminGateResponse;
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

export function ThresholdTuningPage() {
  const auth = useAuth();
  const client = useQueryClient();
  const location = useLocation();

  const enabled = auth.isAuthenticated;
  const { data: gate, isLoading: gateLoading, error: gateError } = useQuery({
    queryKey: ['admin-status'],
    queryFn: ({ signal }) => fetchAdminGate(signal),
    enabled,
    // Default `gcTime` (~5 min) so navigating from /admin to
    // /tuning (or vice versa) paints from cache when the operator
    // hops between them, instead of round-tripping HN twice.
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (auth.isLoading || (enabled && gateLoading)) {
    return (
      <article className="admin-page">
        <h1 className="admin-page__title">Hot threshold tuning</h1>
        <p aria-busy="true">Loading…</p>
      </article>
    );
  }

  if (!auth.isAuthenticated) {
    return (
      <Navigate to="/login" replace state={{ from: location.pathname }} />
    );
  }

  if (gateError instanceof GateError && gateError.status === 401) {
    client.setQueryData(ME_QUERY_KEY, null);
    return (
      <Navigate to="/login" replace state={{ from: location.pathname }} />
    );
  }

  if (gateError instanceof GateError) {
    return (
      <article className="admin-page">
        <h1 className="admin-page__title">Hot threshold tuning</h1>
        <p role="alert">
          This page is only available to the site operator
          {gateError.payload.signedInAs
            ? ` (you're signed in as ${gateError.payload.signedInAs})`
            : ''}
          .
        </p>
        <p className="admin-page__back">
          <Link to="/top">← Back to Top</Link>
        </p>
      </article>
    );
  }

  if (!gate) {
    return (
      <article className="admin-page">
        <h1 className="admin-page__title">Hot threshold tuning</h1>
        <p role="alert">Could not verify admin session.</p>
      </article>
    );
  }

  return <ThresholdTuningView />;
}

function ThresholdTuningView() {
  const [localBumper, setLocalBumper] = useState(0);

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
      const userArr = Array.isArray(server.user) ? server.user : [];
      const anonArr = Array.isArray(server.anon) ? server.anon : [];
      for (const e of userArr) out.push({ ...e, source: 'user' });
      for (const e of anonArr) out.push({ ...e, source: 'anon' });
    }
    const seen = new Set(
      out.map((e) => `${e.eventTime}|${e.id}|${e.action}`),
    );
    void localBumper;
    for (const e of getLocalEvents()) {
      const key = `${e.eventTime}|${e.id}|${e.action}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...e, source: 'local' });
    }
    return out;
  }, [server, localBumper]);

  const handleClearLocal = useCallback(() => {
    clearLocalEvents();
    setLocalBumper((n) => n + 1);
  }, []);

  const [exportText, setExportText] = useState<string | null>(null);
  const handleExport = useCallback(() => {
    setExportText(exportLocalEvents());
  }, []);

  return (
    <article className="admin-page">
      <h1 className="admin-page__title">Hot threshold tuning</h1>
      <p className="admin-page__intro">
        Score, age, and comment count at action time for the first
        time you pinned or hid each story. Tune the thresholds in{' '}
        <code>src/lib/format.ts</code> against the data instead of
        guessing. Sliders below feed into the threshold expression;
        the live event list re-classifies on every change.{' '}
        <Link to="/admin">← Admin dashboard</Link>
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

      <ThresholdTuningBody events={tagged} />

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

      <p className="admin-page__back">
        <Link to="/top">← Back to Top</Link>
      </p>
    </article>
  );
}

interface BodyProps {
  events: TaggedEvent[];
}

// Default expression mirrors `isHotStory` exactly — same shape as
// the rule the row Hot flag and the /hot feed already use, with
// the constants exposed as slider-controlled variables so the
// operator can shimmy them without retyping the expression.
//
// `young_age`, `young_threshold`, and `normal_threshold` aren't used
// in the default expression any more (the rule moved off raw score
// thresholds), but the sliders stay exposed so the operator can
// type the previous score-based expression — or any hybrid — into
// the input and tune against the same telemetry without re-typing
// constants.
const DEFAULT_EXPRESSION =
  '(velocity > velocity_threshold && descendants > min_descendants) || (score > big_score && descendants > big_descendants)';

interface ThresholdSliderState {
  velocity_threshold: number;
  min_descendants: number;
  big_score: number;
  big_descendants: number;
  young_age: number;
  young_threshold: number;
  normal_threshold: number;
}

function defaultSliders(): ThresholdSliderState {
  return {
    velocity_threshold: HOT_MIN_VELOCITY,
    min_descendants: HOT_MIN_DESCENDANTS,
    big_score: HOT_BIG_SCORE,
    big_descendants: HOT_BIG_DESCENDANTS,
    // Legacy score-based rule defaults — preserved so the operator
    // can recreate `score >= normal_threshold || (age < young_age &&
    // score >= young_threshold)` in the expression input without
    // re-typing the constants.
    young_age: 2,
    young_threshold: 40,
    normal_threshold: 100,
  };
}

// Compile a user-typed expression into a raw predicate function.
// Runs inside a `Function` constructor because /tuning is operator-
// only and gated behind /api/admin's HN round-trip — the audience
// is the verified admin, who already has full control of their own
// session. Wrapped in try/catch so a syntax error or runtime throw
// shows an inline message instead of crashing the page.
//
// Returns the raw function with named parameter slots; callers
// (`evalForEvent`, `evalForItem` below) assemble the args from
// whichever input shape they're working against. This means the
// same compiled function evaluates the historical `TelemetryEvent`
// (for the live counts and scatter outlines) and a live `HNItem`
// (for the Preview's filter), without recompiling per call.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawPredicate = (...args: any[]) => unknown;

function compileExpression(
  expr: string,
): { ok: true; fn: RawPredicate } | { ok: false; error: string } {
  if (expr.trim().length === 0) {
    return { ok: false, error: 'Expression is empty.' };
  }
  try {
    const fn = new Function(
      'score',
      'age',
      'descendants',
      'type',
      'isHot',
      'velocity',
      'commentVelocity',
      'velocity_threshold',
      'min_descendants',
      'big_score',
      'big_descendants',
      'young_age',
      'young_threshold',
      'normal_threshold',
      `return (${expr});`,
    ) as RawPredicate;
    return { ok: true, fn };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Apply the compiled expression to a historical telemetry event.
// `age` is age-at-action time (eventTime - story.time), so the
// predicate evaluates against the snapshot the operator captured
// when they pinned/hid the story.
function evalForEvent(
  raw: RawPredicate,
  e: TelemetryEvent,
  s: ThresholdSliderState,
): boolean {
  const age = ageHoursAtAction(e);
  const safeAge = Math.max(age, 0.01);
  try {
    return Boolean(
      raw(
        e.score,
        age,
        e.descendants ?? 0,
        e.type ?? '',
        e.isHot,
        e.score / safeAge,
        (e.descendants ?? 0) / safeAge,
        s.velocity_threshold,
        s.min_descendants,
        s.big_score,
        s.big_descendants,
        s.young_age,
        s.young_threshold,
        s.normal_threshold,
      ),
    );
  } catch {
    return false;
  }
}

// Apply the compiled expression to a *live* HNItem at the moment
// the page rendered. `age` is now-relative, `isHot` is computed via
// the production rule. Used to filter the live `/top ∪ /new`
// candidates for the Preview section so the operator can see what
// /hot would look like under the current expression.
function evalForItem(
  raw: RawPredicate,
  item: { score?: number; time?: number; descendants?: number; type?: string },
  s: ThresholdSliderState,
  nowMs: number = Date.now(),
): boolean {
  const score = item.score ?? 0;
  const time = item.time ?? 0;
  const descendants = item.descendants ?? 0;
  // Suppress the velocity-derived inputs when the story is timestamped
  // ahead of the wall clock — the negative age would otherwise clamp
  // to the `safeAge` floor and inflate `velocity` / `commentVelocity`
  // to extreme values. We deliberately do *not* short-circuit the
  // whole expression: `isHotStory`'s big-story branch (`score >
  // HOT_BIG_SCORE && descendants > HOT_BIG_DESCENDANTS`) can still
  // fire for a future-dated big story, so the Preview must evaluate
  // the rule and only zero out the inputs that depend on `age`.
  const future = time > 0 && nowMs / 1000 < time;
  const age = future
    ? 0
    : time > 0
      ? Math.max(0, (nowMs / 1000 - time) / 3600)
      : 0;
  const safeAge = Math.max(age, 0.01);
  const velocity = future ? 0 : score / safeAge;
  const commentVelocity = future ? 0 : descendants / safeAge;
  const isHot = isHotStory(item, new Date(nowMs));
  try {
    return Boolean(
      raw(
        score,
        age,
        descendants,
        item.type ?? '',
        isHot,
        velocity,
        commentVelocity,
        s.velocity_threshold,
        s.min_descendants,
        s.big_score,
        s.big_descendants,
        s.young_age,
        s.young_threshold,
        s.normal_threshold,
      ),
    );
  } catch {
    return false;
  }
}

function ThresholdTuningBody({ events }: BodyProps) {
  const [expression, setExpression] = useState(DEFAULT_EXPRESSION);
  const [sliders, setSliders] = useState<ThresholdSliderState>(() =>
    defaultSliders(),
  );

  const compiled = useMemo(() => compileExpression(expression), [expression]);

  // Per-event "would be hot under current expression" flag for the
  // historical telemetry rows (live counts, scatter outlines).
  // Recomputes when expression or sliders change; even at 10k
  // events the eval is sub-millisecond.
  const flags = useMemo(() => {
    if (!compiled.ok) return new Map<string, boolean>();
    const out = new Map<string, boolean>();
    for (const e of events) {
      const key = `${e.eventTime}|${e.id}|${e.action}`;
      out.set(key, evalForEvent(compiled.fn, e, sliders));
    }
    return out;
  }, [compiled, events, sliders]);

  const flagFor = useCallback(
    (e: TelemetryEvent) =>
      flags.get(`${e.eventTime}|${e.id}|${e.action}`) ?? false,
    [flags],
  );

  // Predicate over a *live* HNItem, used by the Preview section
  // below to filter the same `/top ∪ /new` candidates `/hot`
  // renders. Built fresh whenever the expression or sliders
  // change, so the preview re-filters without re-fetching HN.
  const itemPredicate = useCallback(
    (item: { score?: number; time?: number; descendants?: number; type?: string }) => {
      if (!compiled.ok) return false;
      return evalForItem(compiled.fn, item, sliders);
    },
    [compiled, sliders],
  );

  return (
    <>
      <ThresholdControls
        expression={expression}
        onExpressionChange={setExpression}
        sliders={sliders}
        onSlidersChange={setSliders}
        compileError={compiled.ok ? null : compiled.error}
      />
      <ThresholdLiveCounts events={events} flagFor={flagFor} />
      <ThresholdScatters events={events} flagFor={flagFor} sliders={sliders} />
      <ThresholdActionStats events={events} />
      <ThresholdTypeBreakdown events={events} />
      <ThresholdOpenedRatio events={events} />
      {/* Preview lives at the bottom: it scrolls (a full feed list)
          and uses /top ∪ /new fetched live, so anchoring it under
          the static analytics keeps the controls + summary stats
          above-the-fold. The operator who wants to see the rule's
          live output can scroll to it; the operator who wants to
          tune against the recorded events sees the controls and
          summary right where they're working. */}
      <ThresholdPreview itemPredicate={itemPredicate} />
    </>
  );
}

interface ControlsProps {
  expression: string;
  onExpressionChange: (s: string) => void;
  sliders: ThresholdSliderState;
  onSlidersChange: (s: ThresholdSliderState) => void;
  compileError: string | null;
}

function ThresholdControls({
  expression,
  onExpressionChange,
  sliders,
  onSlidersChange,
  compileError,
}: ControlsProps) {
  const reset = () => {
    onExpressionChange(DEFAULT_EXPRESSION);
    onSlidersChange(defaultSliders());
  };
  return (
    <section data-testid="threshold-controls">
      <h2 className="admin-page__heading">Threshold</h2>
      <p className="admin-page__note">
        Variables: <code>score</code>, <code>age</code> (hours),{' '}
        <code>descendants</code>, <code>type</code>, <code>isHot</code>{' '}
        (current rule), <code>velocity</code>{' '}
        (<code>score / max(age, 0.01)</code> — the ~36s{' '}
        <code>safeAge</code> floor keeps a brand-new story from
        evaluating to Infinity), <code>commentVelocity</code>{' '}
        (<code>descendants / max(age, 0.01)</code>),{' '}
        <code>velocity_threshold</code>, <code>min_descendants</code>,{' '}
        <code>big_score</code>, <code>big_descendants</code>,{' '}
        <code>young_age</code>, <code>young_threshold</code>,{' '}
        <code>normal_threshold</code> (sliders below).
      </p>
      <p>
        <label>
          <span style={{ display: 'block' }}>Expression</span>
          <input
            type="text"
            value={expression}
            onChange={(e) => onExpressionChange(e.target.value)}
            data-testid="threshold-expression"
            style={{
              width: '100%',
              fontFamily: 'monospace',
              fontSize: '0.95em',
              padding: '0.4em',
            }}
          />
        </label>
      </p>
      {compileError ? (
        <p className="admin-page__note" role="alert">
          Expression error: <code>{compileError}</code>
        </p>
      ) : null}
      <div data-testid="threshold-sliders">
        <SliderRow
          label="velocity_threshold (points/h)"
          value={sliders.velocity_threshold}
          min={1}
          max={100}
          step={1}
          onChange={(v) =>
            onSlidersChange({ ...sliders, velocity_threshold: v })
          }
          testId="slider-velocity-threshold"
        />
        <SliderRow
          label="min_descendants (comments)"
          value={sliders.min_descendants}
          min={0}
          max={50}
          step={1}
          onChange={(v) =>
            onSlidersChange({ ...sliders, min_descendants: v })
          }
          testId="slider-min-descendants"
        />
        <SliderRow
          label="big_score (points)"
          value={sliders.big_score}
          min={50}
          max={1000}
          step={10}
          onChange={(v) => onSlidersChange({ ...sliders, big_score: v })}
          testId="slider-big-score"
        />
        <SliderRow
          label="big_descendants (comments)"
          value={sliders.big_descendants}
          min={10}
          max={500}
          step={10}
          onChange={(v) =>
            onSlidersChange({ ...sliders, big_descendants: v })
          }
          testId="slider-big-descendants"
        />
        <SliderRow
          label="young_age (hours)"
          value={sliders.young_age}
          min={0.5}
          max={12}
          step={0.5}
          onChange={(v) => onSlidersChange({ ...sliders, young_age: v })}
          testId="slider-young-age"
        />
        <SliderRow
          label="young_threshold (points)"
          value={sliders.young_threshold}
          min={5}
          max={200}
          step={5}
          onChange={(v) =>
            onSlidersChange({ ...sliders, young_threshold: v })
          }
          testId="slider-young-threshold"
        />
        <SliderRow
          label="normal_threshold (points)"
          value={sliders.normal_threshold}
          min={20}
          max={500}
          step={10}
          onChange={(v) =>
            onSlidersChange({ ...sliders, normal_threshold: v })
          }
          testId="slider-normal-threshold"
        />
      </div>
      <p className="admin-page__actions">
        <button
          type="button"
          className="admin-page__refresh"
          onClick={reset}
          data-testid="threshold-reset"
        >
          Reset to defaults
        </button>
      </p>
    </section>
  );
}

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  testId?: string;
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  testId,
}: SliderRowProps) {
  return (
    <p style={{ display: 'flex', gap: '0.75em', alignItems: 'center' }}>
      <label
        style={{
          minWidth: '14em',
          display: 'inline-block',
          fontFamily: 'monospace',
          fontSize: '0.9em',
        }}
      >
        {label}
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        data-testid={testId}
        style={{ flex: 1, minWidth: 120 }}
      />
      <span style={{ minWidth: '4em', textAlign: 'right' }}>
        <code>{value}</code>
      </span>
    </p>
  );
}

interface CountsProps {
  events: TaggedEvent[];
  flagFor: (e: TelemetryEvent) => boolean;
}

// Plain percentile (linear interpolation). Returns NaN for empty
// input so callers can decide whether to render or hide a stat.
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

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

interface ScattersProps {
  events: TaggedEvent[];
  flagFor: (e: TelemetryEvent) => boolean;
  sliders: ThresholdSliderState;
}

const SCATTER_W = 480;
const SCATTER_H = 240;
const SCATTER_PAD = 36;

interface ScatterProps {
  events: TaggedEvent[];
  flagFor: (e: TelemetryEvent) => boolean;
  getY: (e: TelemetryEvent) => number;
  yLabel: string;
  yMaxFloor: number;
  referenceLines?: Array<
    | { kind: 'horizontal'; y: number }
    | { kind: 'vertical'; x: number }
    | { kind: 'corner'; y: number; xMax: number }
  >;
  testId?: string;
}

// Reusable score- or comments-vs-age scatter. Pin events draw as
// triangles, hide events as circles, so the legend stays color-
// independent (color is reserved for the "would be hot under the
// current rule" yes/no marker — green outline = matches, no
// outline = doesn't).
function Scatter({
  events,
  flagFor,
  getY,
  yLabel,
  yMaxFloor,
  referenceLines,
  testId,
}: ScatterProps) {
  if (events.length === 0) {
    return (
      <p className="admin-page__note">
        No events recorded yet.
      </p>
    );
  }
  const xMax = 48;
  const ys = events.map(getY).sort((a, b) => a - b);
  const yMax = Math.max(yMaxFloor, percentile(ys, 99));
  const xScale = (h: number): number => {
    const c = Math.min(h, xMax);
    return SCATTER_PAD + (c / xMax) * (SCATTER_W - SCATTER_PAD * 2);
  };
  const yScale = (v: number): number => {
    const c = Math.min(v, yMax);
    return (
      SCATTER_H -
      SCATTER_PAD -
      (c / yMax) * (SCATTER_H - SCATTER_PAD * 2)
    );
  };
  return (
    <svg
      viewBox={`0 0 ${SCATTER_W} ${SCATTER_H}`}
      width="100%"
      role="img"
      aria-label={`${yLabel} vs age scatter`}
      data-testid={testId}
    >
      <line
        x1={SCATTER_PAD}
        y1={SCATTER_H - SCATTER_PAD}
        x2={SCATTER_W - SCATTER_PAD}
        y2={SCATTER_H - SCATTER_PAD}
        stroke="currentColor"
        strokeOpacity="0.4"
      />
      <line
        x1={SCATTER_PAD}
        y1={SCATTER_PAD}
        x2={SCATTER_PAD}
        y2={SCATTER_H - SCATTER_PAD}
        stroke="currentColor"
        strokeOpacity="0.4"
      />
      {(referenceLines ?? []).map((ref, i) => {
        const stroke = 'var(--nh-orange, #ff6600)';
        if (ref.kind === 'horizontal') {
          return (
            <line
              key={i}
              x1={SCATTER_PAD}
              y1={yScale(ref.y)}
              x2={SCATTER_W - SCATTER_PAD}
              y2={yScale(ref.y)}
              stroke={stroke}
              strokeOpacity="0.5"
              strokeDasharray="4 3"
            />
          );
        }
        if (ref.kind === 'vertical') {
          return (
            <line
              key={i}
              x1={xScale(ref.x)}
              y1={SCATTER_PAD}
              x2={xScale(ref.x)}
              y2={SCATTER_H - SCATTER_PAD}
              stroke={stroke}
              strokeOpacity="0.5"
              strokeDasharray="4 3"
            />
          );
        }
        return (
          <g key={i}>
            <line
              x1={SCATTER_PAD}
              y1={yScale(ref.y)}
              x2={xScale(ref.xMax)}
              y2={yScale(ref.y)}
              stroke={stroke}
              strokeOpacity="0.5"
              strokeDasharray="4 3"
            />
            <line
              x1={xScale(ref.xMax)}
              y1={yScale(ref.y)}
              x2={xScale(ref.xMax)}
              y2={SCATTER_H - SCATTER_PAD}
              stroke={stroke}
              strokeOpacity="0.5"
              strokeDasharray="4 3"
            />
          </g>
        );
      })}
      <text
        x={SCATTER_PAD}
        y={SCATTER_H - 6}
        fontSize="10"
        fill="currentColor"
      >
        0 h
      </text>
      <text
        x={SCATTER_W - SCATTER_PAD - 18}
        y={SCATTER_H - 6}
        fontSize="10"
        fill="currentColor"
      >
        {xMax} h
      </text>
      <text
        x={4}
        y={SCATTER_H - SCATTER_PAD}
        fontSize="10"
        fill="currentColor"
      >
        0
      </text>
      <text x={4} y={SCATTER_PAD + 4} fontSize="10" fill="currentColor">
        {Math.round(yMax)}
      </text>
      <text
        x={SCATTER_W / 2}
        y={12}
        fontSize="10"
        textAnchor="middle"
        fill="currentColor"
      >
        {yLabel}
      </text>
      {events.map((e, i) => {
        const cx = xScale(ageHoursAtAction(e));
        const cy = yScale(getY(e));
        const fill = e.action === 'pin' ? '#3a8a3a' : '#c14545';
        const matches = flagFor(e);
        const r = 4;
        if (e.action === 'pin') {
          // Up-triangle for pin
          const points = `${cx},${cy - r} ${cx - r},${cy + r} ${cx + r},${cy + r}`;
          return (
            <polygon
              key={`${e.source}-${e.eventTime}-${e.id}-${i}`}
              points={points}
              fill={fill}
              fillOpacity="0.7"
              stroke={matches ? '#0c5d0c' : 'none'}
              strokeWidth={matches ? 1.5 : 0}
            />
          );
        }
        return (
          <circle
            key={`${e.source}-${e.eventTime}-${e.id}-${i}`}
            cx={cx}
            cy={cy}
            r={r}
            fill={fill}
            fillOpacity="0.7"
            stroke={matches ? '#0c5d0c' : 'none'}
            strokeWidth={matches ? 1.5 : 0}
          />
        );
      })}
    </svg>
  );
}

function ThresholdScatters({ events, flagFor, sliders }: ScattersProps) {
  // The velocity branch is `velocity > velocity_threshold`, i.e.
  // `score > age * velocity_threshold` — a line through the origin
  // with slope `velocity_threshold`. The scatter doesn't currently
  // render slanted reference lines, so we draw the cleanly-renderable
  // score-axis refs: `big_score` (current rule's big-story floor) plus
  // the legacy `normal_threshold` horizontal and `young_threshold` ×
  // `young_age` corner. The legacy sliders are intentionally still
  // exposed for re-typing the previous score-based expression, so
  // their reference lines stay rendered alongside the new ones.
  const scoreRefs: NonNullable<ScatterProps['referenceLines']> = [
    { kind: 'horizontal', y: sliders.big_score },
    { kind: 'horizontal', y: sliders.normal_threshold },
    {
      kind: 'corner',
      y: sliders.young_threshold,
      xMax: sliders.young_age,
    },
  ];
  const commentRefs: NonNullable<ScatterProps['referenceLines']> = [
    { kind: 'horizontal', y: sliders.min_descendants },
    { kind: 'horizontal', y: sliders.big_descendants },
  ];
  return (
    <details data-testid="threshold-scatters" open>
      <summary className="admin-page__heading" style={{ cursor: 'pointer' }}>
        Distribution
      </summary>
      <p className="admin-page__note">
        Triangles = pin events, circles = hide events. A green
        outline means the event matches the current threshold rule.
        Dashed orange lines mark the slider values. Pin (▲ green
        outline) = good — you'd see this story. Hide (● green outline)
        = bad — you'd be surfaced a story you'd already dismissed.
      </p>
      <Scatter
        events={events}
        flagFor={flagFor}
        getY={(e) => e.score}
        yLabel="score"
        yMaxFloor={50}
        referenceLines={scoreRefs}
        testId="threshold-scatter-score"
      />
      <Scatter
        events={events}
        flagFor={flagFor}
        getY={(e) => e.descendants ?? 0}
        yLabel="comments"
        yMaxFloor={20}
        referenceLines={commentRefs}
        testId="threshold-scatter-comments"
      />
    </details>
  );
}

interface StatsProps {
  events: TaggedEvent[];
}

interface ActionStats {
  count: number;
  scoreP25: number;
  scoreMedian: number;
  scoreP75: number;
  ageP25: number;
  ageMedian: number;
  ageP75: number;
  descendantsP25: number;
  descendantsMedian: number;
  descendantsP75: number;
}

function summarize(events: TelemetryEvent[]): ActionStats {
  const scores = events.map((e) => e.score).sort((a, b) => a - b);
  const ages = events.map(ageHoursAtAction).sort((a, b) => a - b);
  const ds = events
    .map((e) => e.descendants ?? 0)
    .sort((a, b) => a - b);
  return {
    count: events.length,
    scoreP25: percentile(scores, 25),
    scoreMedian: percentile(scores, 50),
    scoreP75: percentile(scores, 75),
    ageP25: percentile(ages, 25),
    ageMedian: percentile(ages, 50),
    ageP75: percentile(ages, 75),
    descendantsP25: percentile(ds, 25),
    descendantsMedian: percentile(ds, 50),
    descendantsP75: percentile(ds, 75),
  };
}

function ThresholdActionStats({ events }: StatsProps) {
  const pinEvents = events.filter((e) => e.action === 'pin');
  const hideEvents = events.filter((e) => e.action === 'hide');
  const pinStats = summarize(pinEvents);
  const hideStats = summarize(hideEvents);
  return (
    <section data-testid="threshold-action-stats">
      <h2 className="admin-page__heading">Pinned ({pinStats.count})</h2>
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
          <div>
            <dt>Comments (P25 / median / P75)</dt>
            <dd>
              {formatNumber(pinStats.descendantsP25)} /{' '}
              {formatNumber(pinStats.descendantsMedian)} /{' '}
              {formatNumber(pinStats.descendantsP75)}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="admin-page__note">No pin events recorded yet.</p>
      )}
      <h2 className="admin-page__heading">Hidden ({hideStats.count})</h2>
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
          <div>
            <dt>Comments (P25 / median / P75)</dt>
            <dd>
              {formatNumber(hideStats.descendantsP25)} /{' '}
              {formatNumber(hideStats.descendantsMedian)} /{' '}
              {formatNumber(hideStats.descendantsP75)}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="admin-page__note">No hide events recorded yet.</p>
      )}
    </section>
  );
}

function ThresholdTypeBreakdown({ events }: StatsProps) {
  // Matrix: rows = type, columns = pin / hide counts.
  const buckets = new Map<string, { pin: number; hide: number }>();
  for (const e of events) {
    const t = e.type ?? '(unknown)';
    const cur = buckets.get(t) ?? { pin: 0, hide: 0 };
    if (e.action === 'pin') cur.pin += 1;
    else cur.hide += 1;
    buckets.set(t, cur);
  }
  const rows = [...buckets.entries()].sort(
    (a, b) => b[1].pin + b[1].hide - (a[1].pin + a[1].hide),
  );
  if (rows.length === 0) return null;
  return (
    <section data-testid="threshold-type-breakdown">
      <h2 className="admin-page__heading">By type</h2>
      <table style={{ borderCollapse: 'collapse', fontSize: '0.95em' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '0.2em 1em 0.2em 0' }}>
              type
            </th>
            <th style={{ textAlign: 'right', padding: '0.2em 1em 0.2em 0' }}>
              pin
            </th>
            <th style={{ textAlign: 'right', padding: '0.2em 0' }}>
              hide
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([t, c]) => (
            <tr key={t}>
              <td style={{ padding: '0.2em 1em 0.2em 0' }}>
                <code>{t}</code>
              </td>
              <td
                style={{
                  textAlign: 'right',
                  padding: '0.2em 1em 0.2em 0',
                }}
              >
                {c.pin}
              </td>
              <td style={{ textAlign: 'right', padding: '0.2em 0' }}>
                {c.hide}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ThresholdOpenedRatio({ events }: StatsProps) {
  // "Did the reader already open the article before pinning/hiding?"
  // Stronger intent signal — distinguish "opinion formed from
  // headline" from "opinion formed after reading."
  const ratio = (action: 'pin' | 'hide') => {
    const total = events.filter((e) => e.action === action);
    const opened = total.filter((e) => e.articleOpened === true);
    return { opened: opened.length, total: total.length };
  };
  const pin = ratio('pin');
  const hide = ratio('hide');
  if (pin.total === 0 && hide.total === 0) return null;
  const pct = (n: number, total: number) =>
    total === 0 ? '—' : `${Math.round((n / total) * 100)}%`;
  return (
    <section data-testid="threshold-opened-ratio">
      <h2 className="admin-page__heading">Article opened first</h2>
      <dl className="admin-page__list">
        <div>
          <dt>Pinned after opening</dt>
          <dd>
            {pin.opened} of {pin.total}{' '}
            <span style={{ opacity: 0.6 }}>
              ({pct(pin.opened, pin.total)})
            </span>
          </dd>
        </div>
        <div>
          <dt>Hidden after opening</dt>
          <dd>
            {hide.opened} of {hide.total}{' '}
            <span style={{ opacity: 0.6 }}>
              ({pct(hide.opened, hide.total)})
            </span>
          </dd>
        </div>
      </dl>
    </section>
  );
}

interface PreviewProps {
  itemPredicate: (item: {
    score?: number;
    time?: number;
    descendants?: number;
    type?: string;
  }) => boolean;
}

// Polarity colors for the two Preview diff icons. Inlined as
// constants (not CSS classes) because these glyphs only ever
// appear here; routing through CSS would mean a new selector
// for two consumers. Each color is a one-line change.
//
// Loosen cue (red `#d32f2f`): pinned-or-done but the rule
// wouldn't surface it — felt as the more urgent signal because
// the operator explicitly cared about that story. Tighten cue
// (yellow-gold `#a16207`, Tailwind yellow-700): hidden but the
// rule wants to surface it anyway — felt as a "double-check"
// signal, less urgent than the loosen case. The two-color
// palette means the operator can tell the polarity from color
// alone, before the eye resolves the glyph shape; shape (exclam
// vs. question) is the secondary cue. `#a16207` clears WCAG AA
// non-text contrast on the white row background and sits clearly
// outside HN's brand orange (`#ff6600`) in hue.
const DIFF_ICON_LOOSEN_COLOR = '#d32f2f';
const DIFF_ICON_TIGHTEN_COLOR = '#a16207';

// Material Symbols `priority_high` — Apache 2.0, Google. A bold
// exclamation glyph painted red; the right-side icon for pinned-
// or-done-but-not-rule-matching rows in the Preview, signalling
// "you cared about this but the rule wouldn't surface it"
// (loosen cue).
//
// viewBox is tightened from Material's default `0 -960 960 960`
// to a 770×770 square centered on the glyph (extent x=[400,560],
// y=[-760,-200]). The default viewBox leaves so much whitespace
// around the narrow exclam that, rendered at the same 22×22 as
// `RuleMatchesHiddenIcon`, the glyph appeared ~80% the height of
// the question mark and visibly mismatched its polarity twin.
// The crop here makes the painted height match the question
// mark's optical height while keeping the rendered slot at 22×22
// (so row layout is unchanged).
function PriorityHighIcon() {
  return (
    <svg
      viewBox="95 -865 770 770"
      width="22"
      height="22"
      fill={DIFF_ICON_LOOSEN_COLOR}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M480-200q-33 0-56.5-23.5T400-280q0-33 23.5-56.5T480-360q33 0 56.5 23.5T560-280q0 33-23.5 56.5T480-200Zm-80-240v-320h160v320H400Z" />
    </svg>
  );
}

// Material Symbols `question_mark` — Apache 2.0, Google.
// Yellow-gold question-mark glyph, used for the inverse-polarity
// signal: the rule is *false-positively* surfacing a story the
// operator already hid. Color polarity (red exclam vs. yellow
// question) is the primary "loosen vs. tighten" cue — the
// operator picks the polarity out before the eye resolves the
// glyph shape. Yellow over red here because the false-positive
// case ("rule wants to promote a story you said no to,
// double-check") is the less urgent of the two; red is reserved
// for the rule missing something the operator explicitly cared
// about.
function RuleMatchesHiddenIcon() {
  return (
    <svg
      viewBox="0 -960 960 960"
      width="22"
      height="22"
      fill={DIFF_ICON_TIGHTEN_COLOR}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M424-320q0-81 14.5-116.5T500-514q41-36 62.5-62.5T584-637q0-41-27.5-68T480-732q-51 0-77.5 31T365-638l-103-44q21-64 77-111t141-47q105 0 161.5 58.5T698-641q0 50-21.5 85.5T609-475q-49 47-59.5 71.5T539-320H424Zm56 240q-33 0-56.5-23.5T400-160q0-33 23.5-56.5T480-240q33 0 56.5 23.5T560-160q0 33-23.5 56.5T480-80Z" />
    </svg>
  );
}

// Material Icons `push_pin` — Apache 2.0, Google. The Preview's
// stand-in for `StoryListItem`'s default Pin/Unpin button: same
// glyph, but wired to a no-op so the operator can't mutate reader
// state from the tuning view. Filled when the story is pinned;
// hollow when not (mirroring the live feed's pinned-state
// affordance, just non-interactive).
function PushPinIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {filled ? (
        <path d="M16 9V4l1 0c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1l1 0v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z" />
      ) : (
        <path d="M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7c-.55 0-1 .45-1 1s.45 1 1 1l1 0v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4l1 0c.55 0 1-.45 1-1s-.45-1-1-1z" />
      )}
    </svg>
  );
}

// Material Icons `check_circle` — Apache 2.0, Google. Done's
// canonical glyph in this app (matches the thread action bar's
// Done button + `/done`'s right-side icon). Used in the Preview
// for rows the rule already surfaces *and* the operator has
// marked done — informational, not interactive.
function CheckCircleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
    </svg>
  );
}

// Live `/hot`-with-tunable-rule preview. Reuses the *exact* render
// path /hot uses (`StoryListImpl`, populated by `useHotFeedItems`)
// so what the operator sees here pixel-matches what /hot would
// render if the production thresholds were changed to whatever
// the expression + sliders currently say. The data is the same
// `/top ∪ /new` candidate set /hot fetches, sharing the
// `['feedItems', 'hot']` React Query cache — predicate is applied
// at filter time, not in the queryKey, so adjusting a slider
// re-filters without re-fetching HN.
//
// The combined predicate `rule(item) || isPinned(item) ||
// isDone(item)` widens the Preview to also include pinned and
// done articles still in `/top ∪ /new` that the rule alone
// wouldn't surface. Those rows render with a red `priority_high`
// (exclamation) icon in place of the pin button so the operator
// can see at a glance "the rule wouldn't promote this, but you
// cared about it" — a useful signal for loosening the rule.
// Pinned and done are weighted equally here: either is "you
// engaged with this story", which means the rule missing it is
// suboptimal tuning regardless of which list it ended up on.
// Articles that have *fully* dropped off both source feeds
// (off-feed pinned or done) still don't appear: `useHotFeedItems`
// only fetches from `/top ∪ /new`, and we keep
// `includeOffFeedPinned={false}` to skip the StoryListImpl overlay.
//
// Hidden stories aren't widened into the candidate pool by this
// predicate — they only surface when the rule itself promotes
// them, which is exactly the false-positive case the operator
// wants to see. `includeHidden` on `<StoryListImpl>` flips off
// the default !hiddenIds visibility filter so those rows render,
// and `rightActionFor` lights them with a yellow question mark
// (inverse polarity to the red exclam — exclam = "loosen", you
// cared but the rule missed; question = "tighten", you said no
// but the rule wants to promote it). A hidden story the rule
// doesn't match is correctly excluded by both rule and
// `includeHidden=false`-equivalent gating, so no signal is needed.
function ThresholdPreview({ itemPredicate }: PreviewProps) {
  const { pinnedIds } = usePinnedStories();
  const { doneIds } = useDoneStories();
  const { hiddenIds } = useHiddenStories();
  const combinedPredicate = useCallback(
    (item: {
      id?: number;
      score?: number;
      time?: number;
      descendants?: number;
      type?: string;
    }) => {
      if (typeof item.id === 'number') {
        if (pinnedIds.has(item.id)) return true;
        if (doneIds.has(item.id)) return true;
      }
      return itemPredicate(item);
    },
    [itemPredicate, pinnedIds, doneIds],
  );
  const feedItems = useHotFeedItems(combinedPredicate);
  const newSourceIds = feedItems.newSourceIds;
  const flagFor = useCallback(
    (id: number): RowFlag => (newSourceIds.has(id) ? 'new' : null),
    [newSourceIds],
  );
  // Precomputed id → item map so `rightActionFor` can do an O(1)
  // lookup per row instead of scanning `feedItems.items` linearly.
  // The Preview re-renders frequently while the operator drags
  // sliders, and renders ~60 rows per page; without this the
  // per-render cost is O(n²).
  const items = feedItems.items;
  const itemsById = useMemo(() => {
    const map = new Map<number, NonNullable<(typeof items)[number]>>();
    for (const it of items) {
      if (it && typeof it.id === 'number') map.set(it.id, it);
    }
    return map;
  }, [items]);
  // Per-row right-side override. Every row in the Preview gets a
  // no-op informational button so the operator can't accidentally
  // mutate reader state (pin / unpin / done) from the tuning view
  // — the Preview is for asking "what does this rule surface?",
  // and the operator tunes via the controls above, not by tapping
  // rows here. Icon variants, in priority order:
  //   - rule-matches + hidden            → yellow question mark
  //     (tightening cue: rule promotes a story you said no to)
  //   - rule-misses + (pinned or done)   → red exclam
  //     (loosening cue: you cared, rule missed)
  //   - rule-matches + pinned            → filled push_pin
  //     (informational; mirrors live-feed pinned affordance)
  //   - rule-matches + done              → check_circle
  //     (informational)
  //   - rule-matches + neither           → hollow push_pin
  //     (informational)
  // Pinned takes precedence over done when a row is somehow both,
  // since pin is the stronger explicit signal.
  const rightActionFor = useCallback(
    (id: number) => {
      const isPinned = pinnedIds.has(id);
      const isDone = doneIds.has(id);
      const isHidden = hiddenIds.has(id);
      const item = itemsById.get(id);
      // Defensive: if the item hasn't loaded yet, fall through to
      // StoryListImpl's default. The combinedPredicate widens the
      // candidate pool to pin/done, so in practice every visible
      // row resolves an item by the time we get here.
      if (!item) return undefined;
      const ruleMatches = itemPredicate(item);

      if (ruleMatches && isHidden) {
        return {
          label:
            'Hidden, but the rule above would surface this story — consider tightening',
          icon: <RuleMatchesHiddenIcon />,
          onToggle: () => {},
          testId: `preview-rule-matches-hidden-btn-${id}`,
        };
      }

      if (!ruleMatches && (isPinned || isDone)) {
        const label = isPinned
          ? 'Pinned, but the rule above would not surface this story'
          : 'Done, but the rule above would not surface this story';
        return {
          label,
          icon: <PriorityHighIcon />,
          onToggle: () => {},
          // Per-row id so multiple rule-miss rows on the same
          // Preview don't collide on `data-testid` and tests can
          // target a specific story.
          testId: `preview-cared-not-hot-btn-${id}`,
        };
      }

      if (isPinned) {
        return {
          label: 'Pinned (read-only — adjust the rule to change membership)',
          icon: <PushPinIcon filled />,
          onToggle: () => {},
          testId: `preview-readonly-pinned-btn-${id}`,
        };
      }
      if (isDone) {
        return {
          label: 'Done (read-only — adjust the rule to change membership)',
          icon: <CheckCircleIcon />,
          onToggle: () => {},
          testId: `preview-readonly-done-btn-${id}`,
        };
      }
      return {
        label: 'Read-only — adjust the rule to change membership',
        icon: <PushPinIcon filled={false} />,
        onToggle: () => {},
        testId: `preview-readonly-btn-${id}`,
        // Plain "this story matches the rule but you haven't
        // engaged with it yet" affordance — neither pinned, done,
        // nor hidden. Render in the inactive (non-orange) color
        // so the Preview's hollow pin actually reads as inactive
        // instead of inheriting `pin-btn--active`'s orange tint.
        active: false,
      };
    },
    [pinnedIds, doneIds, hiddenIds, itemsById, itemPredicate],
  );
  return (
    <details data-testid="threshold-preview" open>
      <summary className="admin-page__heading" style={{ cursor: 'pointer' }}>
        Preview
      </summary>
      <p className="admin-page__note">
        What <code>/hot</code> would render right now under the
        threshold above. Source: live <code>/top ∪ /new</code>;
        re-filters as you adjust the expression or sliders without
        re-fetching. Red exclamation = pinned or marked done but
        the rule wouldn't surface it (cue to loosen). Yellow
        question mark = hidden but the rule <em>would</em> surface
        it (cue to tighten).
      </p>
      <StoryListImpl
        feedItems={feedItems}
        flagFor={flagFor}
        rightActionFor={rightActionFor}
        emptyMessage="Nothing matches the current rule."
        sourceFeed="tuning"
        showVelocity
        // No off-feed-pinned overlay on the Preview — the page is
        // asking "what would /hot render under this rule?", and
        // the pin overlay would inject the reader's curated list
        // on top, conflating "rule output" with "things you've
        // saved". Pure rule output is what's being tuned.
        includeOffFeedPinned={false}
        // Keep done rows visible. /hot strips them as part of the
        // reader's normal "I've already handled this" sweep, but
        // the Preview is asking "what does this rule surface,
        // independent of how much I've already worked through" —
        // an operator with an active reading habit would otherwise
        // see a near-empty Preview even when the rule is matching
        // plenty of trending stories.
        includeDone
        // Keep hidden rows visible *only when the rule matches
        // them* (the predicate doesn't widen the candidate pool
        // for hidden — see the comment block above). This is the
        // false-positive signal: the operator said "never again",
        // but the current rule still wants to promote it. Paired
        // with the per-row yellow question-mark right action.
        includeHidden
        // The Preview is a tuning experiment, not a reading-list
        // editor: suppress every row-level mutation affordance
        // (swipe pin/hide, long-press menu Pin/Hide/Share, the
        // bulk Sweep button) so the operator can't accidentally
        // pin / hide a story while dragging sliders. The
        // right-side icon stays — it's already a no-op via
        // `rightActionFor`'s `onToggle: () => {}`.
        readOnly
      />
    </details>
  );
}

function ThresholdLiveCounts({ events, flagFor }: CountsProps) {
  const pinTotal = events.filter((e) => e.action === 'pin').length;
  const hideTotal = events.filter((e) => e.action === 'hide').length;
  const pinMatch = events.filter(
    (e) => e.action === 'pin' && flagFor(e),
  ).length;
  const hideMatch = events.filter(
    (e) => e.action === 'hide' && flagFor(e),
  ).length;
  const pct = (n: number, total: number) =>
    total === 0 ? '—' : `${Math.round((n / total) * 100)}%`;
  return (
    <section data-testid="threshold-live-counts">
      <h2 className="admin-page__heading">Live counts under this rule</h2>
      <dl className="admin-page__list">
        <div>
          <dt>Pinned events that would be hot</dt>
          <dd data-testid="pin-match">
            {pinMatch} of {pinTotal}{' '}
            <span style={{ opacity: 0.6 }}>
              ({pct(pinMatch, pinTotal)})
            </span>
          </dd>
        </div>
        <div>
          <dt>Hidden events that would be hot</dt>
          <dd data-testid="hide-match">
            {hideMatch} of {hideTotal}{' '}
            <span style={{ opacity: 0.6 }}>
              ({pct(hideMatch, hideTotal)})
            </span>
          </dd>
        </div>
      </dl>
      <p className="admin-page__note">
        A good rule maximizes <em>pin matches</em> (you'd see the
        stories you wanted to read) while minimizing{' '}
        <em>hide matches</em> (you wouldn't be surfaced stories you'd
        already chosen to dismiss).
      </p>
    </section>
  );
}
