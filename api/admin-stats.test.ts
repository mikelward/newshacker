// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleAdminStatsRequest,
  rowsFromAxiomTable,
  type StatsResponse,
} from './admin-stats';

// Standard "happy path" HN-verify stub — used by every test that
// doesn't care about the auth gate. Tests that exercise the gate
// override per-call.
const verifyMikelward = vi.fn(async (_sessionValue: string) => ({
  ok: true as const,
  username: 'mikelward',
}));

function requestWithCookie(cookie: string | null): Request {
  const headers = new Headers();
  if (cookie !== null) headers.set('cookie', cookie);
  return new Request('https://newshacker.app/api/admin-stats', {
    method: 'GET',
    headers,
  });
}

// Build a column-oriented Axiom tabular response — the wire format
// /api/admin-stats expects. Most card tests just want to feed
// canned aggregation rows back to the parser.
function axiomTabular(
  fields: string[],
  rows: unknown[][],
): { tables: { fields: { name: string }[]; columns: unknown[][] }[] } {
  const columns: unknown[][] = fields.map((_, i) => rows.map((r) => r[i]));
  return {
    tables: [{ fields: fields.map((name) => ({ name })), columns }],
  };
}

// A `fetch` stub that returns a different canned Axiom response for
// each call, in the order the cards execute. Lets a test exercise
// all five cards' parsers in one shot. The handler kicks the cards
// off in `Promise.all` order: cacheHits, tokens, failures,
// rateLimit, warmCron — so that's the order we queue responses.
type Tabular = ReturnType<typeof axiomTabular>;
function axiomFetchSequence(
  responses: (Tabular | { status: number; body: unknown })[],
): { fetchImpl: typeof fetch; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  let i = 0;
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const bodyText =
      typeof init?.body === 'string' ? init.body : '';
    let body: unknown = bodyText;
    try {
      body = JSON.parse(bodyText);
    } catch {
      // bodyText left as-is
    }
    calls.push({ url, body });
    const next = responses[i++];
    if (!next) {
      return new Response('{}', { status: 500 });
    }
    if ('status' in next && 'body' in next) {
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('rowsFromAxiomTable', () => {
  it('transposes column-oriented tabular into row records', () => {
    const table = {
      fields: [{ name: 'outcome' }, { name: 'count_' }],
      columns: [
        ['cached', 'generated', 'error'],
        [120, 18, 4],
      ],
    };
    expect(rowsFromAxiomTable(table)).toEqual([
      { outcome: 'cached', count_: 120 },
      { outcome: 'generated', count_: 18 },
      { outcome: 'error', count_: 4 },
    ]);
  });

  it('returns [] for missing or malformed tables', () => {
    expect(rowsFromAxiomTable(undefined)).toEqual([]);
    expect(rowsFromAxiomTable({})).toEqual([]);
    expect(rowsFromAxiomTable({ fields: [], columns: [] })).toEqual([]);
  });

  it('skips fields with no name and pads missing column values', () => {
    const table = {
      fields: [{ name: 'a' }, { name: undefined }, { name: 'b' }],
      columns: [
        [1, 2],
        ['ignored1', 'ignored2'],
        [10],
      ],
    };
    expect(rowsFromAxiomTable(table)).toEqual([
      { a: 1, b: 10 },
      { a: 2, b: undefined },
    ]);
  });
});

describe('handleAdminStatsRequest — auth gate', () => {
  const envSnapshot: Record<string, string | undefined> = {};
  const envKeys = [
    'ADMIN_USERNAME',
    'AXIOM_API_TOKEN',
    'AXIOM_DATASET',
    'SESSION_COOKIE_NAME',
  ];

  beforeEach(() => {
    for (const k of envKeys) {
      envSnapshot[k] = process.env[k];
      delete process.env[k];
    }
    verifyMikelward.mockClear();
  });
  afterEach(() => {
    for (const k of envKeys) {
      if (envSnapshot[k] === undefined) delete process.env[k];
      else process.env[k] = envSnapshot[k];
    }
  });

  it('rejects non-GET with 405', async () => {
    const res = await handleAdminStatsRequest(
      new Request('https://newshacker.app/api/admin-stats', { method: 'POST' }),
    );
    expect(res.status).toBe(405);
  });

  it('returns 401 when no session cookie is present', async () => {
    const res = await handleAdminStatsRequest(requestWithCookie(null));
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
  });

  it('returns 401 when the session cookie value is malformed', async () => {
    const res = await handleAdminStatsRequest(requestWithCookie('hn_session=a'));
    expect(res.status).toBe(401);
  });

  it('fast-rejects non-admin prefixes with 403 + signedInAs (no HN round-trip)', async () => {
    const verifyHn = vi.fn(async () => ({ ok: true as const, username: 'eve' }));
    const res = await handleAdminStatsRequest(
      requestWithCookie('hn_session=eve%26abc'),
      { verifyHn },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { reason: string; signedInAs: string };
    expect(body.reason).toBe('admin_user_mismatch');
    expect(body.signedInAs).toBe('eve');
    expect(verifyHn).not.toHaveBeenCalled();
  });

  it('returns 503 when the HN round-trip times out', async () => {
    const res = await handleAdminStatsRequest(
      requestWithCookie('hn_session=mikelward%26abc'),
      {
        verifyHn: async () => ({ ok: false, reason: 'timeout' }),
      },
    );
    expect(res.status).toBe(503);
  });

  it('returns 403 when HN says the cookie belongs to someone else', async () => {
    const res = await handleAdminStatsRequest(
      requestWithCookie('hn_session=mikelward%26abc'),
      {
        verifyHn: async () => ({ ok: true, username: 'eve' }),
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { reason: string; signedInAs: string };
    expect(body.reason).toBe('admin_user_mismatch');
    expect(body.signedInAs).toBe('eve');
  });

  it('returns configured:false when AXIOM_API_TOKEN is unset', async () => {
    const res = await handleAdminStatsRequest(
      requestWithCookie('hn_session=mikelward%26abc'),
      { verifyHn: verifyMikelward },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatsResponse;
    expect(body.configured).toBe(false);
    expect(body.cards).toBeNull();
    expect(body.axiom.tokenConfigured).toBe(false);
    expect(body.axiom.dataset).toBeNull();
  });

  it('returns configured:false when AXIOM_DATASET is unset (token alone is not enough)', async () => {
    process.env.AXIOM_API_TOKEN = 'xaat-stub';
    const res = await handleAdminStatsRequest(
      requestWithCookie('hn_session=mikelward%26abc'),
      { verifyHn: verifyMikelward },
    );
    const body = (await res.json()) as StatsResponse;
    expect(body.configured).toBe(false);
    expect(body.axiom.tokenConfigured).toBe(true);
    expect(body.axiom.dataset).toBeNull();
  });

  it('never echoes AXIOM_API_TOKEN value in any response shape', async () => {
    process.env.AXIOM_API_TOKEN = 'xaat-secret-token-do-not-leak';
    process.env.AXIOM_DATASET = 'vercel';
    const { fetchImpl } = axiomFetchSequence([
      axiomTabular(['outcome', 'count_'], [['cached', 1]]),
      axiomTabular(['geminiPromptTokens', 'geminiOutputTokens', 'jinaTokens'], [[0, 0, 0]]),
      axiomTabular(['reason', 'count_'], []),
      axiomTabular(['count_'], [[0]]),
      axiomTabular(['_time', 'durationMs', 'processed', 'storyCount'], []),
    ]);
    const res = await handleAdminStatsRequest(
      requestWithCookie('hn_session=mikelward%26abc'),
      { verifyHn: verifyMikelward, fetchImpl },
    );
    const text = await res.text();
    expect(text).not.toContain('xaat-secret-token-do-not-leak');
  });
});

describe('handleAdminStatsRequest — card queries + parsing', () => {
  const envSnapshot: Record<string, string | undefined> = {};
  const envKeys = [
    'ADMIN_USERNAME',
    'AXIOM_API_TOKEN',
    'AXIOM_DATASET',
    'AXIOM_PROJECT_NAME',
  ];
  beforeEach(() => {
    for (const k of envKeys) {
      envSnapshot[k] = process.env[k];
      delete process.env[k];
    }
    process.env.AXIOM_API_TOKEN = 'xaat-test';
    process.env.AXIOM_DATASET = 'vercel';
  });
  afterEach(() => {
    for (const k of envKeys) {
      if (envSnapshot[k] === undefined) delete process.env[k];
      else process.env[k] = envSnapshot[k];
    }
  });

  it('parses every card from a happy-path Axiom response set', async () => {
    const { fetchImpl, calls } = axiomFetchSequence([
      // cacheHits
      axiomTabular(
        ['outcome', 'count_'],
        [
          ['cached', 120],
          ['generated', 18],
          ['error', 4],
          ['rate_limited', 2],
        ],
      ),
      // tokens — split prompt + output so the UI can multiply each
      // by the right Gemini rate.
      axiomTabular(
        ['geminiPromptTokens', 'geminiOutputTokens', 'jinaTokens'],
        [[12_000, 345, 5_678]],
      ),
      // failures
      axiomTabular(
        ['reason', 'count_'],
        [
          ['story_unreachable', 7],
          ['summarization_failed', 3],
        ],
      ),
      // rateLimit
      axiomTabular(['count_'], [[2]]),
      // warmCron
      axiomTabular(
        ['_time', 'durationMs', 'processed', 'storyCount'],
        [['2026-04-26T08:00:00Z', 12_345, 60, 30]],
      ),
    ]);

    const res = await handleAdminStatsRequest(
      requestWithCookie('hn_session=mikelward%26abc'),
      { verifyHn: verifyMikelward, fetchImpl },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatsResponse;
    expect(body.configured).toBe(true);

    const cards = body.cards!;
    expect(cards.cacheHits).toEqual({
      ok: true,
      value: {
        windowSeconds: 3600,
        byOutcome: { cached: 120, generated: 18, error: 4, rate_limited: 2 },
      },
    });
    expect(cards.tokens).toEqual({
      ok: true,
      value: {
        windowSeconds: 86_400,
        geminiPromptTokens: 12_000,
        geminiOutputTokens: 345,
        jinaTokens: 5_678,
      },
    });
    expect(cards.failures).toEqual({
      ok: true,
      value: {
        windowSeconds: 86_400,
        byReason: [
          { reason: 'story_unreachable', count: 7 },
          { reason: 'summarization_failed', count: 3 },
        ],
      },
    });
    expect(cards.rateLimit).toEqual({
      ok: true,
      value: { windowSeconds: 3600, count: 2 },
    });
    expect(cards.warmCron).toEqual({
      ok: true,
      value: {
        windowSeconds: 21_600,
        lastRun: {
          tISO: '2026-04-26T08:00:00Z',
          durationMs: 12_345,
          processed: 60,
          storyCount: 30,
        },
      },
    });

    // All five cards hit Axiom's tabular endpoint with a Bearer
    // token and a parseable APL body. We don't pin the full APL
    // text — the queries are intentionally easy to tune — but we
    // do pin the contract: tabular endpoint, each query references
    // the dataset, and the right log-line filter for the right card.
    expect(calls).toHaveLength(5);
    for (const c of calls) {
      expect(c.url).toMatch(/api\.axiom\.co\/v1\/datasets\/_apl/);
      expect(c.url).toMatch(/format=tabular/);
      const apl = (c.body as { apl: string }).apl;
      expect(apl).toContain("['vercel']");
      // Every query must scope to this project — without it, a
      // multi-project Axiom would mix unrelated lines into our
      // rollups (and surface unrelated operational data on /admin).
      // Default project name is `newshacker`, matching CRON.md's
      // APL templates.
      expect(apl).toContain(
        '[\'vercel.projectName\'] == "newshacker"',
      );
    }
    // Card-specific log-line filters. Cache-hits / failures /
    // rate-limit are summary-only. Tokens unions summary + cron
    // because Gemini is called from both code paths and Jina is
    // billed under a different field name on each. Warm-cron card
    // pulls from warm-run (per-tick rollup) lines.
    expect((calls[0].body as { apl: string }).apl).toContain('summary-outcome');
    expect((calls[1].body as { apl: string }).apl).toContain('summary-outcome');
    expect((calls[1].body as { apl: string }).apl).toContain('warm-story');
    // Tokens query needs to reach both `e.jinaTokens` (user-path
    // field name) and `e.tokens` (warm-cron's Jina-billed count
    // field name). Pinning both keeps a refactor from silently
    // dropping the warm-cron half.
    expect((calls[1].body as { apl: string }).apl).toContain('e.jinaTokens');
    expect((calls[1].body as { apl: string }).apl).toContain('e.tokens');
    expect((calls[3].body as { apl: string }).apl).toContain('rate_limited');
    expect((calls[4].body as { apl: string }).apl).toContain('warm-run');
  });

  it('honors AXIOM_PROJECT_NAME for the projectName filter (forks / renames)', async () => {
    process.env.AXIOM_PROJECT_NAME = 'my-fork';
    const { fetchImpl, calls } = axiomFetchSequence([
      axiomTabular(['outcome', 'count_'], []),
      axiomTabular(['geminiPromptTokens', 'geminiOutputTokens', 'jinaTokens'], [[0, 0, 0]]),
      axiomTabular(['reason', 'count_'], []),
      axiomTabular(['count_'], [[0]]),
      axiomTabular(['_time', 'durationMs', 'processed', 'storyCount'], []),
    ]);
    await handleAdminStatsRequest(
      requestWithCookie('hn_session=mikelward%26abc'),
      { verifyHn: verifyMikelward, fetchImpl },
    );
    for (const c of calls) {
      const apl = (c.body as { apl: string }).apl;
      expect(apl).toContain('[\'vercel.projectName\'] == "my-fork"');
      expect(apl).not.toContain('"newshacker"');
    }
  });

  it('strips funky characters from AXIOM_PROJECT_NAME when building APL', async () => {
    process.env.AXIOM_PROJECT_NAME = 'evil"; DROP --';
    const { fetchImpl, calls } = axiomFetchSequence([
      axiomTabular(['outcome', 'count_'], []),
      axiomTabular(['geminiPromptTokens', 'geminiOutputTokens', 'jinaTokens'], [[0, 0, 0]]),
      axiomTabular(['reason', 'count_'], []),
      axiomTabular(['count_'], [[0]]),
      axiomTabular(['_time', 'durationMs', 'processed', 'storyCount'], []),
    ]);
    await handleAdminStatsRequest(
      requestWithCookie('hn_session=mikelward%26abc'),
      { verifyHn: verifyMikelward, fetchImpl },
    );
    for (const c of calls) {
      const apl = (c.body as { apl: string }).apl;
      expect(apl).toContain('[\'vercel.projectName\'] == "evilDROP--"');
      expect(apl).not.toContain('DROP --');
    }
  });

  it('degrades a single card to {ok:false} when its query 5xxs', async () => {
    const { fetchImpl } = axiomFetchSequence([
      axiomTabular(['outcome', 'count_'], [['cached', 5]]),
      // tokens query fails — but the rest should still come back
      { status: 502, body: { message: 'bad gateway' } },
      axiomTabular(['reason', 'count_'], []),
      axiomTabular(['count_'], [[0]]),
      axiomTabular(['_time', 'durationMs', 'processed', 'storyCount'], []),
    ]);
    const res = await handleAdminStatsRequest(
      requestWithCookie('hn_session=mikelward%26abc'),
      { verifyHn: verifyMikelward, fetchImpl },
    );
    const body = (await res.json()) as StatsResponse;
    const cards = body.cards!;
    expect(cards.cacheHits.ok).toBe(true);
    expect(cards.tokens.ok).toBe(false);
    if (!cards.tokens.ok) {
      expect(cards.tokens.reason).toMatch(/^axiom_http_502$/);
    }
    expect(cards.failures.ok).toBe(true);
    expect(cards.rateLimit.ok).toBe(true);
    expect(cards.warmCron.ok).toBe(true);
  });

  it('reports a 401 from Axiom as a typed reason on every card', async () => {
    const { fetchImpl } = axiomFetchSequence(
      Array.from({ length: 5 }, () => ({
        status: 401,
        body: { message: 'unauthorized' },
      })),
    );
    const res = await handleAdminStatsRequest(
      requestWithCookie('hn_session=mikelward%26abc'),
      { verifyHn: verifyMikelward, fetchImpl },
    );
    const body = (await res.json()) as StatsResponse;
    expect(body.configured).toBe(true);
    const cards = body.cards!;
    for (const c of [
      cards.cacheHits,
      cards.tokens,
      cards.failures,
      cards.rateLimit,
      cards.warmCron,
    ]) {
      expect(c.ok).toBe(false);
      if (!c.ok) expect(c.reason).toBe('axiom_http_401');
    }
  });

  it('reports an unreachable Axiom (transport error) as reason "unreachable"', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const res = await handleAdminStatsRequest(
      requestWithCookie('hn_session=mikelward%26abc'),
      { verifyHn: verifyMikelward, fetchImpl },
    );
    const body = (await res.json()) as StatsResponse;
    const cards = body.cards!;
    expect(cards.cacheHits.ok).toBe(false);
    if (!cards.cacheHits.ok) {
      expect(cards.cacheHits.reason).toBe('unreachable');
    }
  });

  it('strips funky characters from the dataset name when building APL', async () => {
    process.env.AXIOM_DATASET = "vercel'; DROP --"; // operator typo
    const { fetchImpl, calls } = axiomFetchSequence([
      axiomTabular(['outcome', 'count_'], []),
      axiomTabular(['geminiPromptTokens', 'geminiOutputTokens', 'jinaTokens'], [[0, 0, 0]]),
      axiomTabular(['reason', 'count_'], []),
      axiomTabular(['count_'], [[0]]),
      axiomTabular(['_time', 'durationMs', 'processed', 'storyCount'], []),
    ]);
    await handleAdminStatsRequest(
      requestWithCookie('hn_session=mikelward%26abc'),
      { verifyHn: verifyMikelward, fetchImpl },
    );
    for (const c of calls) {
      const apl = (c.body as { apl: string }).apl;
      // The unsafe characters from the operator's typo never make it
      // into the query.
      expect(apl).toContain("['vercelDROP--']");
      expect(apl).not.toContain('DROP --');
      expect(apl).not.toContain("'; ");
      expect(apl).not.toContain("vercel'");
    }
  });
});
