const STORAGE_KEY = 'hnews:dismissedStoryIds';
export const DISMISSED_STORIES_CHANGE_EVENT =
  'hnews:dismissedStoriesChanged';
export const DISMISSED_STORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface DismissedEntry {
  id: number;
  at: number;
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function isEntry(x: unknown): x is DismissedEntry {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as DismissedEntry).id === 'number' &&
    typeof (x as DismissedEntry).at === 'number'
  );
}

function readEntries(now: number): DismissedEntry[] {
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
  const cutoff = now - DISMISSED_STORY_TTL_MS;
  return parsed.filter(isEntry).filter((e) => e.at >= cutoff);
}

function writeEntries(entries: DismissedEntry[]): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // quota or privacy-mode failures are non-fatal
  }
  window.dispatchEvent(new CustomEvent(DISMISSED_STORIES_CHANGE_EVENT));
}

export function getDismissedIds(now: number = Date.now()): Set<number> {
  return new Set(readEntries(now).map((e) => e.id));
}

export function getDismissedEntries(
  now: number = Date.now(),
): Array<{ id: number; at: number }> {
  return readEntries(now).map((e) => ({ ...e }));
}

export function addDismissedId(id: number, now: number = Date.now()): void {
  const entries = readEntries(now).filter((e) => e.id !== id);
  entries.push({ id, at: now });
  writeEntries(entries);
}

export function removeDismissedId(id: number, now: number = Date.now()): void {
  const before = readEntries(now);
  const after = before.filter((e) => e.id !== id);
  if (after.length === before.length) return;
  writeEntries(after);
}

export function clearDismissedIds(): void {
  writeEntries([]);
}
