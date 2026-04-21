const STORAGE_KEY = 'newshacker:favoriteStoryIds';
export const FAVORITES_CHANGE_EVENT = 'newshacker:favoritesChanged';

// See src/lib/pinnedStories.ts for the tombstone rationale — same
// shape and reasoning applies here.
export interface FavoriteEntry {
  id: number;
  at: number;
  deleted?: true;
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function isEntry(x: unknown): x is FavoriteEntry {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  if (typeof e.id !== 'number') return false;
  if (typeof e.at !== 'number') return false;
  if ('deleted' in e && e.deleted !== true && e.deleted !== undefined) {
    return false;
  }
  return true;
}

function readRaw(): FavoriteEntry[] {
  if (!hasWindow()) return [];
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: FavoriteEntry[] = [];
  for (const raw of parsed) {
    if (!isEntry(raw)) continue;
    const entry: FavoriteEntry = { id: raw.id, at: raw.at };
    if (raw.deleted === true) entry.deleted = true;
    out.push(entry);
  }
  return out;
}

function writeRaw(entries: FavoriteEntry[]): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // quota or privacy-mode failures are non-fatal
  }
  window.dispatchEvent(new CustomEvent(FAVORITES_CHANGE_EVENT));
}

export function getFavoriteIds(): Set<number> {
  return new Set(
    readRaw()
      .filter((e) => !e.deleted)
      .map((e) => e.id),
  );
}

export function getFavoriteEntries(): Array<{ id: number; at: number }> {
  return readRaw()
    .filter((e) => !e.deleted)
    .map((e) => ({ id: e.id, at: e.at }));
}

export function getAllFavoriteEntries(): FavoriteEntry[] {
  return readRaw().map((e) => ({ ...e }));
}

export function addFavoriteId(id: number, now: number = Date.now()): void {
  const entries = readRaw().filter((e) => e.id !== id);
  entries.push({ id, at: now });
  writeRaw(entries);
}

export function removeFavoriteId(id: number, now: number = Date.now()): void {
  const before = readRaw();
  const existing = before.find((e) => e.id === id);
  if (existing && existing.deleted) return;
  const after = before.filter((e) => e.id !== id);
  after.push({ id, at: now, deleted: true });
  writeRaw(after);
}

export function clearFavoriteIds(): void {
  writeRaw([]);
}

export function replaceFavoriteEntries(entries: FavoriteEntry[]): void {
  writeRaw(entries.map((e) => ({ ...e })));
}
