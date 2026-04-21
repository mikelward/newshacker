// GET  /api/sync — returns the current user's synced pinned / favorite /
// hidden / done lists from Redis. 401 if the hn_session cookie is missing.
// POST /api/sync — accepts a delta `{ pinned?, favorite?, hidden?, done? }`
// where each list is `Array<{ id, at, deleted? }>`. Merges per-id
// last-write-wins into the per-user Redis entry and returns the merged
// state so the client can re-align in one round trip.
//
// Identity is the HN username parsed from the hn_session cookie (the
// same scheme as api/me.ts). We intentionally don't re-validate the
// cookie against news.ycombinator.com — the cookie's presence is taken
// as proof of intent, same as /api/me.

import { Redis } from '@upstash/redis';

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'hn_session';
const HN_USERNAME_RE = /^[a-zA-Z0-9_-]{2,32}$/;

const KV_KEY_PREFIX = 'newshacker:sync:';

// Keep per-list entry counts bounded. Pinned/favorite/hidden/done are all
// human-curated lists — 10k per list is a couple orders of magnitude
// above any realistic user and comfortably within Upstash's 1 MB per
// value free-tier limit (our entries are ~40–60 bytes each, so 10k ≈
// 500 KB worst case).
const MAX_ENTRIES_PER_LIST = 10_000;
// A hard ceiling on request body size to keep a rogue client from
// tying up a function. 256 KiB is generous for even a max-size delta.
const MAX_BODY_BYTES = 256 * 1024;

const LISTS = ['pinned', 'favorite', 'hidden', 'done'] as const;

export interface SyncEntry {
  id: number;
  at: number;
  deleted?: true;
}

export interface SyncState {
  pinned: SyncEntry[];
  favorite: SyncEntry[];
  hidden: SyncEntry[];
  done: SyncEntry[];
}

function emptyState(): SyncState {
  return { pinned: [], favorite: [], hidden: [], done: [] };
}

// Parse a Cookie header into name→value. Duplicated from api/me.ts
// deliberately — Vercel's per-file function bundler has been flaky
// about tracing shared modules outside api/, and the helper is short.
// See IMPLEMENTATION_PLAN.md § 5-infra for the planned consolidation.
function parseCookieHeader(
  header: string | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const raw of header.split(';')) {
    const part = raw.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function usernameFromSessionValue(value: string | undefined): string | null {
  if (!value) return null;
  const amp = value.indexOf('&');
  const candidate = amp === -1 ? value : value.slice(0, amp);
  return HN_USERNAME_RE.test(candidate) ? candidate : null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
    },
  });
}

function isValidEntry(x: unknown): x is SyncEntry {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  if (typeof e.id !== 'number' || !Number.isSafeInteger(e.id) || e.id <= 0) {
    return false;
  }
  if (typeof e.at !== 'number' || !Number.isFinite(e.at) || e.at < 0) {
    return false;
  }
  if ('deleted' in e && e.deleted !== true && e.deleted !== undefined) {
    return false;
  }
  return true;
}

function normalizeList(value: unknown): SyncEntry[] {
  if (!Array.isArray(value)) return [];
  const out: SyncEntry[] = [];
  for (const raw of value) {
    if (!isValidEntry(raw)) continue;
    const entry: SyncEntry = { id: raw.id, at: raw.at };
    if (raw.deleted === true) entry.deleted = true;
    out.push(entry);
  }
  return out;
}

function normalizeState(raw: unknown): SyncState {
  if (typeof raw !== 'object' || raw === null) return emptyState();
  const obj = raw as Record<string, unknown>;
  return {
    pinned: normalizeList(obj.pinned),
    favorite: normalizeList(obj.favorite),
    hidden: normalizeList(obj.hidden),
    done: normalizeList(obj.done),
  };
}

// Per-id last-write-wins merge. The entry with the highest `at` for a
// given id wins, whether it's additive or a tombstone. Ties keep the
// incumbent (so repeated identical pushes are idempotent).
export function mergeEntries(
  current: SyncEntry[],
  incoming: SyncEntry[],
): SyncEntry[] {
  const byId = new Map<number, SyncEntry>();
  for (const e of current) byId.set(e.id, e);
  for (const e of incoming) {
    const existing = byId.get(e.id);
    if (!existing || e.at > existing.at) byId.set(e.id, e);
  }
  return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}

function capList(list: SyncEntry[]): SyncEntry[] {
  if (list.length <= MAX_ENTRIES_PER_LIST) return list;
  // When the cap bites, keep the most recent entries (highest `at`).
  return [...list]
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ENTRIES_PER_LIST)
    .sort((a, b) => a.id - b.id);
}

export interface SyncStore {
  get(username: string): Promise<SyncState>;
  set(username: string, state: SyncState): Promise<void>;
}

let defaultStore: SyncStore | null | undefined;

function createDefaultStore(): SyncStore | null {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const redis = new Redis({ url, token });
  return {
    async get(username) {
      const raw = await redis.get<unknown>(`${KV_KEY_PREFIX}${username}`);
      if (raw == null) return emptyState();
      // Upstash returns JSON as an object when stored via its JS client,
      // and as a string when stored externally — handle both.
      const parsed = typeof raw === 'string' ? safeParse(raw) : raw;
      return normalizeState(parsed);
    },
    async set(username, state) {
      await redis.set(
        `${KV_KEY_PREFIX}${username}`,
        JSON.stringify(state),
      );
    },
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function getDefaultStore(): SyncStore | null {
  if (defaultStore === undefined) defaultStore = createDefaultStore();
  return defaultStore;
}

function authenticate(request: Request): string | null {
  const cookies = parseCookieHeader(request.headers.get('cookie'));
  return usernameFromSessionValue(cookies[SESSION_COOKIE_NAME]);
}

export interface SyncDeps {
  // `null` = explicitly disable the shared store (used by tests); `undefined`
  // = use the lazily-initialised Upstash default.
  store?: SyncStore | null;
}

export async function handleSyncRequest(
  request: Request,
  deps: SyncDeps = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const username = authenticate(request);
  if (!username) return json({ error: 'Not authenticated' }, 401);

  const store = deps.store === undefined ? getDefaultStore() : deps.store;
  if (!store) {
    return json({ error: 'Sync is not configured' }, 503);
  }

  if (method === 'GET') {
    let state: SyncState;
    try {
      state = await store.get(username);
    } catch {
      // Fail-open: a store outage on GET returns empty lists so the
      // client keeps its local state intact. The client won't advance
      // its high-water mark, so pending writes will still be pushed
      // whenever the store recovers.
      return json(emptyState());
    }
    return json(state);
  }

  // POST — parse + validate the body, merge, store, return.
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (contentLength > MAX_BODY_BYTES) {
    return json({ error: 'Body too large' }, 413);
  }
  let rawText: string;
  try {
    rawText = await request.text();
  } catch {
    return json({ error: 'Invalid body' }, 400);
  }
  if (rawText.length > MAX_BODY_BYTES) {
    return json({ error: 'Body too large' }, 413);
  }
  let parsed: unknown;
  try {
    parsed = rawText ? JSON.parse(rawText) : {};
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return json({ error: 'Invalid body shape' }, 400);
  }
  const delta = parsed as Record<string, unknown>;

  let current: SyncState;
  try {
    current = await store.get(username);
  } catch {
    return json({ error: 'Sync store unavailable' }, 503);
  }

  const merged: SyncState = emptyState();
  for (const list of LISTS) {
    const incoming = normalizeList(delta[list]);
    merged[list] = capList(mergeEntries(current[list], incoming));
  }

  try {
    await store.set(username, merged);
  } catch {
    return json({ error: 'Sync store unavailable' }, 503);
  }

  return json(merged);
}

export async function GET(request: Request): Promise<Response> {
  return handleSyncRequest(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleSyncRequest(request);
}

// No `default` export: Vercel's Node runtime invokes a module's default
// export as a Node-style `(req, res) => void` handler, so the Fetch
// `Request` we expect here would arrive as an IncomingMessage and
// `request.headers.get(...)` would throw. Exporting only the named
// GET/POST methods routes this through Vercel's Web-standard handler
// path instead, matching the rest of api/ (api/me.ts, api/login.ts,
// api/logout.ts).

// Test-only exports — kept small and named with an underscore so they're
// obviously not part of the public API.
export const _internals = {
  MAX_ENTRIES_PER_LIST,
  MAX_BODY_BYTES,
  normalizeList,
  normalizeState,
  capList,
};
