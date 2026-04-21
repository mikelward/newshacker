const STORAGE_KEY = 'newshacker:doneStoryIds';
export const DONE_STORIES_CHANGE_EVENT = 'newshacker:doneStoriesChanged';

// Permanent store matching favorites/pinned. Done is the user's
// completion log — "I engaged with this thread and I'm finished" — and
// is meant to survive across sessions and devices. Tombstones keep
// cross-device sync honest the same way they do for Pinned and
// Favorite; see src/lib/pinnedStories.ts for the full rationale.
//
// TODO(retention): consider a TTL for entries and tombstones. See
// TODO.md § "Retention policy".
export interface DoneEntry {
  id: number;
  at: number;
  deleted?: true;
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function isEntry(x: unknown): x is DoneEntry {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  if (typeof e.id !== 'number') return false;
  if (typeof e.at !== 'number') return false;
  if ('deleted' in e && e.deleted !== true && e.deleted !== undefined) {
    return false;
  }
  return true;
}

function readRaw(): DoneEntry[] {
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
  const out: DoneEntry[] = [];
  for (const raw of parsed) {
    if (!isEntry(raw)) continue;
    const entry: DoneEntry = { id: raw.id, at: raw.at };
    if (raw.deleted === true) entry.deleted = true;
    out.push(entry);
  }
  return out;
}

function writeRaw(entries: DoneEntry[]): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // quota or privacy-mode failures are non-fatal
  }
  window.dispatchEvent(new CustomEvent(DONE_STORIES_CHANGE_EVENT));
}

export function getDoneIds(): Set<number> {
  return new Set(
    readRaw()
      .filter((e) => !e.deleted)
      .map((e) => e.id),
  );
}

export function getDoneEntries(): Array<{ id: number; at: number }> {
  return readRaw()
    .filter((e) => !e.deleted)
    .map((e) => ({ id: e.id, at: e.at }));
}

export function getAllDoneEntries(): DoneEntry[] {
  return readRaw().map((e) => ({ ...e }));
}

export function addDoneId(id: number, now: number = Date.now()): void {
  const entries = readRaw().filter((e) => e.id !== id);
  entries.push({ id, at: now });
  writeRaw(entries);
}

export function removeDoneId(id: number, now: number = Date.now()): void {
  const before = readRaw();
  const existing = before.find((e) => e.id === id);
  if (existing && existing.deleted) return;
  const after = before.filter((e) => e.id !== id);
  after.push({ id, at: now, deleted: true });
  writeRaw(after);
}

export function clearDoneIds(): void {
  writeRaw([]);
}

export function replaceDoneEntries(entries: DoneEntry[]): void {
  writeRaw(entries.map((e) => ({ ...e })));
}
