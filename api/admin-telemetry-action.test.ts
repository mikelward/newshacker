// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { handleTelemetryAction } from './admin-telemetry-action';

const COOKIE = 'hn_session=mikelward%26hash';

interface FakeRedis {
  pushed: { key: string; value: string }[];
  trimmed: { key: string; start: number; stop: number }[];
  lpush: (key: string, value: string) => Promise<number>;
  ltrim: (key: string, start: number, stop: number) => Promise<string>;
}

function fakeRedis(opts: { failPush?: boolean } = {}): FakeRedis {
  const pushed: FakeRedis['pushed'] = [];
  const trimmed: FakeRedis['trimmed'] = [];
  return {
    pushed,
    trimmed,
    async lpush(key: string, value: string) {
      if (opts.failPush) throw new Error('boom');
      pushed.push({ key, value });
      return pushed.length;
    },
    async ltrim(key: string, start: number, stop: number) {
      trimmed.push({ key, start, stop });
      return 'OK';
    },
  };
}

function request(
  method: 'GET' | 'POST',
  body?: unknown,
  cookie: string | null = COOKIE,
): Request {
  const headers = new Headers();
  if (cookie !== null) headers.set('cookie', cookie);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request('https://newshacker.app/api/admin-telemetry-action', {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    action: 'pin',
    id: 12345,
    score: 87,
    time: 1700000000,
    isHot: true,
    sourceFeed: 'top',
    eventTime: 1700001000000,
    ...overrides,
  };
}

describe('handleTelemetryAction', () => {
  it('rejects non-POST methods', async () => {
    const res = await handleTelemetryAction(request('GET'));
    expect(res.status).toBe(405);
  });

  it('writes to telemetry:user:<username> in production with a valid cookie', async () => {
    const redis = fakeRedis();
    // Stub credential check via env so the helper proceeds to the
    // injected redis stub instead of bailing on missing creds.
    vi.stubEnv('KV_REST_API_URL', 'https://example.com');
    vi.stubEnv('KV_REST_API_TOKEN', 'tok');
    try {
      const res = await handleTelemetryAction(
        request('POST', validBody()),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { env: 'production', redis: redis as any },
      );
      expect(res.status).toBe(204);
      expect(redis.pushed).toHaveLength(1);
      expect(redis.pushed[0].key).toBe('telemetry:user:mikelward');
      // Trim happens after push to keep the cap honest.
      expect(redis.trimmed).toHaveLength(1);
      expect(redis.trimmed[0].key).toBe('telemetry:user:mikelward');
      expect(redis.trimmed[0].start).toBe(0);
      expect(redis.trimmed[0].stop).toBeGreaterThan(0);
      // The stored value is the full validated event JSON.
      const stored = JSON.parse(redis.pushed[0].value);
      expect(stored.action).toBe('pin');
      expect(stored.id).toBe(12345);
      expect(stored.sourceFeed).toBe('top');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('silently no-ops in production with no cookie', async () => {
    const redis = fakeRedis();
    vi.stubEnv('KV_REST_API_URL', 'https://example.com');
    vi.stubEnv('KV_REST_API_TOKEN', 'tok');
    try {
      const res = await handleTelemetryAction(
        request('POST', validBody(), null),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { env: 'production', redis: redis as any },
      );
      expect(res.status).toBe(204);
      // Nothing written — silent no-op so the endpoint doesn't
      // advertise that an auth cookie unlocks more behavior.
      expect(redis.pushed).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('writes to telemetry:user:<username> in preview when a cookie is present', async () => {
    const redis = fakeRedis();
    vi.stubEnv('KV_REST_API_URL', 'https://example.com');
    vi.stubEnv('KV_REST_API_TOKEN', 'tok');
    try {
      const res = await handleTelemetryAction(
        request('POST', validBody()),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { env: 'preview', redis: redis as any },
      );
      expect(res.status).toBe(204);
      expect(redis.pushed[0].key).toBe('telemetry:user:mikelward');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('writes to telemetry:preview:anon in preview without a cookie', async () => {
    const redis = fakeRedis();
    vi.stubEnv('KV_REST_API_URL', 'https://example.com');
    vi.stubEnv('KV_REST_API_TOKEN', 'tok');
    try {
      const res = await handleTelemetryAction(
        request('POST', validBody(), null),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { env: 'preview', redis: redis as any },
      );
      expect(res.status).toBe(204);
      expect(redis.pushed[0].key).toBe('telemetry:preview:anon');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses with 503 in development', async () => {
    const redis = fakeRedis();
    vi.stubEnv('KV_REST_API_URL', 'https://example.com');
    vi.stubEnv('KV_REST_API_TOKEN', 'tok');
    try {
      const res = await handleTelemetryAction(
        request('POST', validBody()),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { env: 'development', redis: redis as any },
      );
      expect(res.status).toBe(503);
      expect(redis.pushed).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('returns 503 when Redis credentials are unset', async () => {
    // Don't stub the creds — let `hasRedisCredentials()` see them
    // missing.
    const res = await handleTelemetryAction(
      request('POST', validBody()),
      { env: 'production' },
    );
    expect(res.status).toBe(503);
  });

  it.each([
    ['action', { action: 'flag' }],
    ['id', { id: 'twelve' }],
    ['id zero', { id: 0 }],
    ['score', { score: 'lots' }],
    ['time', { time: null }],
    ['isHot', { isHot: 'true' }],
    ['sourceFeed empty', { sourceFeed: '' }],
    ['sourceFeed too long', { sourceFeed: 'x'.repeat(64) }],
    ['eventTime', { eventTime: -1 }],
  ])('rejects body with bad %s', async (_label, override) => {
    const redis = fakeRedis();
    vi.stubEnv('KV_REST_API_URL', 'https://example.com');
    vi.stubEnv('KV_REST_API_TOKEN', 'tok');
    try {
      const res = await handleTelemetryAction(
        request('POST', validBody(override)),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { env: 'production', redis: redis as any },
      );
      expect(res.status).toBe(400);
      expect(redis.pushed).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('returns 400 for non-JSON body', async () => {
    const headers = new Headers();
    headers.set('cookie', COOKIE);
    headers.set('content-type', 'application/json');
    const req = new Request('https://newshacker.app/api/admin-telemetry-action', {
      method: 'POST',
      headers,
      body: 'not json',
    });
    vi.stubEnv('KV_REST_API_URL', 'https://example.com');
    vi.stubEnv('KV_REST_API_TOKEN', 'tok');
    try {
      const res = await handleTelemetryAction(req, {
        env: 'production',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        redis: fakeRedis() as any,
      });
      expect(res.status).toBe(400);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('returns 503 when Redis throws on write', async () => {
    const redis = fakeRedis({ failPush: true });
    vi.stubEnv('KV_REST_API_URL', 'https://example.com');
    vi.stubEnv('KV_REST_API_TOKEN', 'tok');
    try {
      const res = await handleTelemetryAction(
        request('POST', validBody()),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { env: 'production', redis: redis as any },
      );
      expect(res.status).toBe(503);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
