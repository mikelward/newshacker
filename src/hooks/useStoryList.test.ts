// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { deriveRefreshState, feedQueryRetryDelay } from './useStoryList';

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
  it('backs off exponentially and caps at 8s', () => {
    expect(feedQueryRetryDelay(0)).toBe(1000);
    expect(feedQueryRetryDelay(1)).toBe(2000);
    expect(feedQueryRetryDelay(2)).toBe(4000);
    expect(feedQueryRetryDelay(3)).toBe(8000);
    expect(feedQueryRetryDelay(10)).toBe(8000);
  });
});
