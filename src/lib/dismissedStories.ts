const STORAGE_KEY = 'newshacker:dismissedStoryIds';
export const DISMISSED_STORIES_CHANGE_EVENT =
  'newshacker:dismissedStoriesChanged';
export const DISMISSED_STORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// See src/lib/pinnedStories.ts for the tombstone rationale — same
// shape applies here. Both additive entries and tombstones share the
// 7-day TTL: a dismissal older than a week no longer matters to the
// UX (the "recently dismissed" page doesn't show it), and the sync
// layer doesn't need to resurrect-guard against a live copy older
// than a week either.
export interface DismissedEntry {
  id: number;
  at: number;
  deleted?: true;
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function isEntry(x: unknown): x is DismissedEntry {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  if (typeof e.id !== 'number') return false;
  if (typeof e.at !== 'number') return false;
  if ('deleted' in e && e.deleted !== true && e.deleted !== undefined) {
    return false;
  }
  return true;
}

function readRaw(now: number): DismissedEntry[] {
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
  const out: DismissedEntry[] = [];
  for (const raw of parsed) {
    if (!isEntry(raw)) continue;
    if (raw.at < cutoff) continue;
    const entry: DismissedEntry = { id: raw.id, at: raw.at };
    if (raw.deleted === true) entry.deleted = true;
    out.push(entry);
  }
  return out;
}

function writeRaw(entries: DismissedEntry[]): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // quota or privacy-mode failures are non-fatal
  }
  window.dispatchEvent(new CustomEvent(DISMISSED_STORIES_CHANGE_EVENT));
}

export function getDismissedIds(now: number = Date.now()): Set<number> {
  return new Set(
    readRaw(now)
      .filter((e) => !e.deleted)
      .map((e) => e.id),
  );
}

export function getDismissedEntries(
  now: number = Date.now(),
): Array<{ id: number; at: number }> {
  return readRaw(now)
    .filter((e) => !e.deleted)
    .map((e) => ({ id: e.id, at: e.at }));
}

export function getAllDismissedEntries(
  now: number = Date.now(),
): DismissedEntry[] {
  return readRaw(now).map((e) => ({ ...e }));
}

export function addDismissedId(id: number, now: number = Date.now()): void {
  const entries = readRaw(now).filter((e) => e.id !== id);
  entries.push({ id, at: now });
  writeRaw(entries);
}

export function removeDismissedId(id: number, now: number = Date.now()): void {
  const before = readRaw(now);
  const existing = before.find((e) => e.id === id);
  if (existing && existing.deleted) return;
  const after = before.filter((e) => e.id !== id);
  after.push({ id, at: now, deleted: true });
  writeRaw(after);
}

export function clearDismissedIds(): void {
  writeRaw([]);
}

export function replaceDismissedEntries(entries: DismissedEntry[]): void {
  writeRaw(entries.map((e) => ({ ...e })));
}
