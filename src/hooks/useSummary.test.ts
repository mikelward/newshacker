import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _fetchSummaryForTests,
  SUMMARY_FRESHNESS_MS,
  SUMMARY_RETENTION_MS,
  SummaryError,
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
    expect(opts.staleTime).toBe(SUMMARY_FRESHNESS_MS);
    expect(opts.gcTime).toBe(SUMMARY_RETENTION_MS);
    expect(opts.staleTime).toBeLessThan(opts.gcTime);
  });

  // Independently guards the numeric values of the constants themselves,
  // so a silent drift (e.g. someone changes SUMMARY_FRESHNESS_MS to 5 min)
  // trips the test even though the query-options assertion above would
  // still pass after such a change.
  it('pins the constants to their intended values', () => {
    expect(SUMMARY_FRESHNESS_MS).toBe(30 * 60 * 1000);
    expect(SUMMARY_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('useSummary fetch error parsing', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces a rate_limited reason on 429 responses', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: 'Too many requests',
          reason: 'rate_limited',
          retryAfterSeconds: 60,
        }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const err = await _fetchSummaryForTests(7).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SummaryError);
    expect((err as SummaryError).reason).toBe('rate_limited');
  });
});
