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
  /**
   * Total comment count (`descendants`) at the moment the user opened
   * the comments view. Compared against the feed's current count to
   * derive the "N new" label on story rows.
   */
  seenCommentCount?: number;
}

export interface OpenedEntry {
  id: number;
  at: number;
  articleAt?: number;
  commentsAt?: number;
  seenCommentCount?: number;
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
  const seenCommentCount = isNumber(obj.seenCommentCount)
    ? obj.seenCommentCount
    : undefined;
  // Pre-per-kind legacy entries (shape: {id, at}) had no articleAt,
  // commentsAt, or seenCommentCount. Treat `at` as the timestamp for
  // both halves so users keep their read state. A modern entry written
  // by `markCommentsSeenCount` also has neither timestamp but DOES
  // carry seenCommentCount — leave its timestamps undefined so the
  // row-tap path doesn't masquerade as a full thread visit.
  if (
    articleAt === undefined &&
    commentsAt === undefined &&
    seenCommentCount === undefined
  ) {
    return {
      id: obj.id,
      at: obj.at,
      articleAt: obj.at,
      commentsAt: obj.at,
      seenCommentCount,
    };
  }
  return { id: obj.id, at: obj.at, articleAt, commentsAt, seenCommentCount };
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

function upsert(
  id: number,
  kind: OpenedKind | 'both',
  now: number,
  commentsCount?: number,
): void {
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
  // Snapshot the comment count only when the comments half is being
  // (re-)opened. If the caller didn't supply a count, leave any prior
  // snapshot intact — an article-only open shouldn't erase it.
  const seenCommentCount =
    (kind === 'comments' || kind === 'both') && commentsCount !== undefined
      ? commentsCount
      : existing?.seenCommentCount;
  rest.push({ id, at: now, articleAt, commentsAt, seenCommentCount });
  writeEntries(rest);
}

/**
 * Updates ONLY the seenCommentCount for a story. Unlike
 * `markCommentsOpenedId`, this does NOT move `commentsAt` forward — so
 * a row tap can update the "N new" math without destroying the
 * timestamp the "New comments since last visit" filter relies on.
 *
 * If the story has no entry yet, one is created with `commentsAt`
 * left undefined so row dimming and the new-comments filter both
 * stay dormant until the reader actually lands on the thread page.
 */
export function markCommentsSeenCount(
  id: number,
  commentsCount: number,
  now: number = Date.now(),
): void {
  const entries = readEntries(now);
  const existing = entries.find((e) => e.id === id);
  const rest = entries.filter((e) => e.id !== id);
  rest.push({
    id,
    at: now,
    articleAt: existing?.articleAt,
    commentsAt: existing?.commentsAt,
    seenCommentCount: commentsCount,
  });
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
  commentsCount?: number,
): void {
  upsert(id, 'comments', now, commentsCount);
}

export function addOpenedId(
  id: number,
  now: number = Date.now(),
  commentsCount?: number,
): void {
  upsert(id, 'both', now, commentsCount);
}

export function getSeenCommentCounts(
  now: number = Date.now(),
): Map<number, number> {
  const out = new Map<number, number>();
  for (const e of readEntries(now)) {
    if (e.seenCommentCount !== undefined) {
      out.set(e.id, e.seenCommentCount);
    }
  }
  return out;
}

/**
 * Returns the `commentsAt` timestamp for a story (the instant the
 * thread page last rendered it), or undefined if the reader has
 * never reached the thread page. Used by the "New / All" comment
 * filter on the thread page, which needs the PRE-mount value as its
 * "last visit" reference point.
 */
export function getCommentsAt(
  id: number,
  now: number = Date.now(),
): number | undefined {
  const entry = readEntries(now).find((e) => e.id === id);
  return entry?.commentsAt;
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
