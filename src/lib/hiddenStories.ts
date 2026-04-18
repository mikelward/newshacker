const STORAGE_KEY = 'newshacker:hiddenStoryIds';
export const HIDDEN_STORIES_CHANGE_EVENT = 'newshacker:hiddenStoriesChanged';
export const HIDDEN_STORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface HiddenEntry {
  id: number;
  at: number;
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function isEntry(x: unknown): x is HiddenEntry {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as HiddenEntry).id === 'number' &&
    typeof (x as HiddenEntry).at === 'number'
  );
}

function readEntries(now: number): HiddenEntry[] {
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
  const cutoff = now - HIDDEN_STORY_TTL_MS;
  return parsed.filter(isEntry).filter((e) => e.at >= cutoff);
}

function writeEntries(entries: HiddenEntry[]): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // quota or privacy-mode failures are non-fatal
  }
  window.dispatchEvent(new CustomEvent(HIDDEN_STORIES_CHANGE_EVENT));
}

export function getHiddenIds(now: number = Date.now()): Set<number> {
  return new Set(readEntries(now).map((e) => e.id));
}

export function addHiddenId(id: number, now: number = Date.now()): void {
  const entries = readEntries(now).filter((e) => e.id !== id);
  entries.push({ id, at: now });
  writeEntries(entries);
}

export function removeHiddenId(id: number, now: number = Date.now()): void {
  const before = readEntries(now);
  const after = before.filter((e) => e.id !== id);
  if (after.length === before.length) return;
  writeEntries(after);
}

export function clearHiddenIds(): void {
  writeEntries([]);
}
