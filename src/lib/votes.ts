// Local, per-username cache of "items this user has voted on this
// device, as far as we know." HN does not expose a feed of the items
// you've voted on via its Firebase API, so this cache is how we keep
// the vote arrow rendering orange after a reload.
//
// Two parallel sets per user: upvoted and downvoted. They're disjoint
// (HN models a single direction per item — upvoting an already-downvoted
// item un-downvotes first, and vice versa). The "downvoted" set was
// added when comment voting landed; the "upvoted" set keeps
// its original `votedStoryIds` storage key so existing logged-in
// readers don't lose their orange arrows on first load after the
// upgrade. The "Story" suffix is now a misnomer — the same set
// covers comment ids — but renaming would force a migration for no
// user-visible benefit, so it stays.
//
// Semantics: best-effort. Written optimistically at click time and
// rolled back if /api/vote rejects. If the user votes from another
// device / the HN web UI, that action never lands here — we show
// the arrow as un-voted, and tapping it will 502 on the scrape step
// (HN's item page carries no `how=up` link for an already-voted
// item). That's acceptable; follow-ups can scrape the vote state
// during an item fetch if desired.
//
// Storage keys are per-username so signing in as a different account
// on the same device doesn't visually lie about what you voted on.

const STORAGE_KEY_PREFIX = 'newshacker:votedStoryIds:';
const STORAGE_KEY_PREFIX_DOWN = 'newshacker:downvotedItemIds:';
export const VOTES_CHANGE_EVENT = 'newshacker:votesChanged';

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function storageKey(prefix: string, username: string): string {
  return `${prefix}${username}`;
}

function readRaw(prefix: string, username: string): Set<number> {
  if (!hasWindow() || !username) return new Set();
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(storageKey(prefix, username));
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

function writeRaw(prefix: string, username: string, ids: Set<number>): void {
  if (!hasWindow() || !username) return;
  try {
    if (ids.size === 0) {
      window.localStorage.removeItem(storageKey(prefix, username));
    } else {
      window.localStorage.setItem(
        storageKey(prefix, username),
        JSON.stringify(Array.from(ids).sort((a, b) => a - b)),
      );
    }
  } catch {
    // quota / privacy-mode failures are non-fatal
  }
  window.dispatchEvent(new CustomEvent(VOTES_CHANGE_EVENT));
}

export function getVotedIds(username: string): Set<number> {
  return readRaw(STORAGE_KEY_PREFIX, username);
}

export function addVotedId(username: string, id: number): void {
  const current = readRaw(STORAGE_KEY_PREFIX, username);
  if (current.has(id)) return;
  current.add(id);
  writeRaw(STORAGE_KEY_PREFIX, username, current);
}

export function removeVotedId(username: string, id: number): void {
  const current = readRaw(STORAGE_KEY_PREFIX, username);
  if (!current.has(id)) return;
  current.delete(id);
  writeRaw(STORAGE_KEY_PREFIX, username, current);
}

export function clearVotedIds(username: string): void {
  writeRaw(STORAGE_KEY_PREFIX, username, new Set());
  writeRaw(STORAGE_KEY_PREFIX_DOWN, username, new Set());
}

export function getDownvotedIds(username: string): Set<number> {
  return readRaw(STORAGE_KEY_PREFIX_DOWN, username);
}

export function addDownvotedId(username: string, id: number): void {
  const current = readRaw(STORAGE_KEY_PREFIX_DOWN, username);
  if (current.has(id)) return;
  current.add(id);
  writeRaw(STORAGE_KEY_PREFIX_DOWN, username, current);
}

export function removeDownvotedId(username: string, id: number): void {
  const current = readRaw(STORAGE_KEY_PREFIX_DOWN, username);
  if (!current.has(id)) return;
  current.delete(id);
  writeRaw(STORAGE_KEY_PREFIX_DOWN, username, current);
}

// Test-only: expose the internal storage keys so tests can assert
// per-user namespacing for both directions.
export function _storageKeyForTests(username: string): string {
  return storageKey(STORAGE_KEY_PREFIX, username);
}

export function _downvoteStorageKeyForTests(username: string): string {
  return storageKey(STORAGE_KEY_PREFIX_DOWN, username);
}
