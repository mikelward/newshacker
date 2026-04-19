const STORAGE_KEY = 'hnews:favoriteStoryIds';
export const FAVORITES_CHANGE_EVENT = 'hnews:favoritesChanged';

interface FavoriteEntry {
  id: number;
  at: number;
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function isEntry(x: unknown): x is FavoriteEntry {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as FavoriteEntry).id === 'number' &&
    typeof (x as FavoriteEntry).at === 'number'
  );
}

function readEntries(): FavoriteEntry[] {
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
  return parsed.filter(isEntry);
}

function writeEntries(entries: FavoriteEntry[]): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // quota or privacy-mode failures are non-fatal
  }
  window.dispatchEvent(new CustomEvent(FAVORITES_CHANGE_EVENT));
}

export function getFavoriteIds(): Set<number> {
  return new Set(readEntries().map((e) => e.id));
}

export function getFavoriteEntries(): Array<{ id: number; at: number }> {
  return readEntries().map((e) => ({ ...e }));
}

export function addFavoriteId(id: number, now: number = Date.now()): void {
  const entries = readEntries().filter((e) => e.id !== id);
  entries.push({ id, at: now });
  writeEntries(entries);
}

export function removeFavoriteId(id: number): void {
  const before = readEntries();
  const after = before.filter((e) => e.id !== id);
  if (after.length === before.length) return;
  writeEntries(after);
}

export function clearFavoriteIds(): void {
  writeEntries([]);
}
