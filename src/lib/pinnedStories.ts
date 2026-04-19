const STORAGE_KEY = 'newshacker:pinnedStoryIds';
const LEGACY_SAVED_KEY = 'newshacker:savedStoryIds';
export const PINNED_STORIES_CHANGE_EVENT = 'newshacker:pinnedStoriesChanged';

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

// One-shot rename of the legacy `savedStoryIds` key to `pinnedStoryIds` so
// existing readers don't lose their list when we rename "Saved" to "Pinned".
// Cheap (one localStorage get when there's nothing to migrate) and self-erasing.
function migrateLegacyKey(): void {
  if (!hasWindow()) return;
  try {
    if (window.localStorage.getItem(STORAGE_KEY) !== null) return;
    const legacy = window.localStorage.getItem(LEGACY_SAVED_KEY);
    if (legacy === null) return;
    window.localStorage.setItem(STORAGE_KEY, legacy);
    window.localStorage.removeItem(LEGACY_SAVED_KEY);
  } catch {
    // ignore storage failures; reads return [] in that case.
  }
}

function readEntries(): PinnedEntry[] {
  if (!hasWindow()) return [];
  migrateLegacyKey();
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
