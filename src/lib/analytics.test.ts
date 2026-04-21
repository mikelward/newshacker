import { beforeEach, describe, expect, it, vi } from 'vitest';

const trackSpy = vi.fn();
vi.mock('@vercel/analytics', () => ({
  track: (name: string, props: unknown) => trackSpy(name, props),
}));

import { bucket20, trackSummaryLayout } from './analytics';

describe('bucket20', () => {
  it('rounds non-negative values to the nearest 20', () => {
    expect(bucket20(0)).toBe(0);
    expect(bucket20(9)).toBe(0);
    expect(bucket20(10)).toBe(20);
    expect(bucket20(29)).toBe(20);
    expect(bucket20(31)).toBe(40);
    expect(bucket20(210)).toBe(220);
    expect(bucket20(211)).toBe(220);
  });

  it('rounds negative values to the nearest 20', () => {
    expect(bucket20(-1)).toBe(-0);
    expect(bucket20(-11)).toBe(-20);
    expect(bucket20(-35)).toBe(-40);
    expect(bucket20(-211)).toBe(-220);
  });
});

describe('trackSummaryLayout', () => {
  beforeEach(() => trackSpy.mockClear());

  it('emits a summary_layout event with bucketed properties for article kind', () => {
    trackSummaryLayout({
      kind: 'article',
      cardWidthPx: 391,
      summaryChars: 214,
      reservedContentHeightPx: 124,
      renderedContentHeightPx: 144,
    });
    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy).toHaveBeenCalledWith('summary_layout', {
      kind: 'article',
      card_w: 400,
      summary_chars: 220,
      reserved_h: 120,
      rendered_h: 140,
      delta_h: 20,
    });
  });

  it('includes insight_count and handles negative delta for comments kind', () => {
    trackSummaryLayout({
      kind: 'comments',
      cardWidthPx: 390,
      summaryChars: 240,
      reservedContentHeightPx: 200,
      renderedContentHeightPx: 158,
      insightCount: 4,
    });
    expect(trackSpy).toHaveBeenCalledWith(
      'summary_layout',
      expect.objectContaining({
        kind: 'comments',
        insight_count: 4,
        delta_h: -40,
      }),
    );
  });
});
