// HN-side favorites sync. Phase A (this file today): pulls the
// signed-in user's favorites list from /api/hn-favorites-list on
// startup and merges IDs into the local favorites store. Phase B
// will extend this singleton with a localStorage-backed queue that
// forwards local favorite/unfavorite actions back to HN.
//
// Merge semantics: HN gives us IDs only, no timestamps, so we treat
// an HN entry as `at: 0`. This means ANY subsequent local write
// (favorite with `at: Date.now()`, or a locally-recorded tombstone)
// wins the per-id last-write-wins race in replaceFavoriteEntries.
// Concretely:
//   - HN has X, local has no record    → add `{ id: X, at: 0 }`.
//   - HN has X, local has live `{X,T}` → keep local (higher `at`).
//   - HN has X, local has tombstone    → keep local tombstone.
//                                         Phase B will push an
//                                         unfavorite to HN to close
//                                         the loop.
//   - HN lacks X, local has anything   → keep local. Phase B will
//                                         push the favorite up.
//
// Fail-open: any error (401, 502, network) is swallowed — local
// favorites keep working unchanged and the next startup retries.

import { trackedFetch } from './networkStatus';
import {
  FavoriteEntry,
  getAllFavoriteEntries,
  replaceFavoriteEntries,
} from './favorites';

export interface HnFavoritesListResponse {
  ids: number[];
  truncated?: boolean;
}

// Pure merge. Exported for testing. Returns a new array; doesn't
// mutate either input.
export function mergeHnFavorites(
  local: FavoriteEntry[],
  hnIds: number[],
): FavoriteEntry[] {
  const byId = new Map<number, FavoriteEntry>();
  for (const e of local) byId.set(e.id, { ...e });
  for (const id of hnIds) {
    if (byId.has(id)) continue;
    byId.set(id, { id, at: 0 });
  }
  return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}

interface Runtime {
  username: string;
  fetchImpl: typeof fetch;
  bootstrapped: boolean;
}

let runtime: Runtime | null = null;

export interface LastBootstrap {
  at: number;
  ok: boolean;
  status?: number;
  idsAdded?: number;
  error?: string;
}

let lastBootstrap: LastBootstrap | null = null;

function isResponse(x: unknown): x is HnFavoritesListResponse {
  if (typeof x !== 'object' || x === null) return false;
  const obj = x as Record<string, unknown>;
  if (!Array.isArray(obj.ids)) return false;
  return obj.ids.every((v) => typeof v === 'number');
}

async function bootstrapPull(): Promise<void> {
  if (!runtime) return;
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await runtime.fetchImpl('/api/hn-favorites-list', { method: 'GET' });
  } catch (e) {
    lastBootstrap = {
      at: startedAt,
      ok: false,
      error: e instanceof Error ? e.message : 'network error',
    };
    return;
  }
  if (!res.ok) {
    lastBootstrap = { at: startedAt, ok: false, status: res.status };
    return;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    lastBootstrap = {
      at: startedAt,
      ok: false,
      status: res.status,
      error: 'invalid-json',
    };
    return;
  }
  if (!isResponse(body)) {
    lastBootstrap = {
      at: startedAt,
      ok: false,
      status: res.status,
      error: 'invalid-shape',
    };
    return;
  }

  const local = getAllFavoriteEntries();
  const merged = mergeHnFavorites(local, body.ids);
  const before = new Set(local.map((e) => e.id));
  const added = merged.filter((e) => !before.has(e.id)).length;

  if (added > 0) replaceFavoriteEntries(merged);
  if (runtime) runtime.bootstrapped = true;

  lastBootstrap = {
    at: startedAt,
    ok: true,
    status: res.status,
    idsAdded: added,
  };
}

export interface StartOptions {
  fetchImpl?: typeof fetch;
}

export async function startHnFavoritesSync(
  username: string,
  opts: StartOptions = {},
): Promise<void> {
  if (runtime && runtime.username === username) return;
  stopHnFavoritesSync();
  runtime = {
    username,
    fetchImpl: opts.fetchImpl ?? trackedFetch,
    bootstrapped: false,
  };
  await bootstrapPull();
}

export function stopHnFavoritesSync(): void {
  runtime = null;
}

export function getHnFavoritesSyncDebug(): {
  running: boolean;
  username: string | null;
  bootstrapped: boolean;
  lastBootstrap: LastBootstrap | null;
} {
  return {
    running: runtime !== null,
    username: runtime?.username ?? null,
    bootstrapped: runtime?.bootstrapped ?? false,
    lastBootstrap,
  };
}

// Test-only reset so cases don't leak state into each other.
export function _resetHnFavoritesSyncForTests(): void {
  runtime = null;
  lastBootstrap = null;
}
