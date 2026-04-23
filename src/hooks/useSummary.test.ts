import { describe, expect, it } from 'vitest';
import {
  SUMMARY_FRESHNESS_MS,
  SUMMARY_RETENTION_MS,
  summaryQueryKey,
  summaryQueryOptions,
} from './useSummary';

describe('useSummary query options', () => {
  it('produces a stable, id-scoped query key', () => {
    expect(summaryQueryKey(42)).toEqual(['summary', 42]);
    expect(summaryQueryKey(1)).not.toEqual(summaryQueryKey(2));
  });

  // Regression guard: a pinned story revisited mid-week should be a
  // synchronous React Query cache hit (retention = 7 d), but after
  // 30 min the entry should be marked stale so the next mount refetches
  // and picks up cron-regenerated updates. staleTime === gcTime would
  // either never refetch (7 d) or gc too early (30 min).
  it('splits freshness (staleTime) from retention (gcTime)', () => {
    const opts = summaryQueryOptions(1);
    expect(opts.staleTime).toBe(30 * 60 * 1000);
    expect(opts.gcTime).toBe(7 * 24 * 60 * 60 * 1000);
    expect(opts.staleTime).toBeLessThan(opts.gcTime);
  });

  it('exports the constants the prefetch helpers import', () => {
    expect(SUMMARY_FRESHNESS_MS).toBe(30 * 60 * 1000);
    expect(SUMMARY_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
