const STORAGE_KEY = 'hnews:pinnedStoryIds';
export const PINNED_STORIES_CHANGE_EVENT = 'hnews:pinnedStoriesChanged';

interface PinnedEntry {
  id: number;
  at: number;
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function isEntry(x: unknown): x is PinnedEntry {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as PinnedEntry).id === 'number' &&
    typeof (x as PinnedEntry).at === 'number'
  );
}

function readEntries(): PinnedEntry[] {
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

function writeEntries(entries: PinnedEntry[]): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // quota or privacy-mode failures are non-fatal
  }
  window.dispatchEvent(new CustomEvent(PINNED_STORIES_CHANGE_EVENT));
}

export function getPinnedIds(): Set<number> {
  return new Set(readEntries().map((e) => e.id));
}

export function getPinnedEntries(): Array<{ id: number; at: number }> {
  return readEntries().map((e) => ({ ...e }));
}

export function addPinnedId(id: number, now: number = Date.now()): void {
  const entries = readEntries().filter((e) => e.id !== id);
  entries.push({ id, at: now });
  writeEntries(entries);
}

export function removePinnedId(id: number): void {
  const before = readEntries();
  const after = before.filter((e) => e.id !== id);
  if (after.length === before.length) return;
  writeEntries(after);
}

export function clearPinnedIds(): void {
  writeEntries([]);
}
