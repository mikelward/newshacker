const STORAGE_KEY = 'newshacker:savedStoryIds';
export const SAVED_STORIES_CHANGE_EVENT = 'newshacker:savedStoriesChanged';

interface SavedEntry {
  id: number;
  at: number;
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function isEntry(x: unknown): x is SavedEntry {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as SavedEntry).id === 'number' &&
    typeof (x as SavedEntry).at === 'number'
  );
}

function readEntries(): SavedEntry[] {
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

function writeEntries(entries: SavedEntry[]): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // quota or privacy-mode failures are non-fatal
  }
  window.dispatchEvent(new CustomEvent(SAVED_STORIES_CHANGE_EVENT));
}

export function getSavedIds(): Set<number> {
  return new Set(readEntries().map((e) => e.id));
}

export function getSavedEntries(): Array<{ id: number; at: number }> {
  return readEntries().map((e) => ({ ...e }));
}

export function addSavedId(id: number, now: number = Date.now()): void {
  const entries = readEntries().filter((e) => e.id !== id);
  entries.push({ id, at: now });
  writeEntries(entries);
}

export function removeSavedId(id: number): void {
  const before = readEntries();
  const after = before.filter((e) => e.id !== id);
  if (after.length === before.length) return;
  writeEntries(after);
}

export function clearSavedIds(): void {
  writeEntries([]);
}
