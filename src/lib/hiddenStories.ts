const STORAGE_KEY = 'newshacker:hiddenStoryIds';
const LEGACY_DISMISSED_KEY = 'newshacker:dismissedStoryIds';
export const HIDDEN_STORIES_CHANGE_EVENT =
  'newshacker:hiddenStoriesChanged';
export const HIDDEN_STORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// See src/lib/pinnedStories.ts for the tombstone rationale — same
// shape applies here. Both additive entries and tombstones share the
// 7-day TTL: a hide older than a week no longer matters to the UX
// (the "recently hidden" page doesn't show it), and the sync layer
// doesn't need to resurrect-guard against a live copy older than a
// week either.
export interface HiddenEntry {
  id: number;
  at: number;
  deleted?: true;
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function isEntry(x: unknown): x is HiddenEntry {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  if (typeof e.id !== 'number') return false;
  if (typeof e.at !== 'number') return false;
  if ('deleted' in e && e.deleted !== true && e.deleted !== undefined) {
    return false;
  }
  return true;
}

// One-shot rename of the legacy `dismissedStoryIds` key to `hiddenStoryIds`
// so existing readers don't lose their list when we switch the term from
// "ignore"/"dismissed" to "hide"/"hidden" (matching upstream HN vocabulary).
// Cheap (one localStorage get when there's nothing to migrate) and self-erasing.
function migrateLegacyKey(): void {
  if (!hasWindow()) return;
  try {
    if (window.localStorage.getItem(STORAGE_KEY) !== null) return;
    const legacy = window.localStorage.getItem(LEGACY_DISMISSED_KEY);
    if (legacy === null) return;
    window.localStorage.setItem(STORAGE_KEY, legacy);
    window.localStorage.removeItem(LEGACY_DISMISSED_KEY);
  } catch {
    // ignore storage failures; reads return [] in that case.
  }
}

function readRaw(now: number): HiddenEntry[] {
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
  const cutoff = now - HIDDEN_STORY_TTL_MS;
  const out: HiddenEntry[] = [];
  for (const raw of parsed) {
    if (!isEntry(raw)) continue;
    if (raw.at < cutoff) continue;
    const entry: HiddenEntry = { id: raw.id, at: raw.at };
    if (raw.deleted === true) entry.deleted = true;
    out.push(entry);
  }
  return out;
}

function writeRaw(entries: HiddenEntry[]): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // quota or privacy-mode failures are non-fatal
  }
  window.dispatchEvent(new CustomEvent(HIDDEN_STORIES_CHANGE_EVENT));
}

export function getHiddenIds(now: number = Date.now()): Set<number> {
  return new Set(
    readRaw(now)
      .filter((e) => !e.deleted)
      .map((e) => e.id),
  );
}

export function getHiddenEntries(
  now: number = Date.now(),
): Array<{ id: number; at: number }> {
  return readRaw(now)
    .filter((e) => !e.deleted)
    .map((e) => ({ id: e.id, at: e.at }));
}

export function getAllHiddenEntries(
  now: number = Date.now(),
): HiddenEntry[] {
  return readRaw(now).map((e) => ({ ...e }));
}

export function addHiddenId(id: number, now: number = Date.now()): void {
  const entries = readRaw(now).filter((e) => e.id !== id);
  entries.push({ id, at: now });
  writeRaw(entries);
}

export function removeHiddenId(id: number, now: number = Date.now()): void {
  const before = readRaw(now);
  const existing = before.find((e) => e.id === id);
  if (existing && existing.deleted) return;
  const after = before.filter((e) => e.id !== id);
  after.push({ id, at: now, deleted: true });
  writeRaw(after);
}

export function clearHiddenIds(): void {
  writeRaw([]);
}

export function replaceHiddenEntries(entries: HiddenEntry[]): void {
  writeRaw(entries.map((e) => ({ ...e })));
}
