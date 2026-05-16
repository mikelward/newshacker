import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { algoliaHitToHNItem, searchStories } from './algolia';

function stubAlgolia(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://hn.algolia.com/api/v1/')) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('algoliaHitToHNItem', () => {
  it('maps a story hit onto the HNItem shape', () => {
    const item = algoliaHitToHNItem({
      objectID: '42',
      author: 'alice',
      title: 'Hello',
      url: 'https://example.com',
      points: 12,
      num_comments: 3,
      created_at_i: 1_700_000_000,
      _tags: ['story', 'author_alice', 'story_42'],
    });
    expect(item).toEqual({
      id: 42,
      type: 'story',
      by: 'alice',
      title: 'Hello',
      url: 'https://example.com',
      text: undefined,
      score: 12,
      descendants: 3,
      time: 1_700_000_000,
    });
  });

  it('tags job posts as type=job', () => {
    const item = algoliaHitToHNItem({
      objectID: '7',
      title: 'Hire',
      _tags: ['job', 'author_x', 'story_7'],
    });
    expect(item?.type).toBe('job');
  });

  it('preserves self-post text into HNItem.text', () => {
    const item = algoliaHitToHNItem({
      objectID: '9',
      title: 'Ask HN',
      story_text: 'how do you Y?',
      _tags: ['story', 'ask_hn'],
    });
    expect(item?.text).toBe('how do you Y?');
    expect(item?.type).toBe('story');
  });

  it('returns null for hits with a non-numeric objectID', () => {
    expect(algoliaHitToHNItem({ objectID: 'nope' })).toBeNull();
  });

  it('defaults missing score / descendants to 0', () => {
    const item = algoliaHitToHNItem({ objectID: '1' });
    expect(item?.score).toBe(0);
    expect(item?.descendants).toBe(0);
  });
});

describe('searchStories', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('calls the relevance endpoint with the expected query string', async () => {
    const fetchMock = stubAlgolia({ hits: [], page: 0, nbPages: 0 });
    await searchStories({ query: 'rust async', sort: 'relevance', page: 0 });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toMatch(/\/search\?/);
    expect(url).toContain('query=rust+async');
    expect(url).toContain('tags=%28story%2Cjob%29');
    expect(url).toContain('hitsPerPage=30');
    expect(url).toContain('page=0');
  });

  it('switches to /search_by_date for sort=date', async () => {
    const fetchMock = stubAlgolia({ hits: [], page: 2, nbPages: 5 });
    await searchStories({ query: 'rust', sort: 'date', page: 2 });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/search_by_date?');
  });

  it('exposes hasMore=true while more pages are available', async () => {
    stubAlgolia({
      hits: [
        { objectID: '1', title: 'A' },
        { objectID: '2', title: 'B' },
      ],
      page: 0,
      nbPages: 3,
    });
    const res = await searchStories({ query: 'x', sort: 'relevance', page: 0 });
    expect(res.hits).toHaveLength(2);
    expect(res.hasMore).toBe(true);
  });

  it('flips hasMore=false on the last page', async () => {
    stubAlgolia({ hits: [{ objectID: '1' }], page: 2, nbPages: 3 });
    const res = await searchStories({ query: 'x', sort: 'relevance', page: 2 });
    expect(res.hasMore).toBe(false);
  });

  it('drops malformed hits rather than throwing', async () => {
    stubAlgolia({
      hits: [{ objectID: 'nope' }, { objectID: '3', title: 'OK' }],
      page: 0,
      nbPages: 1,
    });
    const res = await searchStories({ query: 'x', sort: 'relevance', page: 0 });
    expect(res.hits.map((h) => h.id)).toEqual([3]);
  });

  it('throws on a non-2xx Algolia response', async () => {
    stubAlgolia({ error: 'boom' }, 503);
    await expect(
      searchStories({ query: 'x', sort: 'relevance', page: 0 }),
    ).rejects.toThrow(/Algolia 503/);
  });
});
