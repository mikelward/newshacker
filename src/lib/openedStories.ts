const STORAGE_KEY = 'newshacker:openedStoryIds';
export const OPENED_STORIES_CHANGE_EVENT =
  'newshacker:openedStoriesChanged';
export const OPENED_STORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface OpenedEntry {
  id: number;
  at: number;
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function isEntry(x: unknown): x is OpenedEntry {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as OpenedEntry).id === 'number' &&
    typeof (x as OpenedEntry).at === 'number'
  );
}

function readEntries(now: number): OpenedEntry[] {
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
  const cutoff = now - OPENED_STORY_TTL_MS;
  return parsed.filter(isEntry).filter((e) => e.at >= cutoff);
}

function writeEntries(entries: OpenedEntry[]): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // quota or privacy-mode failures are non-fatal
  }
  window.dispatchEvent(new CustomEvent(OPENED_STORIES_CHANGE_EVENT));
}

export function getOpenedIds(now: number = Date.now()): Set<number> {
  return new Set(readEntries(now).map((e) => e.id));
}

export function getOpenedEntries(
  now: number = Date.now(),
): Array<{ id: number; at: number }> {
  return readEntries(now).map((e) => ({ ...e }));
}

export function addOpenedId(id: number, now: number = Date.now()): void {
  const entries = readEntries(now).filter((e) => e.id !== id);
  entries.push({ id, at: now });
  writeEntries(entries);
}

export function removeOpenedId(id: number, now: number = Date.now()): void {
  const before = readEntries(now);
  const after = before.filter((e) => e.id !== id);
  if (after.length === before.length) return;
  writeEntries(after);
}

export function clearOpenedIds(): void {
  writeEntries([]);
}
