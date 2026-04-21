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
}
