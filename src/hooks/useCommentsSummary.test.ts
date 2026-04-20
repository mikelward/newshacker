import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _fetchCommentsSummaryForTests,
  commentsSummaryQueryKey,
} from './useCommentsSummary';

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
