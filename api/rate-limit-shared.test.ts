// @vitest-environment node
// Regression guard for the shared-bucket contract: /api/summary and
// /api/comments-summary must count cache-miss requests against the same
// per-IP bucket, because a single thread view incurs one Gemini call
// against each — and the whole point of shared bucketing is "one thread
// view = 2 units against one IP". A future refactor that accidentally
// splits the key prefix (or bucket keys by handler) would double the
// effective budget for any given abuser and silently undo the design.
//
// The two handlers inline their own copies of the rate-limit helpers per
// AGENTS.md § "Vercel api/ gotchas". This test imports each handler's
// types separately and exercises both end-to-end against one in-memory
// store to prove the key namespace is shared.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRedisRateLimitStore as createSummaryRedisStore,
  handleSummaryRequest,
  RATE_LIMIT_KEY_PREFIX as SUMMARY_RATE_LIMIT_KEY_PREFIX,
  type RateLimitRedis as SummaryRateLimitRedis,
  type RateLimitStore as SummaryRateLimitStore,
  type RateLimitTier as SummaryRateLimitTier,
} from './summary';
import {
  createRedisRateLimitStore as createCommentsRedisStore,
  handleCommentsSummaryRequest,
  RATE_LIMIT_KEY_PREFIX as COMMENTS_RATE_LIMIT_KEY_PREFIX,
} from './comments-summary';

const ALLOWED_REFERER = 'https://newshacker.app/item/1';

function createSharedRateLimitStore(): SummaryRateLimitStore & {
  counts: Map<string, number>;
  calls: string[];
} {
  const counts = new Map<string, number>();
  const calls: string[] = [];
  return {
    counts,
    calls,
    async incrementWithExpiry(key: string) {
      calls.push(key);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
  };
}

function jinaBody(content: string): string {
  return JSON.stringify({
    code: 200,
    status: 20000,
    data: { content, usage: { tokens: 10 } },
  });
}

function makeSummaryRequest(forwardedFor: string) {
  const headers = new Headers();
  headers.set('referer', ALLOWED_REFERER);
  headers.set('x-forwarded-for', forwardedFor);
  return new Request('https://newshacker.app/api/summary?id=1', { headers });
}

function makeCommentsRequest(forwardedFor: string) {
  const headers = new Headers();
  headers.set('referer', ALLOWED_REFERER);
  headers.set('x-forwarded-for', forwardedFor);
  return new Request('https://newshacker.app/api/comments-summary?id=1', {
    headers,
  });
}

describe('shared rate-limit bucket across summary handlers', () => {
  const origGoogle = process.env.GOOGLE_API_KEY;
  const origJina = process.env.JINA_API_KEY;

  beforeEach(() => {
    process.env.GOOGLE_API_KEY = 'test-key';
    process.env.JINA_API_KEY = 'test-jina-key';
  });
  afterEach(() => {
    if (origGoogle === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = origGoogle;
    if (origJina === undefined) delete process.env.JINA_API_KEY;
    else process.env.JINA_API_KEY = origJina;
  });

  it('uses the same key prefix from both handlers', () => {
    // If this ever diverges, the cross-handler regression test below
    // will still fail, but the mismatched constant is the
    // easier-to-diagnose first symptom.
    expect(SUMMARY_RATE_LIMIT_KEY_PREFIX).toBe(COMMENTS_RATE_LIMIT_KEY_PREFIX);
  });

  it('counts a thread view (article + comments) as 2 units against one bucket', async () => {
    const rateLimitStore = createSharedRateLimitStore();
    // Tight 3-unit budget so two requests pass and the third 429s,
    // regardless of which handler serves the third.
    const tiers: SummaryRateLimitTier[] = [
      { name: 'burst', limit: 2, windowSeconds: 600 },
    ];
    const ip = '203.0.113.7';

    // Disable both caches (`store: null`) so every call is a cache
    // miss and actually touches the rate-limit bucket. Otherwise a
    // successful first call would populate its cache and a second call
    // against the same id would short-circuit at the cache-hit branch
    // before the rate-limit check, which is correct handler behavior
    // but would not exercise what this test is about.
    const summaryDeps = {
      createClient: () => ({
        models: {
          generateContent: vi.fn(async () => ({ text: 'article summary' })),
        },
      }),
      fetchImpl: vi.fn(
        async () =>
          new Response(jinaBody('article body'), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ) as unknown as typeof fetch,
      fetchItem: vi.fn(async (id: number) => {
        if (id === 1) {
          return {
            id: 1,
            type: 'story',
            url: 'https://example.com/a',
            score: 10,
          };
        }
        return null;
      }),
      store: null,
      rateLimitStore,
      rateLimitTiers: tiers,
    };

    const commentsDeps = {
      createClient: () => ({
        models: {
          generateContent: vi.fn(async () => ({ text: 'a comment insight' })),
        },
      }),
      fetchItem: vi.fn(async (id: number) => {
        if (id === 1) {
          return {
            id: 1,
            type: 'story',
            score: 10,
            kids: [2],
            time: 1_600_000_000,
            title: 'Shared bucket test',
          };
        }
        if (id === 2) {
          return { id: 2, type: 'comment', text: 'hi' };
        }
        return null;
      }),
      store: null,
      rateLimitStore,
      rateLimitTiers: tiers,
    };

    const first = await handleSummaryRequest(
      makeSummaryRequest(ip),
      summaryDeps,
    );
    const second = await handleCommentsSummaryRequest(
      makeCommentsRequest(ip),
      commentsDeps,
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // Third request — from either handler — must be blocked because
    // the first two already burned the 2-unit budget on this IP.
    const blocked = await handleCommentsSummaryRequest(
      makeCommentsRequest(ip),
      commentsDeps,
    );
    expect(blocked.status).toBe(429);

    // Every increment hit the shared prefix, and the counter for this
    // IP went 1 → 2 → 3.
    expect(rateLimitStore.calls.length).toBe(3);
    for (const key of rateLimitStore.calls) {
      expect(key.startsWith(SUMMARY_RATE_LIMIT_KEY_PREFIX)).toBe(true);
    }
    const uniqueKeys = new Set(rateLimitStore.calls);
    expect(uniqueKeys.size).toBe(1);
    const [only] = uniqueKeys;
    expect(rateLimitStore.counts.get(only!)).toBe(3);
  });
});

// Regression: each increment must atomically (re-)propose the TTL via
// EXPIRE NX, so a single dropped EXPIRE can't leave the key alive
// without an expiry. The pre-fix shape called EXPIRE only when
// count===1 inside a try/catch that swallowed the error — meaning a
// transient blip stranded the key without a TTL until Upstash's
// memory eviction kicked in.
//
// Tests both handler copies of `createRedisRateLimitStore` because they
// are inlined per-handler (AGENTS.md § "Vercel api/ gotchas") and the
// regression has to be guarded in both.
describe.each([
  ['summary', createSummaryRedisStore] as const,
  ['comments-summary', createCommentsRedisStore] as const,
])('createRedisRateLimitStore (%s)', (_label, factory) => {
  function fakeRedis() {
    const counts = new Map<string, number>();
    const calls: Array<
      ['incr', string] | ['expire', string, number, string]
    > = [];
    const redis: SummaryRateLimitRedis = {
      pipeline() {
        const queued: Array<() => unknown> = [];
        const builder: ReturnType<SummaryRateLimitRedis['pipeline']> = {
          incr(key: string) {
            queued.push(() => {
              calls.push(['incr', key]);
              const next = (counts.get(key) ?? 0) + 1;
              counts.set(key, next);
              return next;
            });
            return builder;
          },
          expire(key: string, seconds: number, option: 'NX') {
            queued.push(() => {
              calls.push(['expire', key, seconds, option]);
              return 1;
            });
            return builder;
          },
          exec<T extends unknown[]>() {
            return Promise.resolve(queued.map((fn) => fn()) as T);
          },
        };
        return builder;
      },
    };
    return { redis, counts, calls };
  }

  it('issues INCR + EXPIRE NX in a single pipeline on every call', async () => {
    const { redis, calls } = fakeRedis();
    const store = factory(redis);
    await store.incrementWithExpiry('k', 600);
    await store.incrementWithExpiry('k', 600);
    await store.incrementWithExpiry('k', 600);
    // Three pipelined round trips, each with INCR followed by EXPIRE NX.
    // The NX guard on EXPIRE is what preserves fixed-window semantics —
    // without it, every increment would refresh the TTL into a sliding
    // window and a busy IP's counter would never reset.
    expect(calls).toEqual([
      ['incr', 'k'],
      ['expire', 'k', 600, 'NX'],
      ['incr', 'k'],
      ['expire', 'k', 600, 'NX'],
      ['incr', 'k'],
      ['expire', 'k', 600, 'NX'],
    ]);
  });

  it('returns the post-INCR count from the pipeline result', async () => {
    const { redis } = fakeRedis();
    const store = factory(redis);
    expect(await store.incrementWithExpiry('k', 600)).toBe(1);
    expect(await store.incrementWithExpiry('k', 600)).toBe(2);
    expect(await store.incrementWithExpiry('k', 600)).toBe(3);
  });
});
