const STORAGE_KEY = 'newshacker:openedStoryIds';
export const OPENED_STORIES_CHANGE_EVENT =
  'newshacker:openedStoriesChanged';
export const OPENED_STORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type OpenedKind = 'article' | 'comments';

interface StoredEntry {
  id: number;
  at: number;
  articleAt?: number;
  commentsAt?: number;
}

export interface OpenedEntry {
  id: number;
  at: number;
  articleAt?: number;
  commentsAt?: number;
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseEntry(x: unknown): StoredEntry | null {
  if (typeof x !== 'object' || x === null) return null;
  const obj = x as Record<string, unknown>;
  if (!isNumber(obj.id) || !isNumber(obj.at)) return null;
  const articleAt = isNumber(obj.articleAt) ? obj.articleAt : undefined;
  const commentsAt = isNumber(obj.commentsAt) ? obj.commentsAt : undefined;
  // Legacy entries have neither articleAt nor commentsAt — treat `at` as
  // the timestamp for both halves so users keep their read state.
  if (articleAt === undefined && commentsAt === undefined) {
    return { id: obj.id, at: obj.at, articleAt: obj.at, commentsAt: obj.at };
  }
  return { id: obj.id, at: obj.at, articleAt, commentsAt };
}

function readEntries(now: number): StoredEntry[] {
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
  const entries: StoredEntry[] = [];
  for (const item of parsed) {
    const e = parseEntry(item);
    if (e && e.at >= cutoff) entries.push(e);
  }
  return entries;
}

function writeEntries(entries: StoredEntry[]): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // quota or privacy-mode failures are non-fatal
  }
  window.dispatchEvent(new CustomEvent(OPENED_STORIES_CHANGE_EVENT));
}

function upsert(id: number, kind: OpenedKind | 'both', now: number): void {
  const entries = readEntries(now);
  const existing = entries.find((e) => e.id === id);
  const rest = entries.filter((e) => e.id !== id);
  const articleAt =
    kind === 'article' || kind === 'both'
      ? now
      : existing?.articleAt;
  const commentsAt =
    kind === 'comments' || kind === 'both'
      ? now
      : existing?.commentsAt;
  rest.push({ id, at: now, articleAt, commentsAt });
  writeEntries(rest);
}

export function getOpenedIds(now: number = Date.now()): Set<number> {
  return new Set(readEntries(now).map((e) => e.id));
}

export function getArticleOpenedIds(now: number = Date.now()): Set<number> {
  return new Set(
    readEntries(now)
      .filter((e) => e.articleAt !== undefined)
      .map((e) => e.id),
  );
}

export function getCommentsOpenedIds(now: number = Date.now()): Set<number> {
  return new Set(
    readEntries(now)
      .filter((e) => e.commentsAt !== undefined)
      .map((e) => e.id),
  );
}

export function getOpenedEntries(now: number = Date.now()): OpenedEntry[] {
  return readEntries(now).map((e) => ({ ...e }));
}

export function markArticleOpenedId(
  id: number,
  now: number = Date.now(),
): void {
  upsert(id, 'article', now);
}

export function markCommentsOpenedId(
  id: number,
  now: number = Date.now(),
): void {
  upsert(id, 'comments', now);
}

export function addOpenedId(id: number, now: number = Date.now()): void {
  upsert(id, 'both', now);
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
