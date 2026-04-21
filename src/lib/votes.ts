// Local, per-username cache of "items this user has upvoted on this
// device, as far as we know." HN does not expose a feed of the items
// you've voted on via its Firebase API, so this cache is how we keep
// the vote arrow rendering orange after a reload.
//
// Semantics: best-effort. It's written optimistically at click time
// and rolled back if /api/vote rejects. If the user votes from
// another device / the HN web UI, that action never lands here — we
// just show the arrow as un-voted, and tapping it will 502 on the
// scrape step (HN's item page carries no `how=up` link for an
// already-voted item). That's acceptable for the MVP; follow-up
// phases can scrape the vote state during an item fetch if desired.
//
// Storage key is per-username so signing in as a different account
// on the same device doesn't visually lie about what you voted on.

const STORAGE_KEY_PREFIX = 'newshacker:votedStoryIds:';
export const VOTES_CHANGE_EVENT = 'newshacker:votesChanged';

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function storageKey(username: string): string {
  return `${STORAGE_KEY_PREFIX}${username}`;
}

function readRaw(username: string): Set<number> {
  if (!hasWindow() || !username) return new Set();
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(storageKey(username));
  } catch {
    return new Set();
  }
  if (!raw) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();
  const out = new Set<number>();
  for (const v of parsed) {
    if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) {
      out.add(v);
    }
  }
  return out;
}

function writeRaw(username: string, ids: Set<number>): void {
  if (!hasWindow() || !username) return;
  try {
    if (ids.size === 0) {
      window.localStorage.removeItem(storageKey(username));
    } else {
      window.localStorage.setItem(
        storageKey(username),
        JSON.stringify(Array.from(ids).sort((a, b) => a - b)),
      );
    }
  } catch {
    // quota / privacy-mode failures are non-fatal
  }
  window.dispatchEvent(new CustomEvent(VOTES_CHANGE_EVENT));
}

export function getVotedIds(username: string): Set<number> {
  return readRaw(username);
}

export function addVotedId(username: string, id: number): void {
  const current = readRaw(username);
  if (current.has(id)) return;
  current.add(id);
  writeRaw(username, current);
}

export function removeVotedId(username: string, id: number): void {
  const current = readRaw(username);
  if (!current.has(id)) return;
  current.delete(id);
  writeRaw(username, current);
}

export function clearVotedIds(username: string): void {
  writeRaw(username, new Set());
}

// Test-only: expose the internal storage key so tests can assert
// per-user namespacing.
export function _storageKeyForTests(username: string): string {
  return storageKey(username);
}
