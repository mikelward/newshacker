import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { warmFeedSummaries } from './feedSummaryWarm';

describe('warmFeedSummaries', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('warms both /api/summary and /api/comments-summary for stories with a url', () => {
    warmFeedSummaries({ id: 1, score: 10, url: 'https://example.com/' });
    const urls = fetchSpy.mock.calls.map((c) => c[0]);
    expect(urls).toEqual(
      expect.arrayContaining(['/api/summary?id=1', '/api/comments-summary?id=1']),
    );
  });

  it('warms /api/summary for self-posts too (url absent, text present)', () => {
    // Regression guard: self-posts (Ask HN / Show HN) used to be excluded
    // from /api/summary warming because the endpoint returned no_article.
    // Now they are summarized directly from story.text, so the warmer
    // should fire for them as well.
    warmFeedSummaries({
      id: 2,
      score: 10,
      text: '<p>Body of an Ask HN post.</p>',
    });
    const urls = fetchSpy.mock.calls.map((c) => c[0]);
    expect(urls).toContain('/api/summary?id=2');
    expect(urls).toContain('/api/comments-summary?id=2');
  });

  it('skips /api/summary when the story has neither url nor text', () => {
    warmFeedSummaries({ id: 3, score: 10 });
    const urls = fetchSpy.mock.calls.map((c) => c[0]);
    expect(urls).not.toContain('/api/summary?id=3');
    // Comments track still warms — a kidless story is cheap (endpoint
    // short-circuits) and we don't know kids from this call site anyway.
    expect(urls).toContain('/api/comments-summary?id=3');
  });

  it('skips /api/summary when the self-post body is empty after HTML strip', () => {
    // Mirrors the server's `no_article` predicate: `<p> </p>` strips
    // down to whitespace and the endpoint 400s. No point burning a
    // request on it.
    warmFeedSummaries({ id: 5, score: 10, text: '<p>   </p>' });
    const urls = fetchSpy.mock.calls.map((c) => c[0]);
    expect(urls).not.toContain('/api/summary?id=5');
    expect(urls).toContain('/api/comments-summary?id=5');
  });

  it('does not warm anything for stories below the score floor', () => {
    warmFeedSummaries({ id: 4, score: 1, url: 'https://example.com/' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
