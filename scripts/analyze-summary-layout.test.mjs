// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  aggregate,
  format,
  parseField,
  recommend,
  tierFor,
  weightedQuantile,
} from './analyze-summary-layout.mjs';

describe('parseField', () => {
  it('parses an article field (empty trailing insight slot)', () => {
    expect(parseField('article|400|220|120|140|20|', 7)).toEqual({
      kind: 'article',
      cardW: 400,
      summaryChars: 220,
      reservedH: 120,
      renderedH: 140,
      deltaH: 20,
      insightCount: null,
      count: 7,
    });
  });

  it('parses a comments field with insight_count', () => {
    expect(parseField('comments|640|400|240|220|-20|5', 3)).toEqual({
      kind: 'comments',
      cardW: 640,
      summaryChars: 400,
      reservedH: 240,
      renderedH: 220,
      deltaH: -20,
      insightCount: 5,
      count: 3,
    });
  });

  it('returns null for malformed, wrong-arity, or non-numeric input', () => {
    expect(parseField('article|400|220|120|140|20', 1)).toBeNull();
    expect(parseField('other|400|220|120|140|20|', 1)).toBeNull();
    expect(parseField('article|x|220|120|140|20|', 1)).toBeNull();
    expect(parseField('article|400|220|120|140|20|', 0)).toBeNull();
    expect(parseField(null, 1)).toBeNull();
  });
});

describe('tierFor', () => {
  it('splits at 520 (phone vs. tablet+)', () => {
    expect(tierFor(400)).toBe('phone');
    expect(tierFor(500)).toBe('phone');
    expect(tierFor(520)).toBe('tablet+');
    expect(tierFor(800)).toBe('tablet+');
  });
});

describe('weightedQuantile', () => {
  it('returns null for empty input', () => {
    expect(weightedQuantile([], 0.5)).toBeNull();
  });

  it('matches a uniform unweighted median', () => {
    const samples = [10, 20, 30, 40, 50].map((v) => ({ value: v, weight: 1 }));
    expect(weightedQuantile(samples, 0.5)).toBe(30);
    expect(weightedQuantile(samples, 0.9)).toBe(50);
  });

  it('respects bucket weights', () => {
    // 9 events of value 0, 1 event of value 100 → p90 is still 0 (9/10 ≤ 0.9).
    const samples = [
      { value: 0, weight: 9 },
      { value: 100, weight: 1 },
    ];
    expect(weightedQuantile(samples, 0.5)).toBe(0);
    expect(weightedQuantile(samples, 0.9)).toBe(0);
    // 8 events of 0, 2 of 100 → p90 crosses into the 100 bucket.
    const samples2 = [
      { value: 0, weight: 8 },
      { value: 100, weight: 2 },
    ];
    expect(weightedQuantile(samples2, 0.9)).toBe(100);
  });
});

describe('aggregate', () => {
  it('groups by (kind, tier) and sums counts', () => {
    const records = [
      parseField('article|400|220|120|140|20|', 3),
      parseField('article|400|220|120|140|20|', 2),
      parseField('article|640|220|120|140|0|', 1),
      parseField('comments|400|300|200|240|40|4', 5),
    ];
    const cells = aggregate(records);
    expect(cells).toHaveLength(3);
    const articlePhone = cells.find(
      (c) => c.kind === 'article' && c.tier === 'phone',
    );
    expect(articlePhone?.count).toBe(5);
    const articleTablet = cells.find(
      (c) => c.kind === 'article' && c.tier === 'tablet+',
    );
    expect(articleTablet?.count).toBe(1);
    const commentsPhone = cells.find(
      (c) => c.kind === 'comments' && c.tier === 'phone',
    );
    expect(commentsPhone?.count).toBe(5);
    expect(commentsPhone?.insightCount).toEqual([{ value: 4, weight: 5 }]);
  });
});

describe('recommend', () => {
  it('uses p90 of article summary_chars for ARTICLE_SUMMARY_EXPECTED_CHARS (rounded to 5)', () => {
    // 9 events with 200 chars, 1 with 240 → p90 = 200, rounded to 5 = 200.
    const records = [
      parseField('article|400|200|120|140|20|', 9),
      parseField('article|400|240|120|160|40|', 1),
    ];
    const rec = recommend(records);
    expect(rec.ARTICLE_SUMMARY_EXPECTED_CHARS).toBe(200);
  });

  it('uses p90 of comments insight_count for EXPECTED_INSIGHT_COUNT', () => {
    // 8 events with 4 insights, 2 with 5 → p90 = 5.
    const records = [
      parseField('comments|400|300|200|240|40|4', 8),
      parseField('comments|400|400|200|260|60|5', 2),
    ];
    const rec = recommend(records);
    expect(rec.EXPECTED_INSIGHT_COUNT).toBe(5);
  });

  it('uses p90 of (summary_chars / insight_count) for INSIGHT_EXPECTED_CHARS', () => {
    // All events: 400 chars / 5 insights = 80 chars/insight.
    const records = [
      parseField('comments|400|400|200|240|40|5', 10),
    ];
    const rec = recommend(records);
    expect(rec.INSIGHT_EXPECTED_CHARS).toBe(80);
  });

  it('returns null for metrics without data', () => {
    const records = [parseField('article|400|220|120|140|20|', 1)];
    const rec = recommend(records);
    expect(rec.EXPECTED_INSIGHT_COUNT).toBeNull();
    expect(rec.INSIGHT_EXPECTED_CHARS).toBeNull();
  });
});

describe('format', () => {
  it('renders a report with an arrow for changed constants and "unchanged" otherwise', () => {
    // Tune the records so ARTICLE_SUMMARY_EXPECTED_CHARS recommends 230
    // (the current value) and EXPECTED_INSIGHT_COUNT recommends 5.
    const records = [
      parseField('article|400|230|120|140|20|', 10),
      parseField('comments|400|375|200|240|40|5', 10),
    ];
    const cells = aggregate(records);
    const rec = recommend(records);
    const report = format(cells, rec);
    expect(report).toContain('ARTICLE · phone · 10 events');
    expect(report).toContain('COMMENTS · phone · 10 events');
    expect(report).toContain('ARTICLE_SUMMARY_EXPECTED_CHARS');
    expect(report).toMatch(/ARTICLE_SUMMARY_EXPECTED_CHARS.*unchanged \(230\)/);
    expect(report).toMatch(/EXPECTED_INSIGHT_COUNT.*unchanged \(5\)/);
  });

  it('renders an empty-data report without crashing', () => {
    const report = format([], recommend([]));
    expect(report).toContain('(no data yet)');
  });
});
