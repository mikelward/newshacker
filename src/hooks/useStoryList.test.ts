// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveRefreshState,
  FEED_QUERY_MAX_RETRIES,
  FEED_REFETCH_POLICY,
  feedQueryRetry,
  feedQueryRetryDelay,
} from './useStoryList';

describe('FEED_REFETCH_POLICY', () => {
  it('gates every refetch trigger on the cache TTL instead of forcing one on mount', () => {
    // `refetchOnMount: true` is React Query's stale-gated default: it
    // refetches on mount only once the cache is older than staleTime. The
    // literal `'always'` (the previous value) would ignore the TTL and
    // re-check on every remount — the "checking for new stories too often"
    // bug, since opening a story unmounts the feed.
    expect(FEED_REFETCH_POLICY.refetchOnMount).toBe(true);
    // Window-focus refetch stays ON, but it too is stale-gated by `true`
    // (not `'always'`), so a refocus only re-checks a lapsed cache.
    expect(FEED_REFETCH_POLICY.refetchOnWindowFocus).toBe(true);
    expect(FEED_REFETCH_POLICY.refetchOnReconnect).toBe(true);
  });
});

describe('deriveRefreshState', () => {
  it('reports neither when a fresh load just succeeded', () => {
    expect(
      deriveRefreshState({
        hasData: true,
        refetching: false,
        latestAttemptFailed: false,
      }),
    ).toEqual({ isRefreshing: false, refreshFailed: false });
  });

  it('reports refreshing while a background refetch is in flight', () => {
    expect(
      deriveRefreshState({
        hasData: true,
        refetching: true,
        latestAttemptFailed: false,
      }),
    ).toEqual({ isRefreshing: true, refreshFailed: false });
  });

  it('reports refreshFailed when the latest refresh errored over cached data', () => {
    // The silent-staleness case: React Query keeps status:'success' (so
    // isError is false) when a query has data and only a background
    // refetch fails. We must still tell the reader the list is stale.
    expect(
      deriveRefreshState({
        hasData: true,
        refetching: false,
        latestAttemptFailed: true,
      }),
    ).toEqual({ isRefreshing: false, refreshFailed: true });
  });

  it('prefers the refreshing signal while a retry is still running', () => {
    // Mid-retry the last attempt may have failed but another is in
    // flight — show "checking", not "failed", until the retries settle.
    expect(
      deriveRefreshState({
        hasData: true,
        refetching: true,
        latestAttemptFailed: true,
      }),
    ).toEqual({ isRefreshing: true, refreshFailed: false });
  });

  it('stays quiet on the first load when there is no data yet', () => {
    // With no rows on screen the loading/empty/error states own the UI;
    // the refresh strip is only for "stale rows are showing".
    expect(
      deriveRefreshState({
        hasData: false,
        refetching: true,
        latestAttemptFailed: false,
      }),
    ).toEqual({ isRefreshing: false, refreshFailed: false });
    expect(
      deriveRefreshState({
        hasData: false,
        refetching: false,
        latestAttemptFailed: true,
      }),
    ).toEqual({ isRefreshing: false, refreshFailed: false });
  });
});

describe('feedQueryRetryDelay', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('backs off exponentially with jitter, capping the base at 8s', () => {
    // Pin the jitter so the exponential shape is assertable. The delay is
    // cap/2 + random * cap/2: at random=0.5 that's 0.75 * cap.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(feedQueryRetryDelay(0)).toBe(750);
    expect(feedQueryRetryDelay(1)).toBe(1500);
    expect(feedQueryRetryDelay(2)).toBe(3000);
    expect(feedQueryRetryDelay(3)).toBe(6000);
    expect(feedQueryRetryDelay(10)).toBe(6000);
  });

  it('jitters within [cap/2, cap] so parallel clients never retry in lockstep', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(feedQueryRetryDelay(3)).toBe(4000);
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    expect(feedQueryRetryDelay(3)).toBeLessThan(8000);
    expect(feedQueryRetryDelay(3)).toBeGreaterThan(7999);
  });
});

describe('feedQueryRetry', () => {
  it('retries statusless network blips up to the max', () => {
    const blip = new TypeError('Failed to fetch');
    for (let attempt = 0; attempt < FEED_QUERY_MAX_RETRIES; attempt++) {
      expect(feedQueryRetry(attempt, blip)).toBe(true);
    }
    expect(feedQueryRetry(FEED_QUERY_MAX_RETRIES, blip)).toBe(false);
  });

  it('never retries an error that carried an HTTP status', () => {
    // A response reached us: re-asking won't change a 4xx, and retrying a
    // 5xx storms a backend that just said it's struggling — the tracker's
    // 'down' state + rate-bounded recovery probe own that path.
    expect(feedQueryRetry(0, new Error('HN API 500: /topstories.json'))).toBe(
      false,
    );
    expect(feedQueryRetry(0, new Error('items API 404'))).toBe(false);
  });
});
