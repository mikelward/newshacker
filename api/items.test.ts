import { describe, expect, it, vi } from 'vitest';
import { handleItemsRequest, parseIds, type HNItem } from './items';

function makeRequest(query: string) {
  return new Request(`https://newshacker.app/api/items?${query}`);
}

function story(id: number, overrides: Partial<HNItem> = {}): HNItem {
  return {
    id,
    type: 'story',
    title: `Story ${id}`,
    url: `https://example.com/${id}`,
    by: 'alice',
    score: 10,
    descendants: 2,
    time: 1_700_000_000,
    kids: [id + 1000, id + 2000],
    ...overrides,
  };
}

describe('parseIds', () => {
  it('returns null for missing / empty input', () => {
    expect(parseIds(null)).toBeNull();
    expect(parseIds('')).toBeNull();
    expect(parseIds(' , ,')).toBeNull();
  });

  it('parses a comma-separated list of positive integers', () => {
    expect(parseIds('1,2,3')).toEqual([1, 2, 3]);
    expect(parseIds(' 10 , 20 , 30 ')).toEqual([10, 20, 30]);
  });

  it('deduplicates while preserving first-seen order', () => {
    expect(parseIds('1,2,1,3,2')).toEqual([1, 2, 3]);
  });

  it('rejects non-integer, zero, or negative ids', () => {
    expect(parseIds('1,abc,3')).toBeNull();
    expect(parseIds('1,-2,3')).toBeNull();
    expect(parseIds('0,1,2')).toBeNull();
    expect(parseIds('1.5,2')).toBeNull();
  });

  it('rejects more than 30 ids', () => {
    const ids = Array.from({ length: 31 }, (_, i) => i + 1).join(',');
    expect(parseIds(ids)).toBeNull();
  });
});

describe('handleItemsRequest', () => {
  it('returns 400 when ids is missing', async () => {
    const res = await handleItemsRequest(makeRequest(''));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid ids parameter' });
  });

  it('returns 400 for malformed ids', async () => {
    const res = await handleItemsRequest(makeRequest('ids=abc,123'));
    expect(res.status).toBe(400);
  });

  it('returns 400 for more than 30 ids', async () => {
    const ids = Array.from({ length: 31 }, (_, i) => i + 1).join(',');
    const res = await handleItemsRequest(makeRequest(`ids=${ids}`));
    expect(res.status).toBe(400);
  });

  it('fetches the requested items in parallel and returns them in order', async () => {
    const fetchItem = vi.fn(async (id: number) => story(id));
    const res = await handleItemsRequest(makeRequest('ids=10,20,30'), {
      fetchItem,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<HNItem | null>;
    expect(body.map((it) => it?.id)).toEqual([10, 20, 30]);
    expect(fetchItem).toHaveBeenCalledTimes(3);
  });

  it('thins the response — no kids, only feed fields', async () => {
    const fetchItem = async (id: number) => story(id);
    const res = await handleItemsRequest(makeRequest('ids=1'), { fetchItem });
    const [item] = (await res.json()) as Array<HNItem | null>;
    expect(item).not.toBeNull();
    expect(item).not.toHaveProperty('kids');
    expect(item?.id).toBe(1);
    expect(item?.title).toBe('Story 1');
    expect(item?.url).toBe('https://example.com/1');
  });

  it('preserves kids when fields=full (comment-prefetch needs reply counts)', async () => {
    const fetchItem = async (id: number) => story(id);
    const res = await handleItemsRequest(makeRequest('ids=1&fields=full'), {
      fetchItem,
    });
    const [item] = (await res.json()) as Array<HNItem | null>;
    expect(item).not.toBeNull();
    expect(item?.kids).toEqual([1001, 2001]);
  });

  it('ignores unknown fields= values and falls back to thin output', async () => {
    const fetchItem = async (id: number) => story(id);
    const res = await handleItemsRequest(makeRequest('ids=1&fields=junk'), {
      fetchItem,
    });
    const [item] = (await res.json()) as Array<HNItem | null>;
    expect(item).not.toHaveProperty('kids');
  });

  it('returns null for ids that Firebase resolves to null (deleted / unknown)', async () => {
    const fetchItem = async (id: number) => (id === 2 ? null : story(id));
    const res = await handleItemsRequest(makeRequest('ids=1,2,3'), {
      fetchItem,
    });
    const body = (await res.json()) as Array<HNItem | null>;
    expect(body[0]?.id).toBe(1);
    expect(body[1]).toBeNull();
    expect(body[2]?.id).toBe(3);
  });

  it('returns null instead of failing when a single item fetch throws', async () => {
    const fetchItem = async (id: number) => {
      if (id === 99) throw new Error('boom');
      return story(id);
    };
    const res = await handleItemsRequest(makeRequest('ids=1,99,2'), {
      fetchItem,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<HNItem | null>;
    expect(body[0]?.id).toBe(1);
    expect(body[1]).toBeNull();
    expect(body[2]?.id).toBe(2);
  });

  it('sets cache headers for browser + edge reuse', async () => {
    const fetchItem = async (id: number) => story(id);
    const res = await handleItemsRequest(makeRequest('ids=1'), { fetchItem });
    const cache = res.headers.get('cache-control') ?? '';
    expect(cache).toMatch(/public/);
    expect(cache).toMatch(/max-age=60/);
    expect(cache).toMatch(/s-maxage=60/);
    expect(cache).toMatch(/stale-while-revalidate=300/);
  });
});
