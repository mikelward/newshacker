import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  handleCommentsSummaryRequest,
  __clearCacheForTests,
} from './comments-summary';
// Local type mirrors the handler's internal HNItem — duplicated
// intentionally so the test doesn't reach into the handler's private
// module shape.
interface HNItem {
  id?: number;
  type?: string;
  by?: string;
  time?: number;
  title?: string;
  url?: string;
  text?: string;
  score?: number;
  descendants?: number;
  dead?: boolean;
  deleted?: boolean;
  kids?: number[];
}

const ALLOWED_REFERER = 'https://newshacker.app/item/100';

function makeRequest(
  id: string | null,
  opts: { referer?: string | null } = {},
) {
  const base = 'https://newshacker.app/api/comments-summary';
  const full = id === null ? base : `${base}?id=${id}`;
  const headers = new Headers();
  const referer = opts.referer === undefined ? ALLOWED_REFERER : opts.referer;
  if (referer !== null) headers.set('referer', referer);
  return new Request(full, { headers });
}

interface GenerateRequest {
  model: string;
  contents: string;
  config?: { responseMimeType?: string };
}

interface FakeResponse {
  text: string | null;
}

function createFakeClient(responses: Array<FakeResponse | Error>) {
  const queue = [...responses];
  const generateContent = vi.fn(async (_req: GenerateRequest) => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected generateContent call');
    if (next instanceof Error) throw next;
    return next;
  });
  return { models: { generateContent } };
}

function fetchItemFrom(items: Record<number, HNItem | null>) {
  return vi.fn(async (id: number) => items[id] ?? null);
}

// A fixed timestamp that is safely "old" relative to any `now` the tests
// bind to (test `now` is in 2023/2024, this story is from Sept 2020).
// Using a wall-clock-relative value would interact badly with tests that
// pin `now` to a past moment, flipping the young-story TTL branch on.
const OLD_STORY_TIME = 1_600_000_000;

describe('handleCommentsSummaryRequest', () => {
  const origGoogle = process.env.GOOGLE_API_KEY;

  beforeEach(() => {
    __clearCacheForTests();
    process.env.GOOGLE_API_KEY = 'test-key';
  });
  afterEach(() => {
    if (origGoogle === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = origGoogle;
  });

  it('returns 403 when the Referer header is missing', async () => {
    const res = await handleCommentsSummaryRequest(
      makeRequest('1', { referer: null }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 for a disallowed Referer host', async () => {
    const res = await handleCommentsSummaryRequest(
      makeRequest('1', { referer: 'https://evil.com/' }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 when id is missing', async () => {
    const res = await handleCommentsSummaryRequest(makeRequest(null));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid id parameter' });
  });

  it('returns 400 for non-numeric ids', async () => {
    const res = await handleCommentsSummaryRequest(makeRequest('abc'));
    expect(res.status).toBe(400);
  });

  it('returns 400 for zero / negative ids', async () => {
    expect(
      (await handleCommentsSummaryRequest(makeRequest('0'))).status,
    ).toBe(400);
    expect(
      (await handleCommentsSummaryRequest(makeRequest('-5'))).status,
    ).toBe(400);
  });

  it('returns 503 when GOOGLE_API_KEY is unset', async () => {
    delete process.env.GOOGLE_API_KEY;
    const res = await handleCommentsSummaryRequest(makeRequest('1'));
    expect(res.status).toBe(503);
  });

  it('returns 404 when the story is missing / deleted / dead', async () => {
    const fetchItem = fetchItemFrom({ 1: null });
    const res = await handleCommentsSummaryRequest(makeRequest('1'), {
      fetchItem,
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when a story has no kids', async () => {
    const fetchItem = fetchItemFrom({
      1: { id: 1, type: 'story', title: 'No comments', time: OLD_STORY_TIME },
    });
    const res = await handleCommentsSummaryRequest(makeRequest('1'), {
      fetchItem,
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when all kids are deleted / dead / missing', async () => {
    const fetchItem = fetchItemFrom({
      10: {
        id: 10,
        type: 'story',
        kids: [11, 12, 13],
        time: OLD_STORY_TIME,
      },
      11: { id: 11, type: 'comment', deleted: true },
      12: { id: 12, type: 'comment', dead: true, by: 'x', text: 'y' },
      13: null,
    });
    const res = await handleCommentsSummaryRequest(makeRequest('10'), {
      fetchItem,
    });
    expect(res.status).toBe(404);
  });

  it('summarizes the top comments and strips HTML before sending to the model', async () => {
    const fetchItem = fetchItemFrom({
      100: {
        id: 100,
        type: 'story',
        title: 'Great post',
        kids: [101, 102],
        time: OLD_STORY_TIME,
      },
      101: {
        id: 101,
        type: 'comment',
        by: 'alice',
        text: '<p>I <i>agree</i> with the author.</p>',
        time: OLD_STORY_TIME + 60,
      },
      102: {
        id: 102,
        type: 'comment',
        by: 'bob',
        text: 'counterpoint &amp; caveat',
        time: OLD_STORY_TIME + 120,
      },
    });
    const client = createFakeClient([
      {
        text: JSON.stringify([
          { text: 'Readers mostly agree.', authors: ['alice'] },
          { text: 'One caveat raised.', authors: ['bob'] },
        ]),
      },
    ]);
    const res = await handleCommentsSummaryRequest(makeRequest('100'), {
      fetchItem,
      createClient: () => client,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      insights: [
        { text: 'Readers mostly agree.', authors: ['alice'] },
        { text: 'One caveat raised.', authors: ['bob'] },
      ],
    });

    const call = client.models.generateContent.mock.calls[0]![0];
    // Title in header
    expect(call.contents).toContain('Great post');
    // HTML stripped; entities decoded
    expect(call.contents).toContain('I agree with the author.');
    expect(call.contents).toContain('counterpoint & caveat');
    // Authors included
    expect(call.contents).toContain('[#1 by alice]');
    expect(call.contents).toContain('[#2 by bob]');
    // JSON mime requested
    expect(call.config?.responseMimeType).toBe('application/json');
  });

  it('accepts insights without authors (synthesis bullets)', async () => {
    const fetchItem = fetchItemFrom({
      105: {
        id: 105,
        type: 'story',
        kids: [106],
        time: OLD_STORY_TIME,
      },
      106: {
        id: 106,
        type: 'comment',
        by: 'alice',
        text: 'a point',
        time: 1,
      },
    });
    const client = createFakeClient([
      {
        text: JSON.stringify([
          { text: 'Commenters broadly agreed.' },
          { text: 'A small group dissented.', authors: [] },
        ]),
      },
    ]);
    const res = await handleCommentsSummaryRequest(makeRequest('105'), {
      fetchItem,
      createClient: () => client,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      insights: [
        { text: 'Commenters broadly agreed.' },
        { text: 'A small group dissented.' },
      ],
    });
  });

  it('drops hallucinated authors that are not in the input batch', async () => {
    const fetchItem = fetchItemFrom({
      107: {
        id: 107,
        type: 'story',
        kids: [108, 109],
        time: OLD_STORY_TIME,
      },
      108: {
        id: 108,
        type: 'comment',
        by: 'alice',
        text: 'point one',
        time: 1,
      },
      109: {
        id: 109,
        type: 'comment',
        by: 'bob',
        text: 'point two',
        time: 2,
      },
    });
    const client = createFakeClient([
      {
        text: JSON.stringify([
          // Mix of real (alice, bob), invented (eve), and duplicated (alice, alice).
          {
            text: 'First insight.',
            authors: ['alice', 'eve', 'alice'],
          },
          // Only invented authors → field should drop entirely.
          { text: 'Second insight.', authors: ['ghostuser'] },
        ]),
      },
    ]);
    const res = await handleCommentsSummaryRequest(makeRequest('107'), {
      fetchItem,
      createClient: () => client,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      insights: [
        { text: 'First insight.', authors: ['alice'] },
        { text: 'Second insight.' },
      ],
    });
  });

  it('wraps legacy bare-string insights into the object shape (no authors)', async () => {
    const fetchItem = fetchItemFrom({
      110: {
        id: 110,
        type: 'story',
        kids: [111],
        time: OLD_STORY_TIME,
      },
      111: { id: 111, type: 'comment', by: 'x', text: 'hi', time: 1 },
    });
    // Older / looser responses that still return bare strings are still
    // parsed — they just carry no author attribution.
    const client = createFakeClient([{ text: '["one", "two"]' }]);
    const res = await handleCommentsSummaryRequest(makeRequest('110'), {
      fetchItem,
      createClient: () => client,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      insights: [{ text: 'one' }, { text: 'two' }],
    });
  });

  it('filters deleted / dead kids before building the transcript', async () => {
    const fetchItem = fetchItemFrom({
      200: {
        id: 200,
        type: 'story',
        kids: [201, 202, 203],
        time: OLD_STORY_TIME,
      },
      201: { id: 201, type: 'comment', by: 'a', text: 'real 1', time: 1 },
      202: { id: 202, type: 'comment', deleted: true },
      203: { id: 203, type: 'comment', by: 'c', text: 'real 2', time: 2 },
    });
    const client = createFakeClient([{ text: '["ok"]' }]);
    await handleCommentsSummaryRequest(makeRequest('200'), {
      fetchItem,
      createClient: () => client,
    });
    const contents = client.models.generateContent.mock.calls[0]![0].contents;
    expect(contents).toContain('real 1');
    expect(contents).toContain('real 2');
    expect(contents).not.toMatch(/\[#2 by \]/);
  });

  it('caps the sample at the first 20 top-level kids', async () => {
    const kidIds = Array.from({ length: 30 }, (_, i) => 1000 + i);
    const items: Record<number, HNItem | null> = {
      500: {
        id: 500,
        type: 'story',
        kids: kidIds,
        time: OLD_STORY_TIME,
      },
    };
    for (const id of kidIds) {
      items[id] = {
        id,
        type: 'comment',
        by: `u${id}`,
        text: `body-${id}`,
        time: 1,
      };
    }
    const fetchItem = fetchItemFrom(items);
    const client = createFakeClient([{ text: '["x"]' }]);
    await handleCommentsSummaryRequest(makeRequest('500'), {
      fetchItem,
      createClient: () => client,
    });
    // Story fetch (1) + first 20 kid fetches = 21 calls.
    expect(fetchItem).toHaveBeenCalledTimes(21);
    const contents = client.models.generateContent.mock.calls[0]![0].contents;
    expect(contents).toContain('body-1000');
    expect(contents).toContain('body-1019');
    expect(contents).not.toContain('body-1020');
  });

  it('supports Ask HN self-posts (no url) as long as there are kids', async () => {
    const fetchItem = fetchItemFrom({
      700: {
        id: 700,
        type: 'story',
        title: 'Ask HN: what do you think?',
        // no url
        kids: [701],
        time: OLD_STORY_TIME,
      },
      701: {
        id: 701,
        type: 'comment',
        by: 'x',
        text: 'here is my take',
        time: 1,
      },
    });
    const client = createFakeClient([{ text: '["Takes are taken."]' }]);
    const res = await handleCommentsSummaryRequest(makeRequest('700'), {
      fetchItem,
      createClient: () => client,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      insights: [{ text: 'Takes are taken.' }],
    });
  });

  it('falls back to list-line parsing when the model returns a non-JSON response', async () => {
    const fetchItem = fetchItemFrom({
      800: {
        id: 800,
        type: 'story',
        kids: [801],
        time: OLD_STORY_TIME,
      },
      801: {
        id: 801,
        type: 'comment',
        by: 'x',
        text: 'hi',
        time: 1,
      },
    });
    const client = createFakeClient([
      {
        text:
          'Here are the insights:\n' +
          '- First insight.\n' +
          '- Second insight.\n' +
          '- Third insight.',
      },
    ]);
    const res = await handleCommentsSummaryRequest(makeRequest('800'), {
      fetchItem,
      createClient: () => client,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      insights: Array<{ text: string; authors?: string[] }>;
    };
    expect(body.insights).toEqual([
      { text: 'Here are the insights:' },
      { text: 'First insight.' },
      { text: 'Second insight.' },
      { text: 'Third insight.' },
    ]);
  });

  it('accepts JSON wrapped in a fenced code block', async () => {
    const fetchItem = fetchItemFrom({
      810: {
        id: 810,
        type: 'story',
        kids: [811],
        time: OLD_STORY_TIME,
      },
      811: {
        id: 811,
        type: 'comment',
        by: 'x',
        text: 'hi',
        time: 1,
      },
    });
    const client = createFakeClient([
      { text: '```json\n["fenced insight"]\n```' },
    ]);
    const res = await handleCommentsSummaryRequest(makeRequest('810'), {
      fetchItem,
      createClient: () => client,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      insights: [{ text: 'fenced insight' }],
    });
  });

  it('returns 502 when the model throws', async () => {
    const fetchItem = fetchItemFrom({
      900: {
        id: 900,
        type: 'story',
        kids: [901],
        time: OLD_STORY_TIME,
      },
      901: { id: 901, type: 'comment', by: 'x', text: 'hi', time: 1 },
    });
    const client = createFakeClient([new Error('boom')]);
    const res = await handleCommentsSummaryRequest(makeRequest('900'), {
      fetchItem,
      createClient: () => client,
    });
    expect(res.status).toBe(502);
  });

  it('returns 502 when the model returns an empty / unparseable response', async () => {
    const fetchItem = fetchItemFrom({
      910: {
        id: 910,
        type: 'story',
        kids: [911],
        time: OLD_STORY_TIME,
      },
      911: { id: 911, type: 'comment', by: 'x', text: 'hi', time: 1 },
    });
    const client = createFakeClient([{ text: '   ' }]);
    const res = await handleCommentsSummaryRequest(makeRequest('910'), {
      fetchItem,
      createClient: () => client,
    });
    expect(res.status).toBe(502);
  });

  it('serves a cached summary on a repeat request within the TTL window', async () => {
    const fetchItem = fetchItemFrom({
      1000: {
        id: 1000,
        type: 'story',
        kids: [1001],
        time: OLD_STORY_TIME,
      },
      1001: { id: 1001, type: 'comment', by: 'x', text: 'hi', time: 1 },
    });
    const client = createFakeClient([{ text: '["one"]' }]);
    let now = 1_700_000_000_000;
    const r1 = await handleCommentsSummaryRequest(makeRequest('1000'), {
      fetchItem,
      createClient: () => client,
      now: () => now,
    });
    expect(await r1.json()).toEqual({ insights: [{ text: 'one' }] });

    // 30 min later — within the 1h older-story TTL.
    now += 30 * 60 * 1000;
    const client2 = createFakeClient([{ text: '["two"]' }]);
    const r2 = await handleCommentsSummaryRequest(makeRequest('1000'), {
      fetchItem,
      createClient: () => client2,
      now: () => now,
    });
    expect(await r2.json()).toEqual({
      insights: [{ text: 'one' }],
      cached: true,
    });
    expect(client2.models.generateContent).not.toHaveBeenCalled();
  });

  it('sets the older-story shared-cache header on a successful older-story response', async () => {
    const fetchItem = fetchItemFrom({
      1300: {
        id: 1300,
        type: 'story',
        kids: [1301],
        time: OLD_STORY_TIME,
      },
      1301: { id: 1301, type: 'comment', by: 'x', text: 'hi', time: 1 },
    });
    const client = createFakeClient([{ text: '["ok"]' }]);
    const res = await handleCommentsSummaryRequest(makeRequest('1300'), {
      fetchItem,
      createClient: () => client,
      now: () => 1_700_000_000_000,
    });
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toMatch(/public/);
    expect(cc).toMatch(/s-maxage=3600/);
    expect(cc).toMatch(/stale-while-revalidate=14400/);
  });

  it('sets the younger 30-min shared-cache header on young stories', async () => {
    const now = 1_700_000_000_000;
    const youngStoryTime = Math.floor(now / 1000) - 30 * 60;
    const fetchItem = fetchItemFrom({
      1310: {
        id: 1310,
        type: 'story',
        kids: [1311],
        time: youngStoryTime,
      },
      1311: { id: 1311, type: 'comment', by: 'x', text: 'hi', time: 1 },
    });
    const client = createFakeClient([{ text: '["ok"]' }]);
    const res = await handleCommentsSummaryRequest(makeRequest('1310'), {
      fetchItem,
      createClient: () => client,
      now: () => now,
    });
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toMatch(/s-maxage=1800/);
    expect(cc).toMatch(/stale-while-revalidate=3600/);
  });

  it('also sets the shared-cache header when serving from the in-memory cache', async () => {
    const fetchItem = fetchItemFrom({
      1320: {
        id: 1320,
        type: 'story',
        kids: [1321],
        time: OLD_STORY_TIME,
      },
      1321: { id: 1321, type: 'comment', by: 'x', text: 'hi', time: 1 },
    });
    const client = createFakeClient([{ text: '["v1"]' }]);
    let now = 1_700_000_000_000;
    await handleCommentsSummaryRequest(makeRequest('1320'), {
      fetchItem,
      createClient: () => client,
      now: () => now,
    });
    now += 1_000;
    const res = await handleCommentsSummaryRequest(makeRequest('1320'), {
      fetchItem,
      createClient: () => createFakeClient([]),
      now: () => now,
    });
    expect((await res.json()) as { cached?: boolean }).toMatchObject({
      cached: true,
    });
    expect(res.headers.get('cache-control') ?? '').toMatch(/s-maxage=3600/);
  });

  it('sets no-store on error responses so the edge does not cache them', async () => {
    const r403 = await handleCommentsSummaryRequest(
      makeRequest('1', { referer: null }),
    );
    expect(r403.headers.get('cache-control') ?? '').toMatch(/no-store/);

    const r400 = await handleCommentsSummaryRequest(makeRequest(null));
    expect(r400.headers.get('cache-control') ?? '').toMatch(/no-store/);
  });

  it('re-fetches after the older-story 1h TTL expires', async () => {
    const fetchItem = fetchItemFrom({
      1100: {
        id: 1100,
        type: 'story',
        kids: [1101],
        time: OLD_STORY_TIME,
      },
      1101: { id: 1101, type: 'comment', by: 'x', text: 'hi', time: 1 },
    });
    let now = 1_700_000_000_000;
    const client1 = createFakeClient([{ text: '["v1"]' }]);
    await handleCommentsSummaryRequest(makeRequest('1100'), {
      fetchItem,
      createClient: () => client1,
      now: () => now,
    });

    now += 60 * 60 * 1000 + 1;
    const client2 = createFakeClient([{ text: '["v2"]' }]);
    const res = await handleCommentsSummaryRequest(makeRequest('1100'), {
      fetchItem,
      createClient: () => client2,
      now: () => now,
    });
    expect(await res.json()).toEqual({ insights: [{ text: 'v2' }] });
  });

  it('uses the shorter 30-min TTL for young (< 2h old) stories', async () => {
    let now = 1_700_000_000_000;
    const youngStoryTime = Math.floor(now / 1000) - 30 * 60; // 30 min old
    const fetchItem = fetchItemFrom({
      1200: {
        id: 1200,
        type: 'story',
        kids: [1201],
        time: youngStoryTime,
      },
      1201: { id: 1201, type: 'comment', by: 'x', text: 'hi', time: 1 },
    });

    // First call populates cache.
    const client1 = createFakeClient([{ text: '["v1"]' }]);
    await handleCommentsSummaryRequest(makeRequest('1200'), {
      fetchItem,
      createClient: () => client1,
      now: () => now,
    });

    // 29 min later — still cached (< 30min TTL).
    now += 29 * 60 * 1000;
    const clientStillCached = createFakeClient([{ text: '["v-noop"]' }]);
    const rCached = await handleCommentsSummaryRequest(makeRequest('1200'), {
      fetchItem,
      createClient: () => clientStillCached,
      now: () => now,
    });
    expect(await rCached.json()).toMatchObject({
      insights: [{ text: 'v1' }],
      cached: true,
    });
    expect(clientStillCached.models.generateContent).not.toHaveBeenCalled();

    // Bump past 30 min — should re-run (proving TTL is 30min, not 1h).
    now += 2 * 60 * 1000;
    const client2 = createFakeClient([{ text: '["v2"]' }]);
    const res = await handleCommentsSummaryRequest(makeRequest('1200'), {
      fetchItem,
      createClient: () => client2,
      now: () => now,
    });
    expect(await res.json()).toEqual({ insights: [{ text: 'v2' }] });
    expect(client2.models.generateContent).toHaveBeenCalledTimes(1);
  });
});
