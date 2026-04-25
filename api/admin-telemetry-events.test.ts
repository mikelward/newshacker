// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { handleTelemetryEvents } from './admin-telemetry-events';

const ADMIN_COOKIE = 'hn_session=mikelward%26hash';
const NON_ADMIN_COOKIE = 'hn_session=alice%26hash';

interface FakeRedis {
  store: Map<string, string[]>;
  failRead?: boolean;
  lrange: (key: string, start: number, stop: number) => Promise<string[]>;
}

function fakeRedis(
  initial: Record<string, unknown[]> = {},
  opts: { failRead?: boolean } = {},
): FakeRedis {
  const store = new Map<string, string[]>();
  for (const [k, v] of Object.entries(initial)) {
    store.set(
      k,
      v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))),
    );
  }
  return {
    store,
    failRead: opts.failRead,
    async lrange(key) {
      if (opts.failRead) throw new Error('boom');
      return store.get(key) ?? [];
    },
  };
}

function request(
  method: 'GET' | 'POST',
  cookie: string | null = ADMIN_COOKIE,
): Request {
  const headers = new Headers();
  if (cookie !== null) headers.set('cookie', cookie);
  return new Request('https://newshacker.app/api/admin-telemetry-events', {
    method,
    headers,
  });
}

const verifyOk = async () => ({
  ok: true as const,
  username: 'mikelward',
  httpStatus: 200,
});

describe('handleTelemetryEvents', () => {
  it('rejects non-GET methods', async () => {
    const res = await handleTelemetryEvents(request('POST'));
    expect(res.status).toBe(405);
  });

  it('returns 401 when the session cookie is missing', async () => {
    const res = await handleTelemetryEvents(request('GET', null));
    expect(res.status).toBe(401);
  });

  it('returns 403 when the session prefix is not the admin user', async () => {
    const res = await handleTelemetryEvents(
      request('GET', NON_ADMIN_COOKIE),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { reason?: string };
    expect(body.reason).toBe('admin_user_mismatch');
  });

  it('returns 403 when the HN round-trip says someone else', async () => {
    const res = await handleTelemetryEvents(request('GET'), {
      verifyHn: async () => ({
        ok: true,
        username: 'somebodyelse',
        httpStatus: 200,
      }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 503 when HN is unreachable', async () => {
    const res = await handleTelemetryEvents(request('GET'), {
      verifyHn: async () => ({ ok: false, reason: 'unreachable' }),
    });
    expect(res.status).toBe(503);
  });

  it('returns empty arrays when Redis is not configured', async () => {
    // No env stubs — `hasRedisCredentials()` sees nothing and the
    // handler returns the empty-payload happy path so the UI shows
    // "no events yet" rather than an error.
    const res = await handleTelemetryEvents(request('GET'), {
      verifyHn: verifyOk,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: unknown[]; anon: unknown[] };
    expect(body.user).toEqual([]);
    expect(body.anon).toEqual([]);
  });

  it('returns user + anon arrays from Redis', async () => {
    vi.stubEnv('KV_REST_API_URL', 'https://example.com');
    vi.stubEnv('KV_REST_API_TOKEN', 'tok');
    try {
      const userEvent = {
        action: 'pin',
        id: 1,
        score: 87,
        time: 1700000000,
        isHot: true,
        sourceFeed: 'top',
        eventTime: 1700001000000,
      };
      const anonEvent = {
        action: 'hide',
        id: 2,
        score: 5,
        time: 1700000500,
        isHot: false,
        sourceFeed: 'new',
        eventTime: 1700001100000,
      };
      const redis = fakeRedis({
        'telemetry:user:mikelward': [userEvent],
        'telemetry:preview:anon': [anonEvent],
      });
      const res = await handleTelemetryEvents(request('GET'), {
        verifyHn: verifyOk,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        redis: redis as any,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        user: typeof userEvent[];
        anon: typeof anonEvent[];
      };
      expect(body.user).toHaveLength(1);
      expect(body.user[0].id).toBe(1);
      expect(body.anon).toHaveLength(1);
      expect(body.anon[0].id).toBe(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('drops malformed JSON entries silently', async () => {
    vi.stubEnv('KV_REST_API_URL', 'https://example.com');
    vi.stubEnv('KV_REST_API_TOKEN', 'tok');
    try {
      const validEvent = {
        action: 'pin',
        id: 1,
        score: 87,
        time: 1700000000,
        isHot: true,
        sourceFeed: 'top',
        eventTime: 1700001000000,
      };
      const redis = fakeRedis({
        'telemetry:user:mikelward': [
          'not json',
          { ...validEvent, action: 'invalid' }, // wrong action
          { id: 1 }, // missing fields
          validEvent,
        ],
        'telemetry:preview:anon': [],
      });
      const res = await handleTelemetryEvents(request('GET'), {
        verifyHn: verifyOk,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        redis: redis as any,
      });
      const body = (await res.json()) as { user: unknown[] };
      // Only the valid event survives.
      expect(body.user).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('returns 503 when Redis throws on read', async () => {
    vi.stubEnv('KV_REST_API_URL', 'https://example.com');
    vi.stubEnv('KV_REST_API_TOKEN', 'tok');
    try {
      const redis = fakeRedis({}, { failRead: true });
      const res = await handleTelemetryEvents(request('GET'), {
        verifyHn: verifyOk,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        redis: redis as any,
      });
      expect(res.status).toBe(503);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
