import { describe, expect, it } from 'vitest';
import {
  TRACKED_OUTCOMES,
  handleWarmStatsRequest,
  type WarmStatsKv,
} from './warm-stats';

function makeRequest(opts: { referer?: string | null } = {}) {
  const headers = new Headers();
  const referer =
    opts.referer === undefined ? 'https://newshacker.app/top' : opts.referer;
  if (referer !== null) headers.set('referer', referer);
  return new Request('https://newshacker.app/api/warm-stats', { headers });
}

function createKv(values: Record<string, string>): WarmStatsKv {
  return {
    async get(key) {
      return values[key] ?? null;
    },
  };
}

describe('handleWarmStatsRequest', () => {
  it('returns 403 for a disallowed Referer', async () => {
    const res = await handleWarmStatsRequest(
      makeRequest({ referer: 'https://evil.com/' }),
      { kv: null },
    );
    expect(res.status).toBe(403);
  });

  it('returns zero counters and redis=unavailable when kv is null', async () => {
    const res = await handleWarmStatsRequest(makeRequest(), { kv: null });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redis).toBe('unavailable');
    expect(body.budgetUsed).toBe(0);
    expect(body.outcomes).toEqual({});
  });

  it('reports today counters and budget used', async () => {
    // Freeze time to 2026-04-21 UTC so the day key is deterministic.
    const now = () => Date.UTC(2026, 3, 21, 12, 0, 0);
    const day = '20260421';
    const values: Record<string, string> = {
      [`newshacker:warm:counter:generated:${day}`]: '5',
      [`newshacker:warm:counter:cached:${day}`]: '100',
      [`newshacker:warm:counter:error:gemini:${day}`]: '2',
      [`newshacker:warm:budget:${day}`]: '7',
    };
    const res = await handleWarmStatsRequest(makeRequest(), {
      kv: createKv(values),
      now,
    });
    const body = await res.json();
    expect(body.day).toBe(day);
    expect(body.redis).toBe('ok');
    expect(body.budgetUsed).toBe(7);
    expect(body.outcomes.generated).toBe(5);
    expect(body.outcomes.cached).toBe(100);
    expect(body.outcomes['error:gemini']).toBe(2);
    // Unseeded outcomes should default to 0 rather than being omitted, so
    // a dashboard consumer can rely on the full set of keys.
    for (const name of TRACKED_OUTCOMES) {
      expect(body.outcomes[name]).toBeTypeOf('number');
    }
  });

  it('sets no-store cache-control', async () => {
    const res = await handleWarmStatsRequest(makeRequest(), { kv: null });
    expect(res.headers.get('cache-control') ?? '').toMatch(/no-store/);
  });
});
