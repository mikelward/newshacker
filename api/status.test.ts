import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { handleStatusRequest, type StatusResponse } from './status';

function makeRequest() {
  return new Request('https://newshacker.app/api/status');
}

async function readBody(res: Response): Promise<StatusResponse> {
  return (await res.json()) as StatusResponse;
}

describe('handleStatusRequest', () => {
  const envSnapshot: Record<string, string | undefined> = {};
  const envKeys = [
    'GOOGLE_API_KEY',
    'JINA_API_KEY',
    'KV_REST_API_URL',
    'KV_REST_API_TOKEN',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'VERCEL_REGION',
    'VERCEL_GIT_COMMIT_SHA',
  ];

  beforeEach(() => {
    for (const k of envKeys) {
      envSnapshot[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of envKeys) {
      if (envSnapshot[k] === undefined) delete process.env[k];
      else process.env[k] = envSnapshot[k];
    }
  });

  it('returns a 200 JSON response with no-store cache control', async () => {
    const res = await handleStatusRequest(makeRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
  });

  it('reports nothing configured when no env vars are set', async () => {
    const res = await handleStatusRequest(makeRequest());
    const body = await readBody(res);
    expect(body.region).toBeNull();
    expect(body.build).toBeNull();
    expect(body.services.gemini).toEqual({ configured: false });
    expect(body.services.jina).toEqual({ configured: false });
    expect(body.services.redis).toEqual({ configured: false });
  });

  it('reports gemini and jina as configured when their keys are set', async () => {
    process.env.GOOGLE_API_KEY = 'x';
    process.env.JINA_API_KEY = 'y';
    const body = await readBody(await handleStatusRequest(makeRequest()));
    expect(body.services.gemini).toEqual({ configured: true });
    expect(body.services.jina).toEqual({ configured: true });
  });

  it('reports the Vercel region and build SHA when present', async () => {
    process.env.VERCEL_REGION = 'iad1';
    process.env.VERCEL_GIT_COMMIT_SHA = 'abc123';
    const body = await readBody(await handleStatusRequest(makeRequest()));
    expect(body.region).toBe('iad1');
    expect(body.build).toBe('abc123');
  });

  it('pings Redis and reports latency when credentials are set and reachable', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'tok';
    const pingRedis = vi.fn(async () => ({ ok: true as const, latencyMs: 7 }));
    const res = await handleStatusRequest(makeRequest(), { pingRedis });
    const body = await readBody(res);
    expect(body.services.redis).toEqual({
      configured: true,
      reachable: true,
      latencyMs: 7,
    });
    expect(pingRedis).toHaveBeenCalledTimes(1);
  });

  it('reports redis as configured-but-unreachable when the ping fails', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'tok';
    const pingRedis = vi.fn(async () => ({ ok: false as const }));
    const body = await readBody(
      await handleStatusRequest(makeRequest(), { pingRedis }),
    );
    expect(body.services.redis).toEqual({
      configured: true,
      reachable: false,
    });
  });

  it('treats an unexpected throw from pingRedis as unreachable, not a 500', async () => {
    // Defense-in-depth: the status endpoint must not itself go down
    // because the ping path threw.
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'tok';
    const pingRedis = vi.fn(async () => {
      throw new Error('network');
    });
    const res = await handleStatusRequest(makeRequest(), { pingRedis });
    expect(res.status).toBe(200);
    const body = await readBody(res);
    expect(body.services.redis).toEqual({
      configured: true,
      reachable: false,
    });
  });

  it('skips the ping entirely when Redis credentials are absent', async () => {
    const pingRedis = vi.fn(async () => ({ ok: true as const, latencyMs: 1 }));
    const body = await readBody(
      await handleStatusRequest(makeRequest(), { pingRedis }),
    );
    expect(body.services.redis).toEqual({ configured: false });
    expect(pingRedis).not.toHaveBeenCalled();
  });

  it('also accepts the UPSTASH_REDIS_REST_* env var pair', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
    const pingRedis = vi.fn(async () => ({ ok: true as const, latencyMs: 3 }));
    const body = await readBody(
      await handleStatusRequest(makeRequest(), { pingRedis }),
    );
    expect(body.services.redis).toMatchObject({ configured: true });
    expect(pingRedis).toHaveBeenCalledTimes(1);
  });

  it('does not leak env var values in the response', async () => {
    // Guard against regressions that might surface tokens/URLs in the
    // body. A public endpoint must never echo credentials, even if the
    // caller is already on the allowlist (this one isn't).
    process.env.GOOGLE_API_KEY = 'super-secret-gemini-key';
    process.env.JINA_API_KEY = 'super-secret-jina-key';
    process.env.KV_REST_API_URL = 'https://secret-host.upstash.io';
    process.env.KV_REST_API_TOKEN = 'super-secret-kv-token';
    const pingRedis = vi.fn(async () => ({ ok: true as const, latencyMs: 1 }));
    const res = await handleStatusRequest(makeRequest(), { pingRedis });
    const text = await res.text();
    expect(text).not.toContain('super-secret-gemini-key');
    expect(text).not.toContain('super-secret-jina-key');
    expect(text).not.toContain('super-secret-kv-token');
    expect(text).not.toContain('secret-host.upstash.io');
  });
});
