import { track } from '@vercel/analytics';

// Vercel's custom-event UI groups by exact property value, so raw pixel
// or character values would produce thousands of singleton buckets that
// are useless for breakdown analysis. Rounding to the nearest 20 keeps
// the top-N bucket lists readable while preserving the resolution we
// actually need to tune summary-card sizing.
export function bucket20(n: number): number {
  return Math.round(n / 20) * 20;
}

export type SummaryKind = 'article' | 'comments';

export interface SummaryLayoutEvent {
  kind: SummaryKind;
  cardWidthPx: number;
  summaryChars: number;
  reservedContentHeightPx: number;
  renderedContentHeightPx: number;
  insightCount?: number;
}

export function trackSummaryLayout(event: SummaryLayoutEvent): void {
  const payload: Record<string, string | number> = {
    kind: event.kind,
    card_w: bucket20(event.cardWidthPx),
    summary_chars: bucket20(event.summaryChars),
    reserved_h: bucket20(event.reservedContentHeightPx),
    rendered_h: bucket20(event.renderedContentHeightPx),
    delta_h: bucket20(
      event.renderedContentHeightPx - event.reservedContentHeightPx,
    ),
  };
  if (event.insightCount !== undefined) {
    payload.insight_count = event.insightCount;
  }
  track('summary_layout', payload);
  // Second sink: our own /api/telemetry collector. Vercel Web Analytics only
  // exposes marginal per-property breakdowns in its UI, which isn't enough to
  // tune the Thread.tsx skeleton constants (we need joint distributions of
  // kind × card_w × delta_h). This fire-and-forget POST lets the analyzer
  // script in scripts/analyze-summary-layout.mjs aggregate the full shape.
  postTelemetry(payload);
}

// Fire-and-forget: any failure here is silent. `keepalive` is set so the
// request survives an unloading page (tab close, navigation). We don't
// `await` the promise — the card mount effect doesn't block on it, and a
// telemetry failure must never surface as a user-visible error.
function postTelemetry(payload: Record<string, string | number>): void {
  if (typeof fetch === 'undefined') return;
  try {
    const p = fetch('/api/telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    });
    if (p && typeof (p as Promise<unknown>).catch === 'function') {
      (p as Promise<unknown>).catch(() => {});
    }
  } catch {
    // Synchronous throw (e.g. no base URL in a non-browser env).
  }
}
