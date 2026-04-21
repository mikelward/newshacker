import { Redis } from '@upstash/redis';

// Development / operator visibility endpoint. Reports which third-party
// services the deployment has credentials for (by env var presence),
// whether the Redis cache is actually reachable, and what region +
// build SHA the function is running on. Intentionally public — the
// repo is open source so the set of env var names is public anyway.
// The endpoint reports booleans and latency, never the env var values
// themselves; the "no leaks" test in `status.test.ts` is a regression
// guard for that. See `/debug` for the UI that renders this.

export interface ServiceStatus {
  configured: boolean;
  reachable?: boolean;
  latencyMs?: number;
}

export interface StatusResponse {
  region: string | null;
  build: string | null;
  services: {
    gemini: ServiceStatus;
    jina: ServiceStatus;
    redis: ServiceStatus;
    // Cross-device sync. Reuses the same Redis backend as the summary
    // caches, so sync is considered configured iff Redis credentials
    // are present, and reachable iff the Redis ping succeeds. Reported
    // separately from `redis` so the /debug UI can make the
    // "sync will work" signal obvious instead of leaving it implicit.
    sync: ServiceStatus;
  };
}

export interface StatusDeps {
  pingRedis?: () =>
    | Promise<{ ok: true; latencyMs: number } | { ok: false }>
    | { ok: true; latencyMs: number }
    | { ok: false };
  now?: () => number;
}

function hasRedisCredentials(): boolean {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return Boolean(url && token);
}

async function defaultPingRedis(
  now: () => number,
): Promise<{ ok: true; latencyMs: number } | { ok: false }> {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { ok: false };
  try {
    const redis = new Redis({ url, token });
    const start = now();
    await redis.ping();
    return { ok: true, latencyMs: now() - start };
  } catch {
    return { ok: false };
  }
}

export async function handleStatusRequest(
  _request: Request,
  deps: StatusDeps = {},
): Promise<Response> {
  const now = deps.now ?? Date.now;

  let redis: ServiceStatus;
  if (!hasRedisCredentials()) {
    redis = { configured: false };
  } else {
    const pingFn = deps.pingRedis ?? (() => defaultPingRedis(now));
    try {
      const result = await pingFn();
      redis = result.ok
        ? { configured: true, reachable: true, latencyMs: result.latencyMs }
        : { configured: true, reachable: false };
    } catch {
      redis = { configured: true, reachable: false };
    }
  }

  const body: StatusResponse = {
    region: process.env.VERCEL_REGION ?? null,
    build: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    services: {
      gemini: { configured: Boolean(process.env.GOOGLE_API_KEY) },
      jina: { configured: Boolean(process.env.JINA_API_KEY) },
      redis,
      sync: { ...redis },
    },
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // This is live state; caching it defeats the purpose.
      'cache-control': 'private, no-store',
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  return handleStatusRequest(request);
}
