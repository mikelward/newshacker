// GET    /api/connect-token — list the current user's app tokens (redacted:
//        id + label + last4 + createdAt only, never the secret or its hash).
// POST   /api/connect-token — mint a new app token for the current user and
//        return it ONCE (`{ token, ...redacted }`). The raw token is never
//        retrievable again; only its SHA-256 hash is stored.
// DELETE /api/connect-token — revoke one token by `{ id }`.
//
// App tokens let a trusted first-party companion app (Readmo) act as the
// signed-in HN user against `/api/sync` server-to-server, without a browser
// cookie in the loop (SameSite/ITP make the cross-site cookie unreliable). The
// token is a bearer credential scoped to the same data the cookie already
// reaches — the user's Pinned/Favorite/Hidden/Done sync lists — so minting one
// is gated on exactly the auth `/api/sync` itself uses: the presence of a valid
// `hn_session` cookie is taken as proof of intent (same stance as api/me.ts and
// api/sync.ts; we don't re-round-trip to HN here). This is the B2 ("paste a
// token") design; see SPEC § "Connecting a companion app". A future B3
// (OAuth-style authorize handshake) would issue tokens through this same store,
// so the sync-side bearer branch and Redis layout below are the durable half.
//
// Vercel note: helpers are inlined (not imported from a sibling api/* file or
// src/) because Vercel's bundler drops cross-file imports at deploy time — see
// api/imports.test.ts and the file header in api/summary.ts. The token-hashing
// and Redis-key logic is duplicated in api/sync.ts's bearer branch on purpose.

import { Redis } from '@upstash/redis';

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'hn_session';
const HN_USERNAME_RE = /^[a-zA-Z0-9_-]{2,32}$/;

// `apptoken:<sha256hex>` → username (the O(1) lookup /api/sync does on auth).
const TOKEN_KEY_PREFIX = 'newshacker:apptoken:';
// `apptokens:<username>` → JSON array of TokenRecord (the per-user list the
// settings UI shows and revokes from).
const USER_TOKENS_KEY_PREFIX = 'newshacker:apptokens:';

// A generous ceiling so a rogue client can't grow one user's token list without
// bound. Real users need one or two (one per companion app).
const MAX_TOKENS_PER_USER = 20;

// Token wire format: `nht_` (newshacker token) + 43 base64url chars = 32 random
// bytes. Prefix makes an accidental leak greppable and lets the client validate
// shape before sending.
const TOKEN_PREFIX = 'nht_';
const TOKEN_RANDOM_BYTES = 32;

/** A stored token, redacted of its secret. `hash` is server-only (it's the
 * SHA-256 of the raw token, useless to replay) and is stripped before any
 * response — only {@link redact} shapes leave the handler. */
export interface TokenRecord {
  id: string;
  label: string;
  /** Last 4 chars of the raw token, so the user can tell two tokens apart. */
  last4: string;
  createdAt: number;
  /** SHA-256 hex of the raw token. Server-only; never serialized to a client. */
  hash: string;
}

/** The client-safe shape of a token — everything but the reversible-looking
 * `hash` (which it isn't, but we still never ship it). */
export type RedactedToken = Omit<TokenRecord, 'hash'>;

export function redact(rec: TokenRecord): RedactedToken {
  const { hash: _hash, ...rest } = rec;
  return rest;
}

/** Storage seam so tests can inject an in-memory map instead of Redis. */
export interface TokenStore {
  /** Username a raw-token hash maps to, or null if unknown/revoked. */
  usernameForHash(hash: string): Promise<string | null>;
  listForUser(username: string): Promise<TokenRecord[]>;
  /** Persist a new token: writes the hash→username lookup AND appends to the
   * user's list. */
  add(username: string, rec: TokenRecord): Promise<void>;
  /** Remove a token by id: deletes the hash→username lookup AND drops it from
   * the user's list. Returns the removed record, or null if no such id. */
  remove(username: string, id: string): Promise<TokenRecord | null>;
}

// --- inlined helpers (see file header: no cross-file imports on Vercel) -----

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

/** SHA-256 hex of a string, via Web Crypto (global on Vercel Node 18+ and in
 * the vitest node environment). Exported so the sync-side bearer branch and the
 * tests hash identically. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mint a fresh opaque token. Not exported as a secret source — the handler
 * hashes it before storage and returns the raw value to the caller exactly
 * once. */
function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  return TOKEN_PREFIX + base64url(bytes);
}

/** Clamp/normalize a user-supplied label to a short single line, defaulting to
 * a stable placeholder. Never trusted for anything but display. */
function normalizeLabel(value: unknown): string {
  if (typeof value !== 'string') return 'Companion app';
  const cleaned = value.replace(/\s+/g, ' ').trim().slice(0, 60);
  return cleaned || 'Companion app';
}

// --- Redis-backed default store --------------------------------------------

let defaultStore: TokenStore | null | undefined;

function createDefaultStore(): TokenStore | null {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const redis = new Redis({ url, token });
  const userKey = (username: string) => `${USER_TOKENS_KEY_PREFIX}${username}`;

  // The per-user list is a Redis HASH keyed by token id (not a single JSON
  // blob). Field-level HSET/HDEL means two concurrent creates for the same user
  // write DISTINCT fields and can't clobber each other — the read-modify-write
  // race a JSON-array-in-one-key would have, where the later writer's list
  // overwrites the earlier's yet both `apptoken:<hash>` lookups persist, leaving
  // a token valid for /api/sync but unlisted and unrevocable.
  async function readList(username: string): Promise<TokenRecord[]> {
    const map = await redis.hgetall<Record<string, unknown>>(userKey(username));
    if (!map) return [];
    const out: TokenRecord[] = [];
    for (const value of Object.values(map)) {
      // Upstash may hand back the stored JSON already parsed, or as a string.
      const parsed = typeof value === 'string' ? safeParse(value) : value;
      if (isTokenRecord(parsed)) out.push(parsed);
    }
    // Deterministic order for the UI (oldest first).
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }

  return {
    async usernameForHash(hash) {
      const u = await redis.get<unknown>(`${TOKEN_KEY_PREFIX}${hash}`);
      return typeof u === 'string' && HN_USERNAME_RE.test(u) ? u : null;
    },
    listForUser: readList,
    async add(username, rec) {
      // Write the list entry BEFORE the hash lookup, so a token is never
      // usable-but-unlisted (which would make it unrevocable). HSET of a fresh
      // id can't collide with a concurrent add of a different id.
      await redis.hset(userKey(username), { [rec.id]: JSON.stringify(rec) });
      await redis.set(`${TOKEN_KEY_PREFIX}${rec.hash}`, username);
    },
    async remove(username, id) {
      const raw = await redis.hget<unknown>(userKey(username), id);
      const rec = typeof raw === 'string' ? safeParse(raw) : raw;
      if (!isTokenRecord(rec)) return null;
      // Delete the access-granting hash lookup FIRST, then unlist. If the second
      // write fails, the token is already disabled for /api/sync (fail-safe) and
      // still listed, so the user can retry the revoke (a re-run DELs a
      // now-absent key harmlessly and completes the HDEL). The reverse order
      // could leave a token unlisted-but-still-valid with no id to retry with.
      await redis.del(`${TOKEN_KEY_PREFIX}${rec.hash}`);
      await redis.hdel(userKey(username), id);
      return rec;
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

function isTokenRecord(x: unknown): x is TokenRecord {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.label === 'string' &&
    typeof r.last4 === 'string' &&
    typeof r.createdAt === 'number' &&
    typeof r.hash === 'string'
  );
}

function getDefaultStore(): TokenStore | null {
  if (defaultStore === undefined) defaultStore = createDefaultStore();
  return defaultStore;
}

function authenticate(request: Request): string | null {
  const cookies = parseCookieHeader(request.headers.get('cookie'));
  return usernameFromSessionValue(cookies[SESSION_COOKIE_NAME]);
}

export interface ConnectTokenDeps {
  // `null` = explicitly disable the store (tests that assert 503); `undefined` =
  // use the lazily-initialised Upstash default.
  store?: TokenStore | null;
  // Injectable clock so tests get deterministic `createdAt`.
  now?: () => number;
}

export async function handleConnectTokenRequest(
  request: Request,
  deps: ConnectTokenDeps = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const username = authenticate(request);
  if (!username) return json({ error: 'Not authenticated' }, 401);

  const store = deps.store === undefined ? getDefaultStore() : deps.store;
  if (!store) return json({ error: 'App tokens are not configured' }, 503);
  const now = deps.now ?? Date.now;

  if (method === 'GET') {
    let list: TokenRecord[];
    try {
      list = await store.listForUser(username);
    } catch {
      return json({ error: 'Token store unavailable' }, 503);
    }
    return json({ tokens: list.map(redact) });
  }

  if (method === 'DELETE') {
    let body: unknown;
    try {
      const text = await request.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }
    const id =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).id
        : undefined;
    if (typeof id !== 'string' || !id) {
      return json({ error: 'Missing token id' }, 400);
    }
    let removed: TokenRecord | null;
    try {
      removed = await store.remove(username, id);
    } catch {
      return json({ error: 'Token store unavailable' }, 503);
    }
    if (!removed) return json({ error: 'No such token' }, 404);
    return json({ ok: true });
  }

  // POST — mint a new token.
  let label = 'Companion app';
  try {
    const text = await request.text();
    if (text) label = normalizeLabel((JSON.parse(text) as Record<string, unknown>)?.label);
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  let existing: TokenRecord[];
  try {
    existing = await store.listForUser(username);
  } catch {
    return json({ error: 'Token store unavailable' }, 503);
  }
  if (existing.length >= MAX_TOKENS_PER_USER) {
    return json({ error: 'Too many tokens; revoke one first' }, 409);
  }

  const raw = generateToken();
  const hash = await sha256Hex(raw);
  const rec: TokenRecord = {
    id: crypto.randomUUID(),
    label,
    last4: raw.slice(-4),
    createdAt: now(),
    hash,
  };
  try {
    await store.add(username, rec);
  } catch {
    return json({ error: 'Token store unavailable' }, 503);
  }
  // The ONLY time the raw token is ever returned.
  return json({ token: raw, ...redact(rec) }, 201);
}

export async function GET(request: Request): Promise<Response> {
  return handleConnectTokenRequest(request);
}
export async function POST(request: Request): Promise<Response> {
  return handleConnectTokenRequest(request);
}
export async function DELETE(request: Request): Promise<Response> {
  return handleConnectTokenRequest(request);
}

// No `default` export — see the note in api/sync.ts: Vercel invokes a default
// export as a Node `(req, res)` handler, which would break the Fetch `Request`
// this expects. Named GET/POST/DELETE route through the Web-standard path.

export const _internals = {
  MAX_TOKENS_PER_USER,
  TOKEN_PREFIX,
  generateToken,
  normalizeLabel,
};
