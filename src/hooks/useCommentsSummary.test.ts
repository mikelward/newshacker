import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _fetchCommentsSummaryForTests,
  commentsSummaryQueryKey,
  commentsSummaryQueryOptions,
} from './useCommentsSummary';
import { SUMMARY_FRESHNESS_MS, SUMMARY_RETENTION_MS } from './useSummary';

describe('useCommentsSummary helpers', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('produces a stable, id-scoped query key', () => {
    expect(commentsSummaryQueryKey(42)).toEqual(['comments-summary', 42]);
    expect(commentsSummaryQueryKey(42)).toEqual(commentsSummaryQueryKey(42));
    expect(commentsSummaryQueryKey(1)).not.toEqual(commentsSummaryQueryKey(2));
  });

  // Regression guard: the pre-split code had staleTime === gcTime === 1 h,
  // which meant a pinned thread revisited after an hour went through a
  // loading state even though the bytes were still in the SW cache and the
  // persister. Retention now matches the SW 7-day TTL; freshness matches
  // the cron's default 30-min check interval so we don't over-refetch.
  // We also share the freshness/retention pair with useSummary so the
  // two cron-warmed endpoints can't silently drift apart.
  it('splits freshness (staleTime) from retention (gcTime)', () => {
    const opts = commentsSummaryQueryOptions(1);
    expect(opts.staleTime).toBe(SUMMARY_FRESHNESS_MS);
    expect(opts.gcTime).toBe(SUMMARY_RETENTION_MS);
    expect(opts.staleTime).toBeLessThan(opts.gcTime);
  });

  it('hits /api/comments-summary with the story id and returns the insights', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(
        JSON.stringify({ insights: ['one', 'two'] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await _fetchCommentsSummaryForTests(42);
    expect(result).toEqual({ insights: ['one', 'two'] });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/comments-summary?id=42',
      expect.any(Object),
    );
  });

  it('throws the server-provided error message on a non-ok response', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify({ error: 'No comments to summarize' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(_fetchCommentsSummaryForTests(7)).rejects.toThrow(
      'No comments to summarize',
    );
  });

  it('throws a generic error when the response body is not parseable', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response('<html>boom</html>', { status: 500 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(_fetchCommentsSummaryForTests(7)).rejects.toThrow(
      /summarization failed/i,
    );
  });
});
