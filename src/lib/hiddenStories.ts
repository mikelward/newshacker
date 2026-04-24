import { getPinnedIds, removePinnedId } from './pinnedStories';

const STORAGE_KEY = 'newshacker:hiddenStoryIds';
const LEGACY_DISMISSED_KEY = 'newshacker:dismissedStoryIds';
const PIN_HIDE_MIGRATION_KEY = 'newshacker:pinHideCollisionMigrated';
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

// One-shot migration: resolve legacy pin ∩ hidden pairs in favor of
// hidden. Before we made Pin a shield against Hide (swipe-right and
// the row-menu "Hide" item are now suppressed on pinned rows — see
// StoryListItem), a reader could hide a pinned story and leave both
// stores carrying the same id. Under the new model that pair can't
// be produced, but it can still be *stored* from a previous version.
// Dismiss is the more recent and specific user signal, so we drop
// the pin to honor it. This keeps `/hidden` and `/pinned`
// internally consistent — a story sits in exactly one of them.
//
// Apply the same TTL cutoff `readRaw` uses: an expired hide is a
// ghost that wouldn't affect the UI and shouldn't affect the pin
// either. Without this filter, the migration could drop a pin that
// the reader made months after a stale hide — reads prune
// in-memory but don't rewrite localStorage, so old entries persist.
//
// Self-limiting: the version marker ensures it runs at most once per
// install, and the hidden store's 7-day TTL clears any surviving
// collision on its own after ~a week of uptime. TODO: delete this
// function and its call site in `readRaw` after 2026-05-15. At that
// point every stored hide that predates the shield is either gone
// (expired) or migrated.
function migratePinHideCollisions(now: number): void {
  if (!hasWindow()) return;
  try {
    if (window.localStorage.getItem(PIN_HIDE_MIGRATION_KEY) === 'true') return;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    // No hidden entries at all → nothing to migrate. Mark the
    // marker so we don't re-scan on every subsequent read.
    if (!raw) {
      window.localStorage.setItem(PIN_HIDE_MIGRATION_KEY, 'true');
      return;
    }
    // Unparseable / corrupted payload → leave the marker unset so
    // the next load can retry. Cloud sync's `replaceHiddenEntries`
    // might repair the store between now and then, and we don't
    // want the migration to silently never run against the repaired
    // data.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    const cutoff = now - HIDDEN_STORY_TTL_MS;
    const pinnedIds = getPinnedIds();
    for (const entry of parsed) {
      if (!isEntry(entry)) continue;
      if (entry.deleted === true) continue;
      if (entry.at < cutoff) continue;
      if (pinnedIds.has(entry.id)) removePinnedId(entry.id);
    }
    window.localStorage.setItem(PIN_HIDE_MIGRATION_KEY, 'true');
  } catch {
    // ignore storage failures; we'll retry on next load.
  }
}

function readRaw(now: number): HiddenEntry[] {
  if (!hasWindow()) return [];
  migrateLegacyKey();
  migratePinHideCollisions(now);
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
